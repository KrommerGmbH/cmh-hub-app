// 검증 하네스 — CMH_HUB_SMOKE=1 로 띄우면 셸 단추를 «실제로 눌러» split · 새 탭 · sash · 닫기 · 단축키를 돌리고 결과를 찍는다.
// 셸 페이지(우리 로컬 HTML)에만 executeJavaScript 를 쓴다 — 서버 · 네이버 페이지에는 쓰지 않는다(U07 8-5).
import { app } from 'electron';
import type { ShellWindow } from './window/shell-window.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 정해진 시간 대신 조건이 맞을 때까지(최대 timeoutMs) — PC 가 바쁘면 셸 다시 그리기가 300ms 를 넘겨 판정이 흔들렸다(2026-10-04) */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await wait(100);
  }
  return cond();
}

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

  // ⓪b 탭 1개 — 레이아웃 메뉴의 2단 이상은 꺼져 있어야 한다(2026-10-04 «탭이 3개인데 4단 분할이 가능»)
  await shellJs(`document.querySelector('#layout-button').click()`);
  await wait(300);
  const disabledAtOne = await shellJs<string>(`[...document.querySelectorAll('.layout-item')].map(b => b.dataset.preset + ':' + (b.disabled ? 'off' : 'on')).join(' ')`);
  log('탭 1 → 2단 이상 꺼짐', `${/^single:on( \w+:off)+$/.test(disabledAtOne) ? 'OK' : 'FAIL'} ${disabledAtOne}`);
  await shellJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(300);
  // 2단을 고르려면 탭이 둘 있어야 한다 — 새 탭 하나
  if (firstPane) w.handleCommand({ cmd: 'newTab', paneId: firstPane.id });
  await wait(600);

  // ① 제목줄 레이아웃 단추 → 메뉴가 뜨는 동안 셸이 맨 위인가(아니면 어드민 view 가 메뉴를 덮는다 · 2026-10-03 결함) → «2단 좌우»
  await shellJs(`document.querySelector('#layout-button').click()`);
  log('layout 메뉴 · 셸 맨 위?', (await waitFor(() => w.isShellOnTop())) ? 'OK' : 'FAIL(메뉴가 페이지 아래에 깔림)');
  await shellJs(`document.querySelector('.layout-item[data-preset="columns2"]').click()`);
  await wait(800);
  log('layout 2단 좌우', `${w.engine.paneCount() === 2 ? 'OK' : 'FAIL(pane≠2)'} · 닫은 뒤 셸 맨 아래 ${w.isShellOnTop() ? 'FAIL' : 'OK'}`);

  // ② 포커스 pane 의 «+» → 메뉴 «네이버 스마트스토어센터»
  await shellJs(`[...document.querySelectorAll('.strip')].find(s => s.classList.contains('pane-focused')).querySelector('.strip-newtab').click()`);
  log('+ 메뉴 · 셸 맨 위?', (await waitFor(() => w.isShellOnTop())) ? 'OK' : 'FAIL(메뉴가 페이지 아래에 깔림)');
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
      // 셸이 resize 0.35 를 다시 그려 sash 가 계산한 자리에 왔을 때 누른다
      await waitFor(async () => Math.abs((await shellJs<number>(`document.querySelector('.sash')?.getBoundingClientRect().x ?? -1`)) - sash.rect.x) < 2);
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
      await waitFor(() => { const r = w.engine.getTree().root; return r.type === 'split' && r.ratio > before + 0.05; }, 3000);
      const after = (() => { const r = w.engine.getTree().root; return r.type === 'split' ? r.ratio : NaN; })();
      log('drag sash +200px', `ratio ${before.toFixed(3)} → ${after.toFixed(3)} ${after > before + 0.05 ? 'OK' : 'FAIL(드래그가 안 따라옴)'}`);
    }
  }

  // ④ 레이아웃 «3단(위 둘 · 아래 하나)»
  await shellJs(`document.querySelector('#layout-button').click()`);
  await wait(300);
  await shellJs(`document.querySelector('.layout-item[data-preset="top2bottom1"]').click()`);
  await wait(800);
  log('layout 3단', w.engine.paneCount() === 3 ? 'OK' : 'FAIL(pane≠3)');

  // ⑤ 단축키 Ctrl+\ — 포커스 pane 의 view 에 진짜 입력 이벤트(before-input-event 경로)
  const focused = w.activeTabOfFocusedPane();
  const view = focused?.activeTabId ? w.views.get(focused.activeTabId) : undefined;
  if (view) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: '\\', modifiers: ['control'] });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: '\\', modifiers: ['control'] });
    await wait(800);
    log('Ctrl+\\ 단축키', w.engine.paneCount() === 4 ? 'OK' : 'FAIL(pane≠4 — sendInputEvent 의 code 가 Backslash 가 아닐 수 있다 · 사람이 눌러 실측)');
  }

  // ⑥ 상한: pane 4 에서 Ctrl+\ 를 또 눌러도 4
  if (view) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: '\\', modifiers: ['control'] });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: '\\', modifiers: ['control'] });
    await wait(600);
    log('상한 4 에서 Ctrl+\\', w.engine.paneCount() === 4 ? 'OK' : `FAIL(pane ${w.engine.paneCount()})`);
  }

  // ⑦ 마지막 pane 의 탭 ✕ → pane 닫힘
  const before = w.engine.paneCount();
  await shellJs(`{ const strips = [...document.querySelectorAll('.strip')]; strips[strips.length - 1].querySelector('.tab-close').click(); }`);
  await wait(800);
  log('click tab ✕(마지막 pane)', w.engine.paneCount() === before - 1 ? 'OK' : `FAIL(pane ${before}→${w.engine.paneCount()})`);

  // ⑦b 키보드 — 탭에 포커스를 둔 채 상태가 다시 오면(다시 그리기) 포커스가 탭에 남나 · Esc 로 메뉴를 닫으면 레이아웃 단추로 돌아오나
  {
    const activeTab = w.activeTabOfFocusedPane()?.activeTabId;
    await shellJs(`document.querySelector('.strip.pane-focused .tab.active')?.focus()`);
    if (activeTab) w.handleCommand({ cmd: 'activateTab', tabId: activeTab }); // 같은 탭 — 상태만 다시 간다
    await wait(400);
    const kept = await shellJs<boolean>(`!!document.activeElement?.closest('.tab')`);
    log('키보드: 다시 그려도 탭 포커스', kept ? 'OK' : 'FAIL(포커스가 빠짐)');
    // 셸에서 → 를 «셸 안 keydown» 으로 눌렀을 때 OS 키보드 포커스(셸 webContents)가 페이지로 안 넘어가나
    // 탭이 하나면 ← 가 아무 명령도 안 보낸다 — 새 탭을 열어(맨 오른쪽 · 활성) ← 가 진짜 activateTab 을 보내게
    const fp = w.focusedPaneId();
    if (fp) w.handleCommand({ cmd: 'newTab', paneId: fp });
    await wait(600);
    const activeBefore = w.activeTabOfFocusedPane()?.activeTabId;
    w.shellView.webContents.focus();
    await shellJs(`document.querySelector('.strip.pane-focused .tab.active')?.focus()`);
    const before = w.shellView.webContents.isFocused();
    // 새 탭이 맨 오른쪽 · 활성이라 ← 만 누른다(옛 `a || b` 는 ← 가 preventDefault 되면 → 까지 눌러 제자리로 돌아갈 수 있었다 · 제미나이 검수 2026-10-04)
    await shellJs(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
    await wait(500);
    const after = w.shellView.webContents.isFocused();
    const moved = w.activeTabOfFocusedPane()?.activeTabId !== activeBefore;
    log('키보드: ← 탭 이동 · 셸 포커스 유지', `${moved ? '이동 OK' : 'FAIL(안 옮겨짐)'} · ${before === after ? `포커스 OK(${String(after)})` : `FAIL(${String(before)}→${String(after)})`}`);
    await shellJs(`document.querySelector('#layout-button').focus(); document.querySelector('#layout-button').click()`);
    await wait(300);
    await shellJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(300);
    const back = await shellJs<string>(`document.activeElement?.id ?? ''`);
    log('키보드: Esc → 레이아웃 단추', `${back === 'layout-button' ? 'OK' : `FAIL(${back})`} · 셸 맨 아래 ${w.isShellOnTop() ? 'FAIL' : 'OK'}`);
  }

  // ⑦c 탭 끌기(U04) — 첫 pane 의 활성 탭을 «마우스로» 끌어 마지막 pane 의 탭 줄에 놓는다(셸 view 에 입력 이벤트)
  {
    const panes = w.engine.listPanes();
    const from = panes[0];
    const to = panes[panes.length - 1];
    if (from && to && from.id !== to.id && from.activeTabId) {
      const movingTab = from.activeTabId;
      const p = await shellJs<{ x: number; y: number; tx: number; ty: number }>(`(() => {
        const t = document.querySelector('.tab[data-tab-id="${movingTab}"]').getBoundingClientRect();
        const s = document.querySelector('.strip[data-pane-id="${to.id}"] .strip-tabs').getBoundingClientRect();
        return { x: t.x + 20, y: t.y + t.height / 2, tx: s.right - 4, ty: s.y + s.height / 2 };
      })()`);
      const wc = w.shellView.webContents;
      const sx = Math.round(p.x);
      const sy = Math.round(p.y);
      wc.sendInputEvent({ type: 'mouseMove', x: sx, y: sy });
      wc.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 12; i++) {
        const x = Math.round(sx + ((p.tx - sx) * i) / 12);
        const y = Math.round(sy + ((p.ty - sy) * i) / 12);
        wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftbuttondown'] });
        await wait(30);
      }
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p.tx), y: Math.round(p.ty), button: 'left', clickCount: 1 });
      await wait(800);
      const nowIn = w.engine.getPaneOfTab(movingTab)?.id;
      if (nowIn !== to.id) console.info('[smoke] tabDragLog', await shellJs<string>('JSON.stringify(window.__tabDragLog)'));
      log('탭 끌기 → 다른 창', `${nowIn === to.id ? 'OK' : `FAIL(탭이 ${nowIn?.slice(0, 8)} 에 있음)`} · from ${from.id.slice(0, 8)} → to ${to.id.slice(0, 8)} · 놓은 점 ${Math.round(p.tx)},${Math.round(p.ty)} · 셸 맨 아래 ${w.isShellOnTop() ? 'FAIL' : 'OK'}`);
      console.info('[smoke] strips', JSON.stringify(w.engine.listPanes().map((x) => x.id.slice(0, 8))), await shellJs<string>(`JSON.stringify([...document.querySelectorAll('.strip')].map(s => [s.dataset.paneId.slice(0,8), Math.round(s.getBoundingClientRect().x), Math.round(s.getBoundingClientRect().y), Math.round(s.getBoundingClientRect().width)]))`));
    } else {
      log('탭 끌기 → 다른 창', '판정 보류(pane 이 하나뿐)');
    }
  }

  // ⑦d 레이아웃 단축키 Ctrl+Shift+1(1단 · 탭 수와 상관없이 늘 된다) — 포커스 pane 페이지에 진짜 키 입력
  {
    const pageTab = w.activeTabOfFocusedPane()?.activeTabId;
    const pageView = pageTab ? w.views.get(pageTab) : undefined;
    // 이미 1단이면 단축키가 안 돌아도 통과한다 — 먼저 2단 이상인지 본다(제미나이 재검수)
    if (w.engine.paneCount() < 2) log('Ctrl+Shift+1 → 1단', 'FAIL(시험 전 pane 이 이미 1개 — 판정 불가)');
    if (pageView && w.engine.paneCount() >= 2) {
      pageView.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control', 'shift'] });
      pageView.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control', 'shift'] });
      log('Ctrl+Shift+1 → 1단', (await waitFor(() => w.engine.paneCount() === 1)) ? 'OK' : `FAIL(pane ${w.engine.paneCount()})`);
    }
  }

  // ⑦e 레이아웃 메뉴가 열린 채 단축키로 바꾸면 파란 점이 따라오나 · 숫자 패드(Ctrl 만 · Shift 없이) — 2026-10-04 사장님 버그 둘
  {
    await shellJs(`document.querySelector('#layout-button').click()`);
    await waitFor(() => w.isShellOnTop());
    // 메뉴가 열려 있으면 셸이 키를 받는다 — 셸 webContents 에 숫자 패드 2(= 2단 좌우)
    w.shellView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'num2', modifiers: ['control', 'shift', 'numlock'] });
    w.shellView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'num2', modifiers: ['control', 'shift', 'numlock'] });
    const changed = await waitFor(() => w.engine.paneCount() === 2);
    const dot = await waitFor(async () => (await shellJs<string>(`document.querySelector('.layout-item.current-preset')?.dataset.preset ?? ''`)) === 'columns2');
    log('숫자 패드 2 → 2단 · 메뉴 점 따라옴', `${changed ? '레이아웃 OK' : 'FAIL(레이아웃 안 바뀜)'} · ${dot ? '점 OK' : 'FAIL(점이 옛 자리)'}`);
    await shellJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(() => !w.isShellOnTop());
  }

  // ⑦f 오른쪽 클릭 메뉴 — 페이지 view 마다 context-menu 처리기가 붙어 있나(메뉴 자체는 OS 그림이라 눈으로 본다)
  {
    const tabIds = Object.keys(w.engine.getTree().tabs);
    const attached = tabIds.filter((id) => (w.views.get(id)?.webContents.listenerCount('context-menu') ?? 0) > 0).length;
    log('오른쪽 클릭 메뉴 붙음', `${attached === tabIds.length && attached > 0 ? 'OK' : 'FAIL'} ${attached}/${tabIds.length}`);
  }

  // ⑨ 뒤로 · 앞으로 · 새로고침 단추(2026-10-05 «크롬처럼 refresh, 앞으로, 뒤로 버튼») — 셸 단추를 눌러 탭 기록이 움직이는지
  {
    const focused = w.activeTabOfFocusedPane();
    const tabWc = focused?.activeTabId ? w.views.get(focused.activeTabId)?.webContents : undefined;
    if (!tabWc) {
      log('뒤로 · 앞으로 · 새로고침', 'FAIL 포커스 탭 없음');
    } else {
      const btn = (cls: string): string => `document.querySelector('.strip.pane-focused .${cls}')`;
      const first = tabWc.getURL();
      await tabWc.loadURL(`${first.split('#')[0]}#/sw/settings/index`).catch(() => undefined); // 같은 문서 안 해시 이동 = 기록 하나
      const backOn = await waitFor(() => shellJs<boolean>(`!${btn('strip-back')}.disabled`), 8000);
      const beforeBack = tabWc.navigationHistory.getActiveIndex();
      const urlBeforeBack = tabWc.getURL();
      // 뒤로를 누르면 탭이 움직였는가 — 어드민이 그 주소를 다시 다른 주소로 보내면(로그인 만료 등) 기록 번호는 다시 늘 수 있어
      // «이동 이벤트가 났나»로 본다
      const navigated = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        const done = (): void => { clearTimeout(timer); resolve(true); };
        tabWc.once('did-navigate-in-page', done);
        tabWc.once('did-navigate', done);
      });
      await shellJs(`${btn('strip-back')}.click()`);
      const wentBack = await navigated;
      const indexAfterBack = tabWc.navigationHistory.getActiveIndex();
      const forwardOn = await waitFor(() => shellJs<boolean>(`!${btn('strip-forward')}.disabled`), 3000);
      console.info(`[smoke] 뒤로 진단 index ${beforeBack} → ${indexAfterBack} · ${urlBeforeBack.split('#')[1] ?? ''} → ${tabWc.getURL().split('#')[1] ?? ''} · 앞으로 켜짐 ${forwardOn}`);
      const reloaded = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        tabWc.once('did-start-loading', () => { clearTimeout(timer); resolve(true); });
      });
      await shellJs(`${btn('strip-reload')}.click()`);
      const reloadOk = await reloaded;
      // 앞으로는 «뒤로 간 자리에 머물렀을 때»만 켜진다 — 어드민이 다시 보내면 앞 기록이 지워진다(그때는 판정에서 뺀다)
      const stayed = indexAfterBack < beforeBack;
      const ok = backOn && wentBack && reloadOk && (!stayed || forwardOn);
      log('뒤로 · 앞으로 · 새로고침', `${ok ? 'OK' : 'FAIL'} 뒤로 켜짐 ${backOn} · 뒤로 이동 ${wentBack} · 앞으로 켜짐 ${forwardOn}${stayed ? '' : '(어드민이 주소를 다시 보내 판정 제외)'} · 새로고침 ${reloadOk}`);
    }
  }

  // ⑩ 오른쪽 클릭 «검사» → 개발자 도구가 따로 뜨는 창이 아니라 pane 오른쪽 view 에(2026-10-05 «크롬처럼 오른쪽 사이드에»)
  {
    const focused = w.activeTabOfFocusedPane();
    const tabId = focused?.activeTabId;
    const page = tabId ? w.views.get(tabId) : undefined;
    if (!tabId || !page) {
      log('검사 → 오른쪽 개발자 도구', 'FAIL 포커스 탭 없음');
    } else {
      const childCount = (): number => w.window.contentView.children.length;
      const before = childCount();
      const pageWidthBefore = page.getBounds().width;
      let openedEvent = false;
      page.webContents.once('devtools-opened', () => { openedEvent = true; });
      w.handleInspectForSmoke(tabId, 100, 100);
      const opened = await waitFor(() => page.webContents.isDevToolsOpened() || openedEvent, 6000);
      const lastView = w.window.contentView.children[w.window.contentView.children.length - 1] as Electron.WebContentsView | undefined;
      console.info(`[smoke] 검사 진단 isDevToolsOpened=${page.webContents.isDevToolsOpened()} · devtools-opened 이벤트=${openedEvent} · 개발자 도구 view 주소=${lastView?.webContents?.getURL?.().slice(0, 60) ?? '없음'}`);
      const addedView = childCount() === before + 1;
      const pageNarrowed = page.getBounds().width < pageWidthBefore;
      const tools = w.window.contentView.children[w.window.contentView.children.length - 1];
      const toolsRight = tools ? tools.getBounds().x >= page.getBounds().x + page.getBounds().width - 1 : false;
      w.closeInspectorForSmoke(tabId);
      const closed = await waitFor(() => childCount() === before && page.getBounds().width === pageWidthBefore, 6000);
      // 닫은 뒤 다시 «검사» — 새 view 로 다시 떠야 한다
      // 다른 view 에 띄운 개발자 도구는 다시 열 때 devtools-opened 가 안 온다(isDevToolsOpened 도 false) — «devtools:// 화면이 다시 창에 붙고 페이지가 좁아졌나»로 본다
      w.handleInspectForSmoke(tabId, 120, 120);
      const reopened = await waitFor(() => {
        const top = w.window.contentView.children[w.window.contentView.children.length - 1] as Electron.WebContentsView | undefined;
        return childCount() === before + 1 && (top?.webContents?.getURL?.() ?? '').startsWith('devtools://') && page.getBounds().width < pageWidthBefore;
      }, 6000);
      w.closeInspectorForSmoke(tabId);
      const closedAgain = await waitFor(() => childCount() === before, 6000);
      const ok = opened && addedView && pageNarrowed && toolsRight && closed && reopened && closedAgain;
      log('검사 → 오른쪽 개발자 도구', `${ok ? 'OK' : 'FAIL'} 열림 ${opened} · view 하나 더 ${addedView} · 페이지 좁아짐 ${pageNarrowed} · 오른쪽 ${toolsRight} · 닫으면 원래대로 ${closed} · 다시 열림 ${reopened} · 다시 닫힘 ${closedAgain}`);
    }
  }

  // ⑧ 진짜 마우스 시험용 — 첫 pane «+» 단추의 «화면» 좌표(창 content 좌상단 + 셸 안 좌표). 밖의 스크립트가 OS 클릭을 보낸다
  //    (JS .click() 은 view 층 순서를 안 거쳐 «메뉴가 페이지 아래에 깔림» 결함을 못 잡았다 · 2026-10-03)
  const plus = await shellJs<{ x: number; y: number }>(`(() => { const r = document.querySelector('.strip .strip-newtab').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const cb = w.window.getContentBounds();
  console.info(`[smoke] plus-screen ${Math.round(cb.x + plus.x)},${Math.round(cb.y + plus.y)}`);

  log('end', '— 창은 그대로 둔다(사장님이 보시게)');
}
