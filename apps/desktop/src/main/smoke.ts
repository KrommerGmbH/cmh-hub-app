// 검증 하네스 — CMH_HUB_SMOKE=1 로 띄우면 셸 단추를 «실제로 눌러» split · 새 탭 · sash · 닫기 · 단축키를 돌리고 결과를 찍는다.
// 셸 페이지(우리 로컬 HTML)에만 executeJavaScript 를 쓴다 — 서버 · 네이버 페이지에는 쓰지 않는다(U07 8-5).
import { app } from 'electron';
import type { ShellWindow } from './window/shell-window.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSmokeIfRequested(w: ShellWindow): Promise<void> {
  if (!process.env['CMH_HUB_SMOKE'] || app.isPackaged) return; // 배포판에서는 환경값으로 셸을 움직이지 못하게
  const shellJs = <T>(code: string): Promise<T> => w.shellView.webContents.executeJavaScript(code) as Promise<T>;
  const snapshot = (): string =>
    `pane ${w.engine.paneCount()} · tabs ${Object.keys(w.engine.getTree().tabs).length} · focused ${w.focusedPaneId()?.slice(0, 8)}`;
  const log = (step: string, extra = ''): void => console.info(`[smoke] ${step.padEnd(28)} ${snapshot()} ${extra}`);

  await wait(3000);
  log('start(복원된 레이아웃)');
  // 기본 창 크기 = 모니터 100%(최대화) — 1440×900 으로 뜨면 FAIL
  const b = w.window.getBounds();
  log('maximized on start', `${w.window.isMaximized() ? 'OK' : 'FAIL'} ${b.width}x${b.height}`);

  // ⓪ 바탕 맞추기 — U05 가 복원한 레이아웃을 pane 1 · 탭 1 로(기대값이 절대 수라서)
  for (const pane of w.engine.listPanes().slice(1)) w.handleCommand({ cmd: 'closePane', paneId: pane.id });
  const firstPane = w.engine.listPanes()[0];
  if (firstPane) for (const tabId of firstPane.tabIds.slice(1)) w.handleCommand({ cmd: 'closeTab', tabId });
  await wait(800);
  log('reset', w.engine.paneCount() === 1 && Object.keys(w.engine.getTree().tabs).length === 1 ? 'OK' : 'FAIL');

  // ① 셸 «오른쪽으로 split» 단추
  await shellJs(`document.querySelector('.strip-split-right').click()`);
  await wait(800);
  log('click split-right', w.engine.paneCount() === 2 ? 'OK' : 'FAIL(pane≠2)');

  // ② 포커스 pane 의 «+» → 메뉴 «네이버 스마트스토어센터»
  await shellJs(`[...document.querySelectorAll('.strip')].find(s => s.classList.contains('pane-focused')).querySelector('.strip-newtab').click()`);
  await wait(300);
  const menuCount = await shellJs<number>(`document.querySelectorAll('#newtab-menu .menu-item').length`);
  await shellJs(`[...document.querySelectorAll('#newtab-menu .menu-item')].find(b => b.textContent.includes('네이버')).click()`);
  await wait(1500);
  const naverTabs = Object.values(w.engine.getTree().tabs).filter((t) => t.kind === 'naver').length;
  log('click + → 네이버', `menu ${menuCount} · naver tabs ${naverTabs} ${naverTabs === 1 ? 'OK' : 'FAIL'}`);

  // ③ sash — 셸이 보내는 것과 같은 resize 명령(드래그는 포인터 캡처라 스크립트로 못 끈다)
  const sashId = await shellJs<string>(`document.querySelector('.sash').dataset.sashId`);
  await shellJs(`window.hubShell.send({ cmd: 'resize', sashId: ${JSON.stringify(sashId)}, ratio: 0.35 })`);
  await wait(500);
  const ratio = (() => {
    const root = w.engine.getTree().root;
    return root.type === 'split' ? root.ratio : NaN;
  })();
  log('resize 0.35', `ratio ${ratio} ${Math.abs(ratio - 0.35) < 0.01 ? 'OK' : 'FAIL'}`);

  // ③b sash 를 «진짜 마우스처럼» 끈다 — 셸 view 에 mouseDown → 여러 점 mouseMove → mouseUp(포인터 캡처 · 요소 재사용 경로)
  {
    const geo = w.engine.computeGeometry({ x: 0, y: 40, width: w.window.getContentSize()[0] ?? 0, height: (w.window.getContentSize()[1] ?? 0) - 40 });
    const sash = geo.sashes[0];
    if (sash) {
      const before = (() => { const r = w.engine.getTree().root; return r.type === 'split' ? r.ratio : NaN; })();
      const y = sash.rect.y + Math.round(sash.rect.height / 2);
      const x0 = sash.rect.x + 2;
      const wc = w.shellView.webContents;
      wc.sendInputEvent({ type: 'mouseMove', x: x0, y });
      wc.sendInputEvent({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        // 왼쪽 단추가 눌린 채 움직인다는 표시가 없으면 Blink 가 «놓았다»로 보고 드래그를 끊는다
        wc.sendInputEvent({ type: 'mouseMove', x: x0 + i * 20, y, button: 'left', modifiers: ['leftbuttondown'] });
        await wait(30);
      }
      wc.sendInputEvent({ type: 'mouseUp', x: x0 + 200, y, button: 'left', clickCount: 1 });
      await wait(600);
      const after = (() => { const r = w.engine.getTree().root; return r.type === 'split' ? r.ratio : NaN; })();
      log('drag sash +200px', `ratio ${before.toFixed(3)} → ${after.toFixed(3)} ${after > before + 0.05 ? 'OK' : 'FAIL(드래그가 안 따라옴)'}`);
    }
  }

  // ④ 첫 pane «아래로 split»
  await shellJs(`document.querySelectorAll('.strip-split-down')[0].click()`);
  await wait(800);
  log('click split-down', w.engine.paneCount() === 3 ? 'OK' : 'FAIL(pane≠3)');

  // ⑤ 단축키 Ctrl+\ — 포커스 pane 의 view 에 진짜 입력 이벤트(before-input-event 경로)
  const focused = w.activeTabOfFocusedPane();
  const view = focused?.activeTabId ? w.views.get(focused.activeTabId) : undefined;
  if (view) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: '\\', modifiers: ['control'] });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: '\\', modifiers: ['control'] });
    await wait(800);
    log('Ctrl+\\ 단축키', w.engine.paneCount() === 4 ? 'OK' : 'FAIL(pane≠4 — sendInputEvent 의 code 가 Backslash 가 아닐 수 있다 · 사람이 눌러 실측)');
  }

  // ⑥ 상한: split 단추가 꺼졌나(pane 4 일 때만 의미)
  const disabled = await shellJs<boolean>(`document.querySelector('.strip-split-right').disabled`);
  log('split 단추 disabled?', `${disabled} ${w.engine.paneCount() >= 4 ? (disabled ? 'OK' : 'FAIL') : '(pane<4 라 판정 보류)'}`);

  // ⑦ 마지막 pane 의 탭 ✕ → pane 닫힘
  const before = w.engine.paneCount();
  await shellJs(`{ const strips = [...document.querySelectorAll('.strip')]; strips[strips.length - 1].querySelector('.tab-close').click(); }`);
  await wait(800);
  log('click tab ✕(마지막 pane)', w.engine.paneCount() === before - 1 ? 'OK' : `FAIL(pane ${before}→${w.engine.paneCount()})`);

  log('end', '— 창은 그대로 둔다(사장님이 보시게)');
}
