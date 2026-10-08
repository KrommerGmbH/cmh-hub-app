// R6-a — 챗 pane 호스트(Electron 어댑터). TabKind 'chat' 탭의 WebContentsView 는 여기서만 만든다(admin-view.ts createAdminView 는 chat 을 거절한다).
// 규칙은 chat-policy.ts(electron 없이 시험) · 파일 읽기는 plugin/plugin-ui-policy.ts openAsset 을 그대로 쓴다(이 파일은 plugin/** 를 고치지 않는다).
// 꼴은 plugin/plugin-view-host.ts 와 같다: 따로 된 session(persist:chat) · sandbox · contextIsolation · nodeIntegration 없음 · CJS preload
//   (chat-preload.cts · `window.cmhChat.ping()` 하나 · 에이전트 IPC 는 R6-b) · 응답마다 CSP · nosniff · 이동은 app://chat 안만 ·
//   새 창 거부 · WebRTC UDP 끔 + 막힌 프록시(TURN/TCP) · 권한 요청 · 내려받기 거부.
// chat-app dist(apps/desktop/dist/chat-app/ · scripts/fetch-chat-app.mjs 가 복사)가 없으면 index.html 자리에 안내 화면(스니펫 글자)을 낸다.
// ⚠ main.ts 가 app ready 전에 CHAT_SCHEME_PRIVILEGES 를 PLUGIN_UI_SCHEME_PRIVILEGES 와 «한 배열로» registerSchemesAsPrivileged 에 넣어야 한다.
// ⚠ 배포판(asar) 안 dist/chat-app 을 openAsset(realpath · O_NOFOLLOW · nlink)으로 읽는지는 안 재 봤다 — 개발판(폴더)만 실측(R6-a 보고).

import { app, ipcMain, session, WebContentsView, type IpcMainInvokeEvent, type Session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TabRecord } from '@cmh-hub-app/contracts';
import type { TabViewEvents } from '../admin-view.js';
import { loadSnippets } from '../i18n/snippet.js';
import { openAsset } from '../plugin/plugin-ui-policy.js';
import {
  CHAT_ENTRY_URL,
  CHAT_PARTITION,
  CHAT_PROXY_CONFIG,
  CHAT_SCHEME,
  CHAT_SNIPPET_KEYS,
  CHAT_WEBRTC_POLICY,
  chatAssetPathFromUrl,
  chatFallbackCsp,
  chatResponseHeaders,
  isAllowedChatNavigation,
  isAllowedChatRequest,
  isChatUrl,
  renderChatFallbackHtml,
} from './chat-policy.js';

/** chat-preload.cts 의 채널과 같은 글자(chat-policy.test.ts 가 두 글자가 같은지 본다) */
export const CHAT_PING_CHANNEL = 'cmh-chat:ping';
/** preload 가 여는 API 판(R6-b 가 에이전트 IPC 를 더하면 올린다) */
export const CHAT_BRIDGE_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url)); // dist/main/chat
const DIST = join(here, '..', '..');

export interface ChatPaneHostOptions {
  /** chat-app 빌드 산출 폴더(기본 dist/chat-app) */
  readonly distDir?: string;
  /** dist/preload/chat-preload.cjs 절대경로(기본) */
  readonly preloadPath?: string;
  /** 개발판만 true(app.isPackaged 가 false 일 때) */
  readonly devTools?: boolean;
}

export class ChatPaneHost {
  readonly distDir: string;
  private readonly preloadPath: string;
  private readonly devTools: boolean;
  private readonly ses: Session;
  /** 이 호스트가 만든 view 의 webContents id — ping IPC 를 이 view 에서 온 것만 받는다 */
  private readonly viewIds = new Set<number>();
  private disposed = false;

  private constructor(options: ChatPaneHostOptions) {
    this.distDir = options.distDir ?? join(DIST, 'chat-app');
    this.preloadPath = options.preloadPath ?? join(DIST, 'preload', 'chat-preload.cjs');
    this.devTools = options.devTools === true;
    this.ses = session.fromPartition(CHAT_PARTITION);
  }

  /** app ready 뒤 한 번 — session 준비(프로토콜 · 요청 거름 · 프록시)까지 끝낸 호스트 */
  static async create(options: ChatPaneHostOptions = {}): Promise<ChatPaneHost> {
    const host = new ChatPaneHost(options);
    await host.prepareSession();
    ipcMain.handle(CHAT_PING_CHANNEL, (event) => host.ping(event));
    return host;
  }

  /** ViewManager 가 kind 'chat' 탭마다 부른다. 주소는 tab.url 이 아니라 늘 CHAT_ENTRY_URL(셸이 준 주소를 믿지 않는다) */
  createView(tab: TabRecord, events: TabViewEvents): WebContentsView {
    if (this.disposed) throw new Error('chat pane host is disposed');
    const view = new WebContentsView({
      webPreferences: {
        partition: CHAT_PARTITION,
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: this.devTools,
      },
    });
    const wc = view.webContents;
    // STUN · TURN/UDP 를 끈다(UDP 는 프록시를 못 지나므로 0) · TURN/TCP 는 session 프록시(CHAT_PROXY_CONFIG)가 막는다
    wc.setWebRTCIPHandlingPolicy(CHAT_WEBRTC_POLICY);
    const id = wc.id;
    this.viewIds.add(id);
    wc.once('destroyed', () => this.viewIds.delete(id));

    // 이동 잠금 — app://chat 밖으로는 맨 위 · 하위 프레임 모두 못 간다(바깥 링크도 열지 않는다 · 【AI 임시 결정】 openExternal 없음)
    wc.on('will-navigate', (event, next) => {
      if (!isAllowedChatNavigation(next)) event.preventDefault();
    });
    wc.on('will-frame-navigate', (details) => {
      if (!isAllowedChatNavigation(details.url)) details.preventDefault();
    });
    wc.on('will-redirect', (event) => {
      if (!isAllowedChatNavigation(event.url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('certificate-error', (event, _url, _error, _cert, callback) => {
      event.preventDefault();
      callback(false);
    });
    wc.on('render-process-gone', (_event, details) => console.error('[chat] renderer gone', details.reason));
    // 탭 줄 글자 · 회전 표시(admin-view.ts 와 같은 이벤트 · 주소는 늘 같아 onUrl 은 안 보낸다)
    wc.on('page-title-updated', (_e, title) => events.onTitle(tab.id, title));
    wc.on('did-start-loading', () => events.onLoading(tab.id, true));
    wc.on('did-stop-loading', () => events.onLoading(tab.id, false));
    wc.on('focus', () => events.onFocus(tab.id));

    wc.loadURL(CHAT_ENTRY_URL).catch((error: unknown) => console.error('[chat] load failed', error instanceof Error ? error.message : String(error)));
    return view;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ipcMain.removeHandler(CHAT_PING_CHANNEL);
    this.viewIds.clear();
  }

  /** preload `cmhChat.ping()` — 이 호스트가 만든 view 의 맨 위 프레임이 app://chat 일 때만 답한다 */
  private ping(event: IpcMainInvokeEvent): { ok: true; version: string; bridge: number } | { ok: false; error: { code: 'forbidden'; message: string } } {
    const frame = event.senderFrame;
    const fromChat = this.viewIds.has(event.sender.id) && frame !== null && frame.parent === null && isChatUrl(frame.url);
    if (!fromChat) return { ok: false, error: { code: 'forbidden', message: 'not a chat pane' } };
    return { ok: true, version: app.getVersion(), bridge: CHAT_BRIDGE_VERSION };
  }

  /** partition 하나 · 한 번 — 파일 응답 · 네트워크 거름 · 막힌 프록시 · 권한 · 내려받기 거부 */
  private async prepareSession(): Promise<void> {
    const ses = this.ses;
    ses.protocol.handle(CHAT_SCHEME, (request) => this.serve(request));
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedChatRequest(details.url) }));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    await ses.setProxy({ ...CHAT_PROXY_CONFIG });
  }

  private async serve(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const rel = chatAssetPathFromUrl(request.url);
    if (rel === null) return new Response(null, { status: 400 });
    // 연 핸들로 검사하고 그 핸들로 읽는다(plugin-ui-policy.ts openAsset — `..` · 링크 · 하드 링크 · 10 MB 상한)
    const asset = await openAsset(this.distDir, rel);
    if (!asset.ok) {
      if (rel === 'index.html' && asset.status === 404) return this.fallback(request.method);
      return new Response(null, { status: asset.status });
    }
    try {
      const headers = chatResponseHeaders(asset.mimeType);
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      const body = new Uint8Array(asset.size);
      const { bytesRead } = await asset.handle.read(body, 0, asset.size, 0);
      return new Response(body.subarray(0, bytesRead), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      await asset.handle.close().catch(() => undefined);
    }
  }

  /** chat-app dist 가 없을 때의 안내 화면(스니펫 R8 · 스크립트 0) */
  private fallback(method: string): Response {
    const headers = chatResponseHeaders('text/html; charset=utf-8', chatFallbackCsp());
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    let html: string;
    try {
      const snippets = loadSnippets(app.getLocale());
      html = renderChatFallbackHtml({
        lang: snippets.locale,
        title: snippets.t(CHAT_SNIPPET_KEYS.fallbackTitle),
        body: snippets.t(CHAT_SNIPPET_KEYS.fallbackBody),
        env: snippets.t(CHAT_SNIPPET_KEYS.fallbackEnv, { env: 'CMH_CHAT_APP_DIST' }),
      });
    } catch (error) {
      // 스니펫 파일을 못 읽으면(깨진 빌드) 키 글자 그대로 — 빈 화면보다 낫다
      console.error('[chat] fallback snippets failed', error instanceof Error ? error.message : String(error));
      html = renderChatFallbackHtml({ lang: 'en', title: CHAT_SNIPPET_KEYS.fallbackTitle, body: CHAT_SNIPPET_KEYS.fallbackBody, env: 'CMH_CHAT_APP_DIST' });
    }
    return new Response(html, { status: 200, headers });
  }
}
