// A02 — 탭 하나 = WebContentsView 하나(서버 · 네이버 페이지 · preload 0 · sandbox)
import { shell, WebContentsView } from 'electron';
import type { TabRecord } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';
import { attachContextMenu } from './context-menu.js';
import { watchLoginSubmit } from './credentials/credential-autosave.js';
import { watchLoginFieldFocus } from './credentials/credential-focus-watch.js';
import { isAllowedUrl } from './url-policy.js';

export interface TabViewEvents {
  onTitle(tabId: string, title: string): void;
  onFavicon(tabId: string, favicon: string | null): void;
  onLoading(tabId: string, loading: boolean): void;
  onUrl(tabId: string, url: string): void;
  onFocus(tabId: string): void;
  /** 오른쪽 클릭 «검사» — 개발자 도구를 pane 오른쪽에(2026-10-05) */
  onInspect(tabId: string, x: number, y: number): void;
  onCloseInspector(tabId: string): void;
  isInspecting(tabId: string): boolean;
  /** 빈 탭에서 «새 창으로» 링크(target=_blank · window.open) — 같은 pane 에 새 빈 탭으로(크롬의 새 탭) */
  onOpenWebTab(tabId: string, url: string): void;
}

function openOutside(url: string): void {
  if (url.startsWith('https:')) void shell.openExternal(url);
}

export function createAdminView(tab: TabRecord, events: TabViewEvents): WebContentsView {
  const partition = tab.kind === 'naver' ? APP_CONFIG.naverPartition : tab.kind === 'web' ? APP_CONFIG.webPartition : APP_CONFIG.adminPartition;
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // preload 없음 — 서버 페이지에 IPC 를 하나도 열지 않는다(A02)
    },
  });
  const wc = view.webContents;

  wc.on('will-navigate', (event, url) => {
    if (isAllowedUrl(tab.kind, url)) return;
    event.preventDefault();
    openOutside(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (tab.kind === 'web' && isAllowedUrl('web', url)) events.onOpenWebTab(tab.id, url);
    else if (isAllowedUrl(tab.kind, url)) void wc.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });
  // 인증서 오류는 절대 통과시키지 않는다(기본값도 거부지만 명시한다)
  wc.on('certificate-error', (event, _url, _error, _cert, callback) => {
    event.preventDefault();
    callback(false);
  });

  wc.on('page-title-updated', (_e, title) => events.onTitle(tab.id, title));
  wc.on('page-favicon-updated', (_e, favicons) => events.onFavicon(tab.id, favicons[0] ?? null));
  wc.on('did-start-loading', () => events.onLoading(tab.id, true));
  wc.on('did-stop-loading', () => events.onLoading(tab.id, false));
  wc.on('did-navigate', (_e, url) => events.onUrl(tab.id, url));
  wc.on('did-navigate-in-page', (_e, url) => events.onUrl(tab.id, url));
  wc.on('focus', () => events.onFocus(tab.id));

  attachContextMenu(wc, tab.kind, { inspect: (x, y) => events.onInspect(tab.id, x, y), isOpen: () => events.isInspecting(tab.id), close: () => events.onCloseInspector(tab.id) }); // 오른쪽 클릭 메뉴(2026-10-04) · 로그인 칸 위면 저장된 계정(U08 · 2026-10-05)
  watchLoginFieldFocus(wc, tab.kind, () => view.getBounds()); // 로그인 칸 왼쪽 클릭 → 계정 목록(U08b · 2026-10-05)
  watchLoginSubmit(wc, tab.kind); // 로그인 성공(로그인 화면을 벗어남) → 계정 자동 저장(U08c · 2026-10-05)
  void wc.loadURL(tab.url);
  return view;
}
