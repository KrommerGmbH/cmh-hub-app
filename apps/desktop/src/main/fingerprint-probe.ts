// U07 8-13b — 지문 비교 하네스. CMH_HUB_FP_URL 로 띄우면 «네이버 탭과 똑같은 view»(같은 partition · 같은 webPreferences · 같은 UA)를
// 하나 만들어 그 URL 을 연다. 페이지가 값을 로컬 서버로 보내면 scripts/fingerprint-diff.mjs 가 앱을 끈다.
// 네이버 페이지에는 아무것도 하지 않는다 — 여는 것은 우리 로컬 지문 페이지(127.0.0.1)뿐이다.
import { app } from 'electron';
import { createAdminView } from './admin-view.js';
import type { ShellWindow } from './window/shell-window.js';

/** 개발판 + 우리 로컬 지문 서버(http://127.0.0.1 · localhost)만 — 이 view 는 URL 정책(A02)을 거치지 않으므로 배포판에서는 막는다 */
export function isAllowedProbeUrl(url: string, packaged: boolean): boolean {
  if (packaged) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function runFingerprintProbeIfRequested(w: ShellWindow): void {
  const url = process.env['CMH_HUB_FP_URL'];
  if (!url) return;
  if (!isAllowedProbeUrl(url, app.isPackaged)) {
    console.warn('[fingerprint] 배포판이거나 로컬 주소가 아니라 열지 않습니다');
    return;
  }
  const noop = (): void => undefined;
  const view = createAdminView(
    { id: 'fingerprint-probe', kind: 'naver', url, title: 'fingerprint', favicon: null, loading: false },
    { onTitle: noop, onFavicon: noop, onLoading: noop, onUrl: noop, onFocus: noop },
  );
  w.window.contentView.addChildView(view); // 맨 위 — 실제 네이버 pane 처럼 화면에 보여야 WebGL · 화면 값이 같다
  const b = w.window.getContentBounds();
  view.setBounds({ x: 0, y: 40, width: b.width, height: Math.max(200, b.height - 40) });
  console.info(`[fingerprint] naver-like view → ${url}`);
}
