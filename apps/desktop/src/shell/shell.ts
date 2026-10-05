// U01 — 셸 페이지. 상태(ShellState)가 정본 · 받을 때마다 다시 그린다. window.hubShell 만 쓴다(Node · electron 없음).
// 스트립 · sash 요소는 id 로 재사용한다(지우고 새로 만들지 않는다) — 끌고 있는 sash 가 사라지면 포인터 캡처가 끊긴다(2026-10-02 사장님 «넓히고 좁히기가 안 된다»).
import type { SashGeometry, ShellCommand, ShellState } from '@cmh-hub-app/contracts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`셸 요소 없음: ${sel}`);
  return el;
};

const panesEl = $<HTMLElement>('#panes');
const tabTemplate = $<HTMLTemplateElement>('#tab-template');
const stripTemplate = $<HTMLTemplateElement>('#strip-template');
const menuEl = $<HTMLElement>('#newtab-menu');
const layoutMenuEl = $<HTMLElement>('#layout-menu');
const layoutButtonEl = $<HTMLButtonElement>('#layout-button');
const modalEl = $<HTMLElement>('#update-modal');

const stripEls = new Map<string, HTMLElement>();
const sashEls = new Map<string, HTMLElement>();
const sashData = new Map<string, SashGeometry>();

let lastState: ShellState | null = null;

interface Drag {
  sashId: string;
  pointerId: number;
  orientation: 'horizontal' | 'vertical';
  /** pointerdown 때의 split 자리 — 끄는 동안 바뀌지 않는다 */
  start: number;
  length: number;
  raf: number | null;
  pending: number | null;
  lastSent: number | null;
}
let drag: Drag | null = null;

function send(cmd: ShellCommand): void {
  window.hubShell?.send(cmd);
}

function px(n: number): string {
  return `${n}px`;
}

function place(el: HTMLElement, r: { x: number; y: number; width: number; height: number }): void {
  el.style.left = px(r.x);
  el.style.top = px(r.y);
  el.style.width = px(r.width);
  el.style.height = px(r.height);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// ───────────────────────── 제목줄 ─────────────────────────

function renderTitle(state: ShellState): void {
  $<HTMLElement>('#server-host').textContent = `· ${state.serverHost}`;
  // «pane 2 / 4» 글은 숨기고 레이아웃 단추 툴팁으로(디자인 검토 2026-10-03 · 개발 낱말을 화면에 덜 드러냄)
  $<HTMLElement>('#pane-count').hidden = true;
  layoutButtonEl.title = `레이아웃 · 화면 ${state.paneCount} / ${state.maxPanes}`;
  $<HTMLElement>('#update-dot').hidden = !(state.update.state === 'available' || state.update.state === 'ready' || state.update.state === 'required');
  $<HTMLElement>('#window-controls').hidden = state.platform !== 'linux';
}

// ───────────────────────── 탭 스트립(pane 마다 · id 로 재사용) ─────────────────────────

function createStrip(paneId: string): HTMLElement {
  const strip = (stripTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  strip.dataset['paneId'] = paneId;
  strip.querySelector<HTMLButtonElement>('.strip-newtab')!.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!lastState) return;
    openNewTabMenu(lastState, paneId, (e.currentTarget as HTMLElement).getBoundingClientRect());
  });
  // 뒤로 · 앞으로 · 새로고침 — 이 pane 의 활성 탭에(2026-10-05 «크롬처럼 refresh, 앞으로, 뒤로 버튼»)
  const navButtons: Array<[string, 'back' | 'forward' | 'reload']> = [['.strip-back', 'back'], ['.strip-forward', 'forward'], ['.strip-reload', 'reload']];
  for (const [selector, action] of navButtons) {
    strip.querySelector<HTMLButtonElement>(selector)!.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabId = lastState?.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.active)?.id;
      if (tabId) send({ cmd: 'navigate', tabId, action });
    });
  }
  strip.addEventListener('mousedown', () => {
    const pane = lastState?.panes.find((p) => p.id === paneId);
    if (pane && !pane.focused) send({ cmd: 'focusPane', paneId });
  });
  panesEl.appendChild(strip);
  stripEls.set(paneId, strip);
  return strip;
}

function renderTab(tab: ShellState['panes'][number]['tabs'][number], paneId: string): HTMLElement {
  const el = (tabTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.dataset['tabId'] = tab.id;
  el.classList.toggle('active', tab.active);
  // 키보드 — 활성 탭만 Tab 키로 들어오고 ← → 로 이웃 탭(디자인 검토 2026-10-03 · WAI-ARIA tabs 꼴)
  el.tabIndex = tab.active ? 0 : -1;
  el.setAttribute('aria-selected', String(tab.active));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const sibling = (e.key === 'ArrowLeft' ? el.previousElementSibling : el.nextElementSibling) as HTMLElement | null;
    const id = sibling?.dataset['tabId'];
    if (!id) return;
    e.preventDefault();
    sibling.focus({ preventScroll: true }); // 새 상태가 오면 upsertStrip 이 같은 id 탭에 포커스를 되돌린다
    send({ cmd: 'activateTab', tabId: id, keepShellFocus: true });
  });
  el.title = tab.title;
  el.querySelector<HTMLElement>('.tab-title')!.textContent = tab.title || (tab.kind === 'naver' ? '네이버' : '불러오는 중');
  const favicon = el.querySelector<HTMLImageElement>('.tab-favicon')!;
  const spinner = el.querySelector<HTMLElement>('.tab-spinner')!;
  if (tab.loading) spinner.hidden = false;
  else if (tab.favicon) {
    favicon.src = tab.favicon;
    favicon.hidden = false;
  }
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      send({ cmd: 'closeTab', tabId: tab.id });
    }
  });
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-close')) return;
    send({ cmd: 'activateTab', tabId: tab.id });
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      send({ cmd: 'closeTab', tabId: tab.id, keepShellFocus: true });
    }
  });
  // 닫기 단추는 Tab 순서에서 뺀다(탭 하나만 Tab 으로 들어오는 roving tabindex · 키보드는 Delete 로 닫는다)
  el.querySelector<HTMLButtonElement>('.tab-close')!.tabIndex = -1;
  el.addEventListener('pointerdown', (e) => beginTabDrag(e, tab.id, paneId));
  el.querySelector<HTMLButtonElement>('.tab-close')!.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ cmd: 'closeTab', tabId: tab.id });
  });
  return el;
}

function upsertStrip(pane: ShellState['panes'][number]): void {
  const strip = stripEls.get(pane.id) ?? createStrip(pane.id);
  strip.classList.toggle('pane-focused', pane.focused);
  place(strip, pane.stripRect);
  strip.querySelector<HTMLButtonElement>('.strip-back')!.disabled = !pane.canGoBack;
  strip.querySelector<HTMLButtonElement>('.strip-forward')!.disabled = !pane.canGoForward;
  strip.querySelector<HTMLButtonElement>('.strip-reload')!.disabled = !pane.tabs.some((t) => t.active);
  // 탭 목록은 통째로 — 드래그와 무관하고 수가 적다. 다만 키보드 포커스가 그 안에 있었으면 같은 탭(없으면 활성 탭)에 되돌린다
  // (제목 · 로딩 상태가 올 때마다 다시 그려 포커스가 body 로 빠지던 결함 · 검수 2026-10-03)
  const tabsEl = strip.querySelector<HTMLElement>('.strip-tabs')!;
  const focusedTabId = tabsEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>('.tab')?.dataset['tabId'] : undefined;
  tabsEl.replaceChildren(...pane.tabs.map((t) => renderTab(t, pane.id)));
  if (focusedTabId !== undefined) {
    (tabsEl.querySelector<HTMLElement>(`.tab[data-tab-id="${focusedTabId}"]`) ?? tabsEl.querySelector<HTMLElement>('.tab.active'))?.focus({ preventScroll: true });
  }
}

// ───────────────────────── sash(id 로 재사용 · 드래그) ─────────────────────────

function clampRatio(r: number): number {
  return Math.min(0.8, Math.max(0.2, r));
}

function sendResize(d: Drag, ratio: number): void {
  if (d.lastSent !== null && Math.abs(d.lastSent - ratio) < 0.002) return;
  d.lastSent = ratio;
  send({ cmd: 'resize', sashId: d.sashId, ratio });
}

function onSashPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  const sashId = el.dataset['sashId'];
  const sash = sashId ? sashData.get(sashId) : undefined;
  if (!sashId || !sash) return;
  e.preventDefault();
  const horizontal = sash.orientation === 'horizontal';
  drag = {
    sashId,
    pointerId: e.pointerId,
    orientation: sash.orientation,
    start: horizontal ? sash.splitRect.x : sash.splitRect.y,
    length: horizontal ? sash.splitRect.width : sash.splitRect.height,
    raf: null,
    pending: null,
    lastSent: null,
  };
  el.classList.add('dragging');
  document.body.classList.add(horizontal ? 'dragging-col' : 'dragging-row');
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // 캡처가 안 되어도 window 의 pointermove 로 받는다
  }
}

function onWindowPointerMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const pos = drag.orientation === 'horizontal' ? e.clientX : e.clientY;
  if (drag.length <= 0) return;
  drag.pending = clampRatio((pos - drag.start) / drag.length);
  if (drag.raf === null) {
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = null;
      if (drag.pending !== null) sendResize(drag, drag.pending);
      drag.pending = null;
    });
  }
}

function onWindowPointerEnd(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (d.raf !== null) cancelAnimationFrame(d.raf);
  if (d.pending !== null) sendResize(d, d.pending);
  const el = sashEls.get(d.sashId);
  el?.classList.remove('dragging');
  try {
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  } catch {
    // 이미 풀렸으면 그만
  }
  document.body.classList.remove('dragging-col', 'dragging-row');
}

function createSash(sashId: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset['sashId'] = sashId;
  el.addEventListener('pointerdown', onSashPointerDown);
  panesEl.appendChild(el);
  sashEls.set(sashId, el);
  return el;
}

function upsertSash(sash: SashGeometry): void {
  sashData.set(sash.id, sash);
  const el = sashEls.get(sash.id) ?? createSash(sash.id);
  el.className = `sash ${sash.orientation}${drag?.sashId === sash.id ? ' dragging' : ''}`;
  place(el, sash.rect);
}

window.addEventListener('pointermove', onWindowPointerMove);
window.addEventListener('pointerup', onWindowPointerEnd);
window.addEventListener('pointercancel', onWindowPointerEnd);

// ───────────────────────── «+» 메뉴 ─────────────────────────

const ADMIN_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
const NAVER_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 6.5 3.5 2.5h9l1 4M2.5 6.5h11v7h-11z"/><path d="M6.5 13.5v-4h3v4"/></svg>';


function openNewTabMenu(state: ShellState, paneId: string, anchor: DOMRect): void {
  menuEl.replaceChildren();
  for (const choice of state.newTabChoices) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    // 아이콘 · 이름 · (네이버만) 꼬리표 — 옛 «어드민» 꼬리표는 AI 채팅에도 붙어 틀렸다(디자인 검토 2026-10-03)
    item.innerHTML = `<span class="menu-ico">${choice.kind === 'naver' ? NAVER_ICON : ADMIN_ICON}</span><span>${escapeHtml(choice.label)}</span>${choice.kind === 'naver' ? '<span class="kind">네이버</span>' : ''}`;
    item.addEventListener('click', () => {
      closeMenu('pick');
      send({ cmd: 'newTab', paneId, kind: choice.kind, url: choice.url });
    });
    menuEl.appendChild(item);
  }
  layoutMenuEl.hidden = true;
  menuEl.style.left = px(Math.min(anchor.left, window.innerWidth - 240));
  menuEl.style.top = px(anchor.bottom + 4);
  menuEl.hidden = false;
  popupOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setPopupOpen(true);
  menuEl.querySelector<HTMLButtonElement>('.menu-item')?.focus();
}

// ───────────────────────── 레이아웃 고르기(제목줄 단추 하나) ─────────────────────────

/**
 * 메뉴의 «현재»(파란 점) · 끔/켬을 지금 상태에 맞춘다. 메뉴를 열 때만 맞추면 단축키로 바꾼 뒤 열려 있던 메뉴가 옛 표시로 남았다
 * (2026-10-04 사장님 «단축키로 변경하면 메뉴의 파랑 동그라미가 같이 변경이 안됨») — 상태가 올 때마다 render() 에서도 부른다.
 */
function syncLayoutMenu(): void {
  if (layoutMenuEl.hidden) return; // 닫혀 있으면 열 때(openLayoutMenu) 맞춘다 — 상태가 올 때마다 숨은 요소를 고치지 않는다(제미나이 검수)
  const focusedPreset = (document.activeElement as HTMLElement | null)?.dataset?.['preset'];
  // «현재» 표시는 pane 수가 아니라 모양 이름으로 — 수로 보면 2단 좌우 · 2단 상하가 둘 다 켜졌다(2026-10-04 사장님 버그 3)
  const current = lastState?.layoutPreset ?? null;
  const tabCount = (lastState?.panes ?? []).reduce((n, p) => n + p.tabs.length, 0);
  layoutMenuEl.querySelectorAll<HTMLButtonElement>('.layout-item').forEach((b) => {
    const on = b.dataset['preset'] === current;
    b.classList.toggle('current-preset', on);
    b.setAttribute('aria-checked', String(on));
    // 탭 수보다 창이 많은 모양은 끈다(엔진도 거절한다) — 툴팁으로 까닭
    const need = Number(b.dataset['count']);
    b.disabled = need > tabCount;
    b.title = b.disabled ? `탭이 ${need}개 있어야 합니다(지금 ${tabCount}개 · «+» 로 탭을 더 여세요)` : '';
  });
  // 포커스가 있던 항목이 꺼지면 포커스가 body 로 빠진다 — 켜진 «현재» 항목으로 옮긴다
  if (focusedPreset && layoutMenuEl.querySelector<HTMLButtonElement>(`.layout-item[data-preset="${focusedPreset}"]`)?.disabled) {
    layoutMenuEl.querySelector<HTMLButtonElement>('.layout-item.current-preset:not(:disabled), .layout-item:not(:disabled)')?.focus();
  }
}

function openLayoutMenu(): void {
  menuEl.hidden = true;
  const r = layoutButtonEl.getBoundingClientRect();
  layoutMenuEl.style.left = px(Math.max(8, Math.min(r.right - 220, window.innerWidth - 228)));
  layoutMenuEl.style.top = px(r.bottom + 6);
  layoutMenuEl.hidden = false;
  syncLayoutMenu(); // 연 «뒤에» — syncLayoutMenu 는 닫힌 메뉴를 건너뛴다
  popupOpener = layoutButtonEl;
  layoutButtonEl.setAttribute('aria-expanded', 'true');
  setPopupOpen(true);
  (layoutMenuEl.querySelector<HTMLButtonElement>('.layout-item.current-preset') ?? layoutMenuEl.querySelector<HTMLButtonElement>('.layout-item'))?.focus();
}

layoutButtonEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (layoutMenuEl.hidden) openLayoutMenu();
  else closeMenu('toggle');
});
layoutMenuEl.querySelectorAll<HTMLButtonElement>('.layout-item').forEach((b) => {
  b.addEventListener('click', () => {
    closeMenu('pick');
    send({ cmd: 'applyLayout', preset: b.dataset['preset'] as Extract<ShellCommand, { cmd: 'applyLayout' }>['preset'] });
  });
});

/**
 * 팝오버가 열린 동안만 셸 view 를 맨 위로 올린다(main 이 한다). 셸은 맨 아래 층이라, 안 올리면 탭 아래로 펼친 메뉴를
 * 어드민 · 네이버 view 가 덮는다(2026-10-03 사장님 «탭추가 버튼 작동 안됨» — smoke 는 JS 로 눌러 못 잡았다).
 * 셸 바탕은 투명이라 올려도 아래 페이지가 보인다.
 */
let popupOpen = false;
/** 메뉴를 연 단추 — Esc · 같은 단추로 닫으면 포커스를 여기로 돌려준다(검수 2026-10-03) */
let popupOpener: HTMLElement | null = null;
function setPopupOpen(open: boolean, refocusPage = false): void {
  if (popupOpen === open) return;
  popupOpen = open;
  send({ cmd: 'shell.popup', open, refocusPage });
}

/**
 * 닫는 까닭에 따라 포커스가 갈 곳이 다르다:
 * 'pick'(항목 고름) · 'outside'(페이지 자리를 누름) → 페이지 view 로(main 이 돌려준다)
 * 'escape' · 'toggle'(같은 단추) → 메뉴를 연 단추로(키보드로 열고 닫은 사람이 제자리에 남게)
 */
function closeMenu(how: 'pick' | 'outside' | 'escape' | 'toggle' = 'outside'): void {
  const wasOpen = popupOpen;
  menuEl.hidden = true;
  layoutMenuEl.hidden = true;
  layoutButtonEl.setAttribute('aria-expanded', 'false');
  const backToOpener = how === 'escape' || how === 'toggle';
  setPopupOpen(false, !backToOpener);
  if (wasOpen && backToOpener) popupOpener?.focus();
  popupOpener = null;
}

// ───────────────────────── 업데이트 모달(G03) ─────────────────────────

function renderUpdate(state: ShellState): void {
  const u = state.update;
  const show = u.state === 'available' || u.state === 'downloading' || u.state === 'ready' || u.state === 'required' || u.state === 'error';
  modalEl.hidden = !show;
  if (!show) return;
  const title = $<HTMLElement>('#update-title');
  const text = $<HTMLElement>('#update-text');
  const progress = $<HTMLElement>('#update-progress');
  const bar = $<HTMLElement>('#update-bar');
  const primary = $<HTMLButtonElement>('#update-primary');
  const secondary = $<HTMLButtonElement>('#update-secondary');
  progress.hidden = u.state !== 'downloading';
  secondary.hidden = u.state === 'required' || u.state === 'downloading';
  primary.hidden = u.state === 'downloading';
  const mb = u.size ? ` · ${(u.size / 1024 / 1024).toFixed(1)} MB` : '';
  switch (u.state) {
    case 'available':
      title.textContent = `새 판 ${u.version ?? ''}`;
      text.textContent = `업데이트를 받을까요?${mb}`;
      primary.textContent = '지금 업데이트';
      primary.onclick = () => send({ cmd: 'update.download' });
      secondary.textContent = '나중에';
      secondary.onclick = () => send({ cmd: 'update.later' });
      break;
    case 'required':
      title.textContent = '업데이트가 필요합니다';
      text.textContent = `서버가 이 판을 더 받지 않습니다. 새 판 ${u.version ?? ''}${mb} 을 받아야 계속 쓸 수 있습니다.`;
      primary.textContent = '지금 업데이트';
      primary.onclick = () => send({ cmd: 'update.download' });
      break;
    case 'downloading':
      title.textContent = '받는 중';
      text.textContent = `${Math.round(u.percent ?? 0)}%`;
      bar.style.width = `${Math.round(u.percent ?? 0)}%`;
      break;
    case 'ready':
      title.textContent = '받았습니다';
      text.textContent = '설치하고 다시 시작합니다.';
      primary.textContent = '설치 후 재시작';
      primary.onclick = () => send({ cmd: 'update.install' });
      secondary.textContent = '다음 실행 때';
      secondary.onclick = () => send({ cmd: 'update.later' });
      break;
    case 'error':
      title.textContent = '업데이트 실패';
      text.textContent = u.message ?? '';
      primary.textContent = '닫기';
      primary.onclick = () => send({ cmd: 'update.later' });
      secondary.hidden = true;
      break;
    default:
      break;
  }
}

// ───────────────────────── 그리기(id 로 재사용 · 없어진 것만 지움) ─────────────────────────

// ───────────────────────── 탭 끌기(U04 · 2026-10-04 사장님 «창 사이 탭 드래그 이동이 안됨») ─────────────────────────
// 끌기가 시작되면 셸 view 를 맨 위로 올린다(팝오버와 같은 길 · 셸 바탕은 투명) — 안 올리면 포인터가 페이지 view 위로 가는 순간
// 셸이 이벤트를 못 받는다. 놓을 곳: 다른(또는 같은) pane 의 탭 줄 → 그 자리 · pane 의 화면 → 그 pane 맨 끝.
// 마지막 탭을 옮기면 빈 pane 은 닫힌다(LayoutEngine.moveTab → removePane).

interface TabDrag {
  tabId: string;
  fromPaneId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  title: string;
}
const TAB_DRAG_THRESHOLD = 6;
let tabDrag: TabDrag | null = null;
/** 끌기 기록(최근 30) — smoke 가 실패할 때만 읽는다(진단) */
const tabDragLog: string[] = [];
(window as unknown as { __tabDragLog: string[] }).__tabDragLog = tabDragLog;
function noteDrag(s: string): void {
  tabDragLog.push(s);
  if (tabDragLog.length > 30) tabDragLog.shift();
}
const dragGhostEl = document.createElement('div');
dragGhostEl.className = 'tab-drag-ghost';
dragGhostEl.hidden = true;
const dropMarkerEl = document.createElement('div');
dropMarkerEl.className = 'tab-drop-marker';
dropMarkerEl.hidden = true;
document.body.append(dropMarkerEl, dragGhostEl);

interface DropTarget {
  paneId: string;
  index: number | undefined;
  /** 표시 자리 — 탭 줄이면 세로 막대, 화면이면 pane 화면 전체 */
  rect: { x: number; y: number; width: number; height: number };
}

function beginTabDrag(e: PointerEvent, tabId: string, paneId: string): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return;
  // 브라우저 자체의 끌어다 놓기(네이티브 drag)를 막는다 — 안 막으면 움직이자마자 pointercancel 이 와서 끌기가 끊겼다(2026-10-04 smoke 실측)
  e.preventDefault();
  const title = (e.currentTarget as HTMLElement).querySelector('.tab-title')?.textContent ?? '';
  tabDrag = { tabId, fromPaneId: paneId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, title };
  noteDrag(`down ${tabId.slice(0, 6)} ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
}

function findDropTarget(x: number, y: number, tabId: string): DropTarget | null {
  for (const pane of lastState?.panes ?? []) {
    const s = pane.stripRect;
    if (x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height) {
      // 끄는 탭을 뺀 나머지 탭의 가운데 점보다 오른쪽에 있으면 그 뒤로
      const all = [...(stripEls.get(pane.id)?.querySelectorAll<HTMLElement>('.tab') ?? [])];
      // 끄는 탭의 원래 자리 위면 «제자리» — 표시도 그 탭 왼쪽에(제미나이 검수 2026-10-04 · 표시가 마우스를 안 따라오던 것)
      const own = all.find((t) => t.dataset['tabId'] === tabId);
      if (own) {
        const r = own.getBoundingClientRect();
        // 표시 막대는 탭 가운데를 기준으로 왼쪽/오른쪽 끝에(마우스를 따라오게 · 제미나이 재검수) — 놓으면 어느 쪽이든 제자리
        if (x >= r.left && x < r.right) return { paneId: pane.id, index: all.indexOf(own), rect: { x: (x < r.left + r.width / 2 ? r.left : r.right) - 1, y: s.y + 6, width: 3, height: s.height - 6 } };
      }
      const tabs = all.filter((t) => t.dataset['tabId'] !== tabId);
      let index = 0;
      let barX = s.x + 8;
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        if (x > r.left + r.width / 2) {
          index += 1;
          barX = r.right;
        } else {
          if (index === 0 || barX === s.x + 8) barX = r.left;
          break;
        }
      }
      return { paneId: pane.id, index, rect: { x: barX - 1, y: s.y + 6, width: 3, height: s.height - 6 } };
    }
    const c = pane.contentRect;
    if (x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height) {
      return { paneId: pane.id, index: undefined, rect: c };
    }
  }
  return null;
}

function onTabDragMove(e: PointerEvent): void {
  const d = tabDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.active) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < TAB_DRAG_THRESHOLD) return;
    d.active = true;
    // 포인터를 탭 줄(다시 그려도 그대로인 요소)에 묶는다 — 빠르게 끌어 페이지 위로 나가도 셸이 이벤트를 받게(제미나이 검수 2026-10-04)
    try {
      stripEls.get(d.fromPaneId)?.querySelector<HTMLElement>('.strip-tabs')?.setPointerCapture(d.pointerId);
    } catch {
      // 캡처가 안 되어도 셸이 맨 위로 올라가 window 가 받는다
    }
    noteDrag(`active ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
    dragGhostEl.textContent = d.title;
    dragGhostEl.hidden = false;
    document.body.classList.add('dragging-tab');
    // 메뉴가 열린 채 끌면 메뉴 요소가 화면에 남아 닫을 길이 없었다(검수 2026-10-04) — 요소만 닫는다(IPC 는 바로 아래 한 번)
    menuEl.hidden = true;
    layoutMenuEl.hidden = true;
    layoutButtonEl.setAttribute('aria-expanded', 'false');
    popupOpener = null;
    setPopupOpen(true); // 셸을 맨 위로 — 페이지 위에서도 포인터를 받고, 놓을 자리 표시가 페이지 위에 보인다
  }
  dragGhostEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
  const target = findDropTarget(e.clientX, e.clientY, d.tabId);
  dropMarkerEl.hidden = target === null;
  if (target) {
    place(dropMarkerEl, target.rect);
    dropMarkerEl.classList.toggle('tab-drop-marker--content', target.index === undefined);
  }
}

function endTabDrag(e: PointerEvent | null, cancel: boolean): void {
  const d = tabDrag;
  noteDrag(`end ${e?.type ?? 'esc'} d=${d ? String(d.active) : 'none'}${e ? ` ${Math.round(e.clientX)},${Math.round(e.clientY)}` : ''}`);
  if (!d || (e && e.pointerId !== d.pointerId)) return;
  tabDrag = null;
  if (!d.active) return; // 끌지 않은 클릭 — 평소 click(activateTab) 그대로
  // Esc 로 취소하면 pointerup 이 아직 안 왔다 — 탭 줄에 걸어 둔 포인터 캡처를 풀어 준다(제미나이 재검수 2026-10-04)
  const captureEl = stripEls.get(d.fromPaneId)?.querySelector<HTMLElement>('.strip-tabs');
  try {
    if (captureEl?.hasPointerCapture(d.pointerId)) captureEl.releasePointerCapture(d.pointerId);
  } catch {
    // 이미 풀렸으면 그만
  }
  dragGhostEl.hidden = true;
  dropMarkerEl.hidden = true;
  document.body.classList.remove('dragging-tab');
  const target = !cancel && e ? findDropTarget(e.clientX, e.clientY, d.tabId) : null;
  noteDrag(`target ${target ? target.paneId.slice(0, 8) + ' i=' + String(target.index) : 'none'}`);
  // moveTab 을 먼저 — 그래야 셸을 내릴 때 돌려주는 포커스가 «옮겨 간» pane 으로 간다(검수 2026-10-04)
  if (target) {
    send(target.index === undefined
      ? { cmd: 'moveTab', tabId: d.tabId, toPaneId: target.paneId }
      : { cmd: 'moveTab', tabId: d.tabId, toPaneId: target.paneId, index: target.index });
  }
  setPopupOpen(false, target !== null);
  // 끈 뒤 따라오는 click 이 원래 탭을 다시 고르지 않게 한 번 막는다
  // (같은 이벤트 차례의 click 만 — 다음 틱에 풀어 다른 click 을 삼키지 않는다)
  const swallow = (ev: MouseEvent): void => ev.stopPropagation();
  window.addEventListener('click', swallow, { capture: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

window.addEventListener('pointermove', onTabDragMove);
window.addEventListener('pointerup', (e) => endTabDrag(e, false));
window.addEventListener('pointercancel', (e) => endTabDrag(e, true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tabDrag?.active) endTabDrag(null, true);
}, { capture: true });

function render(state: ShellState): void {
  lastState = state;
  const hadTabFocus = !!(document.activeElement as HTMLElement | null)?.closest?.('.tab');
  renderTitle(state);
  syncLayoutMenu();

  const paneIds = new Set(state.panes.map((p) => p.id));
  for (const [id, el] of stripEls) {
    if (!paneIds.has(id)) {
      el.remove();
      stripEls.delete(id);
    }
  }
  for (const pane of state.panes) upsertStrip(pane);

  const sashIds = new Set(state.sashes.map((s) => s.id));
  for (const [id, el] of sashEls) {
    if (!sashIds.has(id)) {
      el.remove();
      sashEls.delete(id);
      sashData.delete(id);
    }
  }
  for (const sash of state.sashes) upsertSash(sash);

  renderUpdate(state);
  // Delete 로 pane 의 마지막 탭을 닫으면 그 스트립째 사라진다 — 포커스 pane 의 활성 탭으로 옮긴다
  if (hadTabFocus && !(document.activeElement as HTMLElement | null)?.closest?.('.tab')) {
    document.querySelector<HTMLElement>('.strip.pane-focused .tab.active')?.focus({ preventScroll: true });
  }
}

document.addEventListener('click', (e) => {
  const target = e.target as Node;
  if (!popupOpen) return;
  if (!menuEl.hidden && menuEl.contains(target)) return;
  if (!layoutMenuEl.hidden && layoutMenuEl.contains(target)) return;
  closeMenu();
});
// 메뉴가 열린 채 창 크기가 바뀌면 메뉴는 옛 좌표에 남는다 — 닫는다
window.addEventListener('resize', () => {
  if (popupOpen) closeMenu('toggle'); // 창 크기 바뀜은 사람이 페이지를 고른 것이 아니다 — 연 단추로 돌려준다
});
document.addEventListener('keydown', (e) => {
  // 열린 메뉴 안 ↑ ↓ Home End(디자인 검토 2026-10-03 · 키보드만으로 고르기)
  const openMenu = !menuEl.hidden ? menuEl : !layoutMenuEl.hidden ? layoutMenuEl : null;
  if (openMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    const items = [...openMenu.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')]; // 꺼진 항목은 건너뛴다(제미나이 검수)
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
      : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && popupOpen) closeMenu('escape');
});
document.querySelectorAll<HTMLButtonElement>('#window-controls .wc').forEach((b) => {
  b.addEventListener('click', () => send({ cmd: b.dataset['cmd'] as ShellCommand['cmd'] } as ShellCommand));
});

/** 개발용 — hubShell 이 없을 때(브라우저로 그냥 열었을 때) 시안과 같은 가짜 상태로 그린다 */
function renderDemo(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = Math.round((w - 4) * 0.55);
  const demo: ShellState = {
    panes: [
      {
        id: 'p1', focused: true, aiTask: null, splitAllowed: true, canGoBack: true, canGoForward: false,
        stripRect: { x: 0, y: 40, width: left, height: 40 },
        contentRect: { x: 0, y: 80, width: left, height: h - 80 },
        tabs: [
          { id: 't1', kind: 'admin', title: 'Marktplatz-Produkte', favicon: null, loading: false, active: true },
          { id: 't2', kind: 'admin', title: 'Produkt · SW10001', favicon: null, loading: false, active: false },
        ],
      },
      {
        id: 'p2', focused: false, aiTask: null, splitAllowed: true, canGoBack: false, canGoForward: false,
        stripRect: { x: left + 4, y: 40, width: w - left - 4, height: 40 },
        contentRect: { x: left + 4, y: 80, width: w - left - 4, height: h - 80 },
        tabs: [{ id: 't3', kind: 'naver', title: '스마트스토어센터 · 상품 목록', favicon: null, loading: true, active: true }],
      },
    ],
    sashes: [{ id: 's1', splitId: 's1', orientation: 'horizontal', rect: { x: left, y: 40, width: 4, height: h - 40 }, splitRect: { x: 0, y: 40, width: w, height: h - 40 } }],
    paneCount: 2, layoutPreset: 'columns2', maxPanes: 4, focusedPaneId: 'p1',
    update: { state: 'none' }, serverHost: 'demo.local', platform: 'win32',
    window: { width: w, height: h, maximized: false },
    newTabChoices: [{ label: '대시보드', kind: 'admin', url: 'about:blank' }],
  };
  render(demo);
}

if (window.hubShell) {
  window.hubShell.onState(render);
} else {
  renderDemo();
  window.addEventListener('resize', renderDemo);
}

export { lastState };
