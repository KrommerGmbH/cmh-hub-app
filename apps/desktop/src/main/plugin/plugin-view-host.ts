// R2-b — 플러그인 화면 호스트(Electron 어댑터). 규칙은 plugin-ui-policy.ts · 검사는 plugin-ui-bridge.ts(둘 다 electron 없이 시험한다).
// 합의안 5 «App 꼴»: 플러그인 화면 하나 = 따로 된 WebContentsView 하나 · 플러그인마다 따로 된 session(partition) · sandbox · contextIsolation ·
//   nodeIntegration 없음 · preload 는 `window.cmhPlugin.call` 하나(plugin-ui-preload.cts) · 응답마다 CSP · 자기 폴더 파일만(cmh-plugin://<이름>/…).
// 이 클래스는 view 를 만들어 돌려줄 뿐 창에 붙이지 않는다 — 어디(사이드바 · pane)에 둘지는 셸(ShellWindow · R6/RD) 몫.
// ⚠ main.ts 가 app ready 전에 PLUGIN_UI_SCHEME_PRIVILEGES 를 protocol.registerSchemesAsPrivileged 에 넣어야 한다(안 넣으면 표준 scheme 이 아니라
//   상대경로 · origin 이 흐려진다). 이 파일은 그것을 대신 부르지 않는다(그 함수는 한 번만 부를 수 있다 — 다른 scheme 과 한 배열로 main.ts 에서).
// WebRTC(검수 8 🟡1) — STUN/TURN 은 CSP · webRequest 를 둘 다 지나지 않는다. 화면마다 setWebRTCIPHandlingPolicy('disable_non_proxied_udp') +
//   partition 에 막힌 프록시(plugin-ui-policy.ts pluginUiProxyConfig · 선언한 호스트의 443 만 bypass). 실측(2026-10-08 · Electron 44.5.1 · xvfb ·
//   STUN UDP · TURN UDP · TURN TCP 를 127.0.0.2 와 192.0.2.2 에 동시에): 받은 UDP 0 · TCP 연결 0 · 선언한 https fetch 200.
//   대조(같은 화면에서 프록시만 direct 로): TURN/TCP 연결 2 · 데이터 10통 — 프록시가 TCP 를 막는 것이다. 선언한 호스트 3479 포트 TURN/TCP 도 0.
//   ⚠ 선언한 호스트의 443 포트로 가는 TURN/TCP 는 안 재 봤다(bypass 라 나갈 수 있다 · 선언한 호스트라 https 와 같은 대접).

import { ipcMain, session, WebContentsView, type IpcMainInvokeEvent, type Session } from 'electron';
import { realpath } from 'node:fs/promises';
import type { HostApiOptions } from './plugin-host-api.js';
import type { PluginManifest } from './plugin-manifest.js';
import { inspectPluginFolder } from './plugin-process.js';
import { PLUGIN_UI_IPC_CHANNEL, PluginUiBridge, type PluginUiRejection, type PluginUiSender } from './plugin-ui-bridge.js';
import {
  PLUGIN_UI_SCHEME,
  assetPathFromUrl,
  isAllowedPluginNavigation,
  isAllowedPluginRequest,
  openAsset,
  pluginUiPartition,
  pluginUiProxyConfig,
  pluginUiResponseHeaders,
  pluginUiUrl,
  resolveAssetPath,
} from './plugin-ui-policy.js';

/** 화면마다 거는 WebRTC 정책 — 프록시를 안 지나는 UDP 를 끈다(검수 8 🟡1) */
export const PLUGIN_UI_WEBRTC_POLICY = 'disable_non_proxied_udp';

/** 화면을 열 플러그인(registry.describe 를 감싼 것) — active 가 아니면 resolvePlugin 이 null 을 돌려줄 것 */
export interface PluginUiTarget {
  readonly manifest: PluginManifest;
  readonly pluginDir: string;
}

export interface PluginViewHostOptions extends Omit<HostApiOptions, 'manifest'> {
  /** dist/preload/plugin-ui-preload.cjs 절대경로 */
  readonly preloadPath: string;
  readonly resolvePlugin: (pluginName: string) => PluginUiTarget | null;
  /** 개발판만 true 권장(app.isPackaged 가 false 일 때) */
  readonly devTools?: boolean;
  readonly onRejected?: (info: PluginUiRejection) => void;
}

function senderOf(event: IpcMainInvokeEvent): PluginUiSender {
  const frame = event.senderFrame;
  return { webContentsId: event.sender.id, frameUrl: frame?.url ?? null, isMainFrame: frame !== null && frame.parent === null };
}

export class PluginViewHost {
  private readonly bridge: PluginUiBridge;
  private readonly preparedSessions = new Set<string>();
  private readonly views = new Map<number, WebContentsView>();
  private disposed = false;

  constructor(private readonly options: PluginViewHostOptions) {
    const { preloadPath: _preloadPath, resolvePlugin: _resolvePlugin, devTools: _devTools, ...bridgeOptions } = options;
    this.bridge = new PluginUiBridge(bridgeOptions);
    // 채널 하나 · 처리기 하나. 셸 · 탭이 이 채널을 불러도 bridge 가 보낸 id 로 거부한다
    ipcMain.handle(PLUGIN_UI_IPC_CHANNEL, (event, raw: unknown) => this.bridge.handle(senderOf(event), raw));
  }

  /**
   * 플러그인 화면 하나를 만든다(onView:<id> 활성화는 부르는 쪽이 registry.fire 로 — 화면만 있고 프로세스가 없는 플러그인도 있다).
   * 거부(예외): 플러그인이 active 아님 · ui 없음 · 그 뷰 선언 없음 · 폴더에 심볼릭 링크 · ui 파일 없음.
   */
  async open(pluginName: string, viewId: string): Promise<WebContentsView> {
    if (this.disposed) throw new Error('plugin view host is disposed');
    const target = this.options.resolvePlugin(pluginName);
    if (!target) throw new Error(`plugin "${pluginName}" is not active`);
    const url = pluginUiUrl(target.manifest, viewId);
    if (url === null) throw new Error(`plugin "${pluginName}" has no ui for view "${viewId}"`);
    const folder = await inspectPluginFolder(await realpath(target.pluginDir));
    if (folder.error) throw new Error(`plugin "${pluginName}": ${folder.error}`);
    const entry = await resolveAssetPath(target.pluginDir, target.manifest.ui ?? '');
    if (!entry.ok) throw new Error(`plugin "${pluginName}" ui: ${entry.reason}`);

    const partition = pluginUiPartition(pluginName);
    const ses = session.fromPartition(partition);
    this.prepareSession(pluginName, ses);
    // 열 때마다 그때 매니페스트의 host: 로(update 로 바뀌었을 수 있다) — WebRTC TURN/TCP 를 막힌 프록시로 보낸다
    await ses.setProxy(pluginUiProxyConfig(target.manifest.permissions));
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: this.options.preloadPath,
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
        devTools: this.options.devTools === true,
      },
    });
    const wc = view.webContents;
    // STUN · TURN/UDP 를 끈다(UDP 는 프록시를 못 지나므로 0) · TURN/TCP 는 위 setProxy 가 막는다
    wc.setWebRTCIPHandlingPolicy(PLUGIN_UI_WEBRTC_POLICY);
    const id = wc.id;
    this.bridge.attach(id, target.manifest);
    this.views.set(id, view);
    wc.once('destroyed', () => {
      this.bridge.detach(id);
      this.views.delete(id);
    });

    // 이동 잠금 — 자기 화면 주소 밖으로는 맨 위 프레임 · 하위 프레임 모두 못 간다(바깥 링크도 열지 않는다 · 【AI 임시 결정】 openExternal 없음)
    wc.on('will-navigate', (event, next) => {
      if (!isAllowedPluginNavigation(pluginName, next)) event.preventDefault();
    });
    wc.on('will-frame-navigate', (details) => {
      if (!isAllowedPluginNavigation(pluginName, details.url)) details.preventDefault();
    });
    wc.on('will-redirect', (event) => {
      if (!isAllowedPluginNavigation(pluginName, event.url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('certificate-error', (event, _url, _error, _cert, callback) => {
      event.preventDefault();
      callback(false);
    });
    wc.on('render-process-gone', (_event, details) => this.options.onLog?.(pluginName, 'error', `plugin view renderer gone: ${details.reason}`));

    wc.loadURL(url).catch((error: unknown) => this.options.onLog?.(pluginName, 'error', `plugin view load failed: ${error instanceof Error ? error.message : String(error)}`));
    return view;
  }

  /** 그 플러그인의 화면을 전부 닫는다(비활성 · 삭제 · update 때). 닫은 수 */
  closeViews(pluginName: string): number {
    const ids = this.bridge.viewsOf(pluginName);
    for (const id of ids) {
      this.bridge.detach(id); // destroyed 를 기다리지 않고 바로 권한을 뗀다
      const view = this.views.get(id);
      this.views.delete(id);
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    return ids.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ipcMain.removeHandler(PLUGIN_UI_IPC_CHANNEL);
    for (const [id, view] of this.views) {
      this.bridge.detach(id);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.views.clear();
  }

  /** partition 마다 한 번 — 파일 응답 · 네트워크 거름 · 권한 요청 거부 · 내려받기 거부 */
  private prepareSession(pluginName: string, ses: Session): void {
    if (this.preparedSessions.has(pluginName)) return;
    this.preparedSessions.add(pluginName);
    ses.protocol.handle(PLUGIN_UI_SCHEME, (request) => this.serve(pluginName, request));
    ses.webRequest.onBeforeRequest((details, callback) => {
      // 그때의 매니페스트로 본다(update 로 host: 가 바뀌었을 수 있다) · 플러그인이 내려갔으면 전부 막는다
      const target = this.options.resolvePlugin(pluginName);
      callback({ cancel: !target || !isAllowedPluginRequest(pluginName, target.manifest.permissions, details.url) });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  }

  private async serve(pluginName: string, request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const target = this.options.resolvePlugin(pluginName);
    if (!target) return new Response(null, { status: 404 });
    const rel = assetPathFromUrl(pluginName, request.url);
    if (rel === null) return new Response(null, { status: 400 });
    // 연 핸들로 검사하고 그 핸들로 읽는다(stat ↔ 읽기 사이 TOCTOU · 하드 링크 거부 — plugin-ui-policy.ts openAsset)
    const asset = await openAsset(target.pluginDir, rel);
    if (!asset.ok) return new Response(null, { status: asset.status });
    try {
      const headers = pluginUiResponseHeaders(target.manifest, asset.mimeType);
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      // stat 의 크기만큼만 읽는다(연 뒤에 파일이 커져도 상한 PLUGIN_UI_MAX_FILE_BYTES 를 넘기지 않게)
      const body = new Uint8Array(asset.size);
      const { bytesRead } = await asset.handle.read(body, 0, asset.size, 0);
      return new Response(body.subarray(0, bytesRead), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      await asset.handle.close().catch(() => undefined);
    }
  }
}
