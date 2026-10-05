// A02 — 탭 하나 = WebContentsView 하나(서버 · 네이버 페이지 · preload 0 · sandbox)
import { shell, WebContentsView } from 'electron';
import type { TabRecord } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';
import { attachContextMenu } from './context-menu.js';
import { isAllowedUrl } from './url-policy.js';

export interface TabViewEvents {
  onTitle(tabId: string, title: string): void;
  onFavicon(tabId: string, favicon: string | null): void;
  onLoading(tabId: string, loading: boolean): void;
  onUrl(tabId: string, url: string): void;
  onFocus(tabId: string): void;
}

function openOutside(url: string): void {
  if (url.startsWith('https:')) void shell.openExternal(url);
}

export function createAdminView(tab: TabRecord, events: TabViewEvents): WebContentsView {
  const partition = tab.kind === 'naver' ? APP_CONFIG.naverPartition : APP_CONFIG.adminPartition;
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
    if (isAllowedUrl(tab.kind, url)) void wc.loadURL(url);
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

  attachContextMenu(wc, tab.kind); // 오른쪽 클릭 메뉴(2026-10-04) · 로그인 칸 위면 저장된 계정(U08 · 2026-10-05)
  void wc.loadURL(tab.url);
  return view;
}
