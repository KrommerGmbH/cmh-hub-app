// U07 ⑥⑦ 병렬 시험 — CMH_HUB_PARALLEL=1 (개발판만 · 2026-10-05 사장님 «왼쪽 어드민 · 오른쪽 네이버 · 내가 왼쪽에서 작업하고 네가 오른쪽에서
// 마우스 움직여서 작업하는 마우스 포인트 두 개로 병렬 작업 테스트»).
// - 네이버 pane 위에 투명 덮개(overlay.html · 맨 위 · 사람 클릭은 막힘 · U07 ⑤)를 놓고 가짜 AI 커서와 «AI 작업 중» 띠를 그린다.
// - AI 입력은 sendInputEvent 로 네이버 view 에만 보낸다 — OS 마우스를 움직이지 않는다(사람 마우스는 왼쪽에서 그대로).
// - 읽기만: 사람 같은 곡선 이동(ghost-cursor path) · 스크롤 · 빈 곳 클릭 · 입력칸 클릭(글자는 안 침). 링크 · 단추는 누르지 않는다(이동 · 저장 0).
// - 잰다: 사람 키 입력이 어느 view 로 갔나 · AI 클릭 직후 왼쪽(어드민) view 가 키보드 포커스를 잃었나 → userData/logs/parallel-<시각>.json
import { app, webContents, WebContentsView, type WebContents } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { path as ghostPath } from 'ghost-cursor';
import { OVERLAY_IPC } from '@cmh-hub-app/contracts';
import type { ShellWindow } from './window/shell-window.js';

const here = dirname(fileURLToPath(import.meta.url)); // dist/main
const DIST = join(here, '..');
const TASK_ID = 'parallel-test';
/** AI 커서 빠르기 배수 — 이동 · 동작 사이 쉬는 시간을 이 수로 나눈다(2026-10-06 사장님 «너무 느려 2-3 배 빨라도 돼» · CMH_HUB_PARALLEL_SPEED 로 바꿈) */
const rawSpeed = Number(process.env['CMH_HUB_PARALLEL_SPEED'] ?? '2.5');
const AI_SPEED = Number.isFinite(rawSpeed) && rawSpeed >= 1 && rawSpeed <= 10 ? rawSpeed : 2.5; // Infinity · 100 이면 쉬는 시간 0 → 이벤트 폭주(제미나이 검수 2026-10-06)

interface Point {
  x: number;
  y: number;
}

interface ClickProbe {
  at: string;
  kind: 'blank' | 'input';
  point: Point;
  adminFocusedBefore: boolean;
  adminFocusedAfter: boolean;
  naverFocusedAfter: boolean;
  /** «사람 우선»으로 사람 손이 쉴 때까지 기다린 시간(ms) · 못 기다려 건너뛰었으면 skipped */
  waitedForHumanMs: number;
  skipped: boolean;
  /** 클릭 뒤 왼쪽에 포커스를 돌려줬나 */
  focusRestored: boolean;
}

interface Summary {
  startedAt: string;
  endedAt: string | null;
  stoppedBy: 'time' | 'stop-button' | 'error' | null;
  aiMoves: number;
  aiScrolls: number;
  aiClicks: ClickProbe[];
  /** 사람이 친 키(keyDown) — 어느 view 로 갔나. AI 는 키를 안 보낸다 → 네이버 쪽 수가 0 이 아니면 «포커스를 빼앗겼다» */
  humanKeysToAdmin: number;
  humanKeysToNaver: number;
  humanKeysToNaverAt: string[];
  adminBlurEvents: number;
  /** «사람 우선» 규칙을 켰나(CMH_HUB_PARALLEL_GUARD=0 이면 끔 — 견주기용) */
  humanFirst: boolean;
  error: string | null;
}

let stopRequested = false;

/** 덮개의 «멈추기»(OVERLAY_IPC.cmd aiTaskStop) — ipc.ts 가 부른다 */
export function stopParallelCheck(): void {
  stopRequested = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 네이버 페이지에서 «보이는» 후보 점을 읽기만 한다(isolated world · 값 쓰기 0) */
async function readTargets(wc: WebContents): Promise<{ hover: Point[]; inputs: Point[]; blank: Point | null } | null> {
  try {
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(1208, [{
      code: `(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
        const pick = (sel, n) => Array.from(document.querySelectorAll(sel)).map(vis).filter(Boolean).slice(0, n);
        const hover = pick('a, button, [role="button"], li, h1, h2, h3, img', 40);
        const inputs = pick('input[type="text"], input[type="email"], input:not([type]), textarea', 5);
        let blank = null;
        for (let i = 0; i < 30 && !blank; i++) {
          const x = Math.round(innerWidth * (0.1 + Math.random() * 0.8)), y = Math.round(innerHeight * (0.1 + Math.random() * 0.8));
          const e = document.elementFromPoint(x, y);
          // 빈 곳 = 누를 것이 아닌 곳. JS 로 클릭을 받는 div · 행도 거르려고 마우스 모양(손가락)과 역할(행 · 탭 · 메뉴)도 본다(제미나이 검수 2026-10-05)
          const clicky = (n) => { for (let k = 0; n && k < 6; k++, n = n.parentElement) { if (getComputedStyle(n).cursor === 'pointer') return true; } return false; };
          if (e && !e.closest('a, button, input, textarea, select, label, summary, tr, li, [role], [tabindex], [onclick], [contenteditable="true"]') && !clicky(e)) blank = { x, y };
        }
        return { hover, inputs, blank };
      })()`,
    }]);
    return result && typeof result === 'object' ? (result as { hover: Point[]; inputs: Point[]; blank: Point | null }) : null;
  } catch {
    return null;
  }
}

export function runParallelCheckIfRequested(w: ShellWindow): void {
  if (!process.env['CMH_HUB_PARALLEL'] || app.isPackaged) return;
  void run(w);
}

async function run(w: ShellWindow): Promise<void> {
  const minutes = Number(process.env['CMH_HUB_PARALLEL_MIN'] ?? '3');
  const summary: Summary = {
    startedAt: new Date().toISOString(), endedAt: null, stoppedBy: null, aiMoves: 0, aiScrolls: 0, aiClicks: [],
    humanKeysToAdmin: 0, humanKeysToNaver: 0, humanKeysToNaverAt: [], adminBlurEvents: 0, humanFirst: process.env['CMH_HUB_PARALLEL_GUARD'] !== '0', error: null,
  };
  /** 사람이 왼쪽(어드민)에서 마지막으로 키 · 마우스를 쓴 때 — AI 입력은 네이버 view 로만 가므로 왼쪽 입력은 전부 사람 것 */
  let lastHumanInputAt = 0;
  const outFile = join(app.getPath('userData'), 'logs', `parallel-${summary.startedAt.replace(/[:.]/g, '-')}.json`);
  const save = (): void => {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  };
  let overlay: WebContentsView | null = null;
  let boundsTimer: NodeJS.Timeout | null = null;
  let detach: (() => void) | null = null;
  try {
    // ① 배치 — 왼쪽 어드민 · 오른쪽 네이버
    const firstPane = w.focusedPaneId();
    if (!firstPane) throw new Error('pane 없음');
    w.handleCommand({ cmd: 'newTab', paneId: firstPane, kind: 'naver' });
    w.handleCommand({ cmd: 'applyLayout', preset: 'columns2' });
    await sleep(500);
    const tree = w.engine.getTree();
    const naverTabId = Object.values(tree.tabs).find((t) => t.kind === 'naver')?.id;
    const adminTabId = Object.values(tree.tabs).find((t) => t.kind === 'admin')?.id;
    const left = w.paneIdByOrder(0);
    const right = w.paneIdByOrder(1);
    if (!naverTabId || !adminTabId || !left || !right) throw new Error('탭 · pane 을 못 찾음');
    if (w.engine.getPaneOfTab(naverTabId)?.id !== right) w.handleCommand({ cmd: 'moveTab', tabId: naverTabId, toPaneId: right });
    if (w.engine.getPaneOfTab(adminTabId)?.id !== left) w.handleCommand({ cmd: 'moveTab', tabId: adminTabId, toPaneId: left });
    await sleep(800);
    const naverView = w.views.get(naverTabId);
    const adminView = w.views.get(adminTabId);
    if (!naverView || !adminView) throw new Error('view 없음');
    const naver = naverView.webContents;
    const admin = adminView.webContents;
    admin.focus(); // 사람은 왼쪽에서 시작
    console.info('[parallel] 배치 끝 — 왼쪽 어드민 · 오른쪽 네이버. 사장님은 왼쪽에서 작업하십시오');

    // ② 사람 키 · 포커스 재기 — AI 는 키를 안 보낸다
    // 시험이 끝나면 뗀다(finally · 제미나이 검수 2026-10-05 — 안 떼면 끝난 뒤에도 사장님 키마다 경고가 났다)
    const onAdminKey = (_e: Electron.Event, input: Electron.Input): void => {
      lastHumanInputAt = Date.now();
      if (input.type === 'keyDown') summary.humanKeysToAdmin++;
    };
    const onAdminMouse = (): void => {
      lastHumanInputAt = Date.now(); // before-mouse-event — 사람 마우스(electron.d.ts · 왼쪽 클릭 계정 목록도 이것을 쓴다)
    };
    const onNaverKey = (_e: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') return;
      summary.humanKeysToNaver++;
      summary.humanKeysToNaverAt.push(new Date().toISOString());
      console.warn(`[parallel] 사람 키가 오른쪽(네이버)으로 갔습니다 — 누적 ${summary.humanKeysToNaver}`);
    };
    const onAdminBlur = (): void => {
      summary.adminBlurEvents++;
    };
    admin.on('before-input-event', onAdminKey);
    admin.on('before-mouse-event', onAdminMouse);
    naver.on('before-input-event', onNaverKey);
    admin.on('blur', onAdminBlur);
    detach = (): void => {
      if (!admin.isDestroyed()) {
        admin.off('before-input-event', onAdminKey);
        admin.off('before-mouse-event', onAdminMouse);
        admin.off('blur', onAdminBlur);
      }
      if (!naver.isDestroyed()) naver.off('before-input-event', onNaverKey);
    };

    // ③ 덮개(맨 위 · 투명) — 가짜 커서 · 띠 · 사람 클릭 막기
    overlay = new WebContentsView({ webPreferences: { preload: join(DIST, 'preload', 'overlay-preload.mjs'), sandbox: false, contextIsolation: true, nodeIntegration: false } });
    overlay.setBackgroundColor('#00000000');
    w.window.contentView.addChildView(overlay);
    overlay.setBounds(naverView.getBounds());
    await overlay.webContents.loadFile(join(DIST, 'shell', 'overlay.html'));
    const ov = overlay;
    boundsTimer = setInterval(() => {
      if (!ov.webContents.isDestroyed() && !naverView.webContents.isDestroyed()) ov.setBounds(naverView.getBounds());
    }, 150); // 덮개 자리 맞춤 — 창 · sash 를 움직일 때 덮개와 네이버 view 가 어긋나 사람 클릭이 새는 틈을 줄인다(제미나이 검수 2026-10-05)
    const sendCursor = (p: Point | null): void => {
      if (!ov.webContents.isDestroyed()) ov.webContents.send(OVERLAY_IPC.cursor, p);
    };
    const end = Date.now() + minutes * 60_000;
    let step = 0;
    const steps = Math.round(minutes * 13 * AI_SPEED); // 띠 글자의 전체 단계 수 어림 — 2026-10-06 실측: 빠르기 2.5 · 3분 = 99단계(분당 33). 빠르기를 안 곱하면 띠가 100% 를 넘김
    const band = (): void => {
      if (!ov.webContents.isDestroyed()) ov.webContents.send(OVERLAY_IPC.band, { paneId: right, taskId: TASK_ID, title: '병렬 시험(읽기만 · 저장 0)', step, steps });
    };

    // ④ AI 동작 — 읽기만
    const b0 = naverView.getBounds();
    let pos: Point = { x: Math.round(b0.width / 2), y: Math.round(b0.height / 2) };
    const moveTo = async (target: Point): Promise<void> => {
      const pts = ghostPath(pos, target, { useTimestamps: true }) as Array<Point & { timestamp?: number }>;
      let last = pts[0]?.timestamp ?? Date.now();
      for (const p of pts) {
        if (stopRequested || naver.isDestroyed()) return;
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        naver.sendInputEvent({ type: 'mouseMove', x, y });
        sendCursor({ x, y });
        const dt = Math.max(2, Math.min(40, (p.timestamp ?? last + 16) - last) / AI_SPEED);
        last = p.timestamp ?? last + 16;
        await sleep(dt);
      }
      pos = { x: Math.round(target.x), y: Math.round(target.y) };
      summary.aiMoves++;
    };
    // «사람 우선»(U07 ⑦) — AI 클릭은 키보드 포커스를 오른쪽으로 가져간다(2026-10-05 1분 시험 실측). 그래서 사람 손이 1초 쉴 때만 누르고,
    // mouseDown 직후 · mouseUp 뒤에 사람이 쓰던 화면으로 포커스를 돌려준다. 15초 안에 손이 안 쉬면 이번 클릭은 건너뛴다.
    const HUMAN_IDLE_MS = 1000;
    const HUMAN_WAIT_MAX_MS = 15_000;
    const clickProbe = async (kind: 'blank' | 'input', p: Point): Promise<void> => {
      await moveTo(p);
      const waitStart = Date.now();
      if (summary.humanFirst) {
        while (Date.now() - lastHumanInputAt < HUMAN_IDLE_MS && Date.now() - waitStart < HUMAN_WAIT_MAX_MS && !stopRequested) await sleep(100);
      }
      const waitedForHumanMs = Date.now() - waitStart;
      if (summary.humanFirst && Date.now() - lastHumanInputAt < HUMAN_IDLE_MS) {
        summary.aiClicks.push({ at: new Date().toISOString(), kind, point: pos, adminFocusedBefore: admin.isFocused(), adminFocusedAfter: admin.isFocused(), naverFocusedAfter: naver.isFocused(), waitedForHumanMs, skipped: true, focusRestored: false });
        console.info(`[parallel] AI 클릭(${kind}) 건너뜀 — 사람이 ${HUMAN_WAIT_MAX_MS / 1000}초 동안 계속 쓰는 중`);
        return;
      }
      const adminFocusedBefore = admin.isFocused();
      // 돌려줄 곳 = 클릭 직전 실제로 키보드 포커스가 있던 화면(왼쪽 어느 탭이든 · 셸 주소창이든 · 제미나이 검수 2026-10-05)
      const humanFocus = webContents.getFocusedWebContents();
      const giveBack = summary.humanFirst && humanFocus && humanFocus.id !== naver.id && !humanFocus.isDestroyed() ? humanFocus : null;
      naver.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      // mouseDown 이 포커스를 오른쪽으로 가져간다 — 바로 돌려주고(사람 글자가 새는 틈을 줄임), mouseUp 뒤 한 번 더
      await sleep(10);
      giveBack?.focus();
      await sleep(rand(60, 140));
      naver.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      let focusRestored = false;
      if (giveBack && !giveBack.isDestroyed()) {
        await sleep(10);
        giveBack.focus();
        focusRestored = true;
      }
      await sleep(300);
      const probe: ClickProbe = { at: new Date().toISOString(), kind, point: pos, adminFocusedBefore, adminFocusedAfter: admin.isFocused(), naverFocusedAfter: naver.isFocused(), waitedForHumanMs, skipped: false, focusRestored };
      summary.aiClicks.push(probe);
      console.info(`[parallel] AI 클릭(${kind}) — 사람 쉴 때까지 ${waitedForHumanMs}ms · 왼쪽 포커스 ${String(adminFocusedBefore)} → ${String(probe.adminFocusedAfter)} · 오른쪽 포커스 ${String(probe.naverFocusedAfter)} · 돌려줌 ${String(focusRestored)}`);
    };

    band();
    while (!stopRequested && Date.now() < end && !naver.isDestroyed()) {
      step++;
      band();
      const targets = await readTargets(naver);
      const roll = step % 6;
      if (roll === 3) {
        naver.sendInputEvent({ type: 'mouseWheel', x: pos.x, y: pos.y, deltaX: 0, deltaY: Math.random() < 0.7 ? -240 : 240 });
        summary.aiScrolls++;
      } else if (roll === 5 && targets?.blank) {
        await clickProbe('blank', targets.blank);
      } else if (roll === 0 && targets?.inputs[0]) {
        await clickProbe('input', targets.inputs[0]);
      } else {
        const list = targets?.hover ?? [];
        const target = list.length > 0 ? list[Math.floor(Math.random() * list.length)] : { x: rand(40, b0.width - 40), y: rand(40, b0.height - 40) };
        if (target) await moveTo(target);
      }
      save();
      await sleep(rand(1200, 3500) / AI_SPEED);
    }
    summary.stoppedBy = stopRequested ? 'stop-button' : 'time';
  } catch (error) {
    summary.stoppedBy = 'error';
    summary.error = error instanceof Error ? error.message : String(error);
    console.error('[parallel] 실패', summary.error);
  } finally {
    stopRequested = false;
    detach?.();
    if (boundsTimer) clearInterval(boundsTimer);
    if (overlay) {
      if (!w.window.isDestroyed()) w.window.contentView.removeChildView(overlay);
      if (!overlay.webContents.isDestroyed()) overlay.webContents.close();
    }
    summary.endedAt = new Date().toISOString();
    save();
    console.info(`[parallel] 끝 ${JSON.stringify({ stoppedBy: summary.stoppedBy, aiMoves: summary.aiMoves, aiScrolls: summary.aiScrolls, aiClicks: summary.aiClicks.length, humanKeysToAdmin: summary.humanKeysToAdmin, humanKeysToNaver: summary.humanKeysToNaver, adminBlurEvents: summary.adminBlurEvents, file: outFile })}`);
  }
}
