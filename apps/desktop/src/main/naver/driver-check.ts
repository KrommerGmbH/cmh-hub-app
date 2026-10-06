// U07a 실측 하네스 — CMH_HUB_DRIVER_CHECK=1 (개발판만)
// - 어드민 탭에서 읽기 전용 드라이버를 실측한다.
// - 네이버 탭은 쓰지 않는다 (사장님 계정 실험은 사장님 확인 뒤 — 계획서 9번).
// - 저장 0 · 링크 이동과 스크롤 · 읽기만 검증하고 창은 그대로 둔다.
import { app } from 'electron';
import { APP_CONFIG } from '../../config.js';
import type { ShellWindow } from '../window/shell-window.js';
import { NaverPaneDriver, type DriverStep } from './naver-pane-driver.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runDriverCheckIfRequested(w: ShellWindow): void {
  if (!process.env['CMH_HUB_DRIVER_CHECK'] || app.isPackaged) return;

  void (async () => {
    try {
      // 어드민 로그인 화면 또는 대시보드가 뜰 때까지 8초 대기
      await sleep(8000);

      const active = w.activeTabOfFocusedPane();
      if (!active?.activeTabId) {
        console.warn('[driver-check] 포커스 pane 의 활성 탭을 찾을 수 없습니다');
        return;
      }

      // 네이버 탭은 쓰지 않는다
      const tab = w.engine.getTab(active.activeTabId);
      if (tab?.kind === 'naver') {
        console.warn('[driver-check] 네이버 탭에서는 실행하지 않습니다 (계획서 9번)');
        return;
      }

      const view = w.views.get(active.activeTabId);
      if (!view || view.webContents.isDestroyed()) {
        console.warn('[driver-check] 활성 탭 view 를 찾을 수 없습니다');
        return;
      }

      const wc = view.webContents;
      const allowedOrigins = [new URL(APP_CONFIG.serverOrigin).origin];
      const driver = new NaverPaneDriver(wc, { allowedOrigins });

      const urlBefore = wc.getURL();
      const isLogin = urlBefore.includes('#/login');
      const mode: 'admin' | 'storefront' = isLogin ? 'storefront' : 'admin';
      const clickSelector = mode === 'storefront' ? 'a.header-logo-main-link' : 'a[href^="#/"]';

      const steps: DriverStep[] =
        mode === 'storefront'
          ? [
              { op: 'goto', url: `${APP_CONFIG.serverOrigin}/` },
              { op: 'read', selector: 'title' },
              { op: 'scroll', deltaY: 600 },
              { op: 'scroll', deltaY: -600 },
              // 2026-10-06 실측 — 스크롤 직후 재면 not-visible 이었다(까닭 재는 중)
              { op: 'wait', ms: 1200 },
              // 메뉴는 navbar-expand-lg 라 pane 이 992px 보다 좁으면 접혀 not-visible 이었다(2026-10-06 실측) · 로고 링크는 늘 보인다(메인이 그 페이지 HTML 에서 확인 · href="/" · 한 개).
              { op: 'click', selector: clickSelector },
              { op: 'wait', ms: 1500 },
              { op: 'read', selector: 'title' },
            ]
          : [
              { op: 'read', selector: 'title' },
              { op: 'scroll', deltaY: 360 },
              { op: 'scroll', deltaY: -360 },
              { op: 'wait', ms: 500 },
              { op: 'click', selector: clickSelector },
              { op: 'wait', ms: 1500 },
              { op: 'read', selector: 'title' },
            ];

      const result = await driver.run(steps);
      let diag: unknown = undefined;
      const lastStep = result.steps[result.steps.length - 1];
      if (!result.ok && lastStep?.error === 'not-visible' && !wc.isDestroyed()) {
        const diagScript = `(() => {
          try {
            const e = document.querySelector(${JSON.stringify(clickSelector)});
            const r = e ? e.getBoundingClientRect() : null;
            return {
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              scrollY: window.scrollY,
              devicePixelRatio: window.devicePixelRatio,
              visibility: document.visibilityState,
              rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
              display: e ? getComputedStyle(e).display : null,
              count: document.querySelectorAll(${JSON.stringify(clickSelector)}).length,
            };
          } catch {
            return null;
          }
        })()`;
        diag = await wc.executeJavaScriptInIsolatedWorld(1211, [{ code: diagScript }]);
      }
      const urlAfter = wc.getURL();

      console.info(
        '[driver-check]',
        JSON.stringify({ mode, ...result, ...(diag !== undefined ? { diag } : {}), urlBefore, urlAfter }),
      );
    } catch (error) {
      console.error('[driver-check] 실패', error);
    }
  })();
}
