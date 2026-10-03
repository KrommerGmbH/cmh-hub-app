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
  $<HTMLElement>('#pane-count').textContent = `pane ${state.paneCount} / ${state.maxPanes}`;
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
  strip.addEventListener('mousedown', () => {
    const pane = lastState?.panes.find((p) => p.id === paneId);
    if (pane && !pane.focused) send({ cmd: 'focusPane', paneId });
  });
  panesEl.appendChild(strip);
  stripEls.set(paneId, strip);
  return strip;
}

function renderTab(tab: ShellState['panes'][number]['tabs'][number]): HTMLElement {
  const el = (tabTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.dataset['tabId'] = tab.id;
  el.classList.toggle('active', tab.active);
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
  // 탭 목록은 통째로 — 드래그와 무관하고 수가 적다
  strip.querySelector<HTMLElement>('.strip-tabs')!.replaceChildren(...pane.tabs.map(renderTab));
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
      closeMenu();
      send({ cmd: 'newTab', paneId, kind: choice.kind, url: choice.url });
    });
    menuEl.appendChild(item);
  }
  layoutMenuEl.hidden = true;
  menuEl.style.left = px(Math.min(anchor.left, window.innerWidth - 240));
  menuEl.style.top = px(anchor.bottom + 4);
  menuEl.hidden = false;
  setPopupOpen(true);
}

// ───────────────────────── 레이아웃 고르기(제목줄 단추 하나) ─────────────────────────

function openLayoutMenu(): void {
  menuEl.hidden = true;
  const r = layoutButtonEl.getBoundingClientRect();
  layoutMenuEl.style.left = px(Math.max(8, Math.min(r.right - 220, window.innerWidth - 228)));
  layoutMenuEl.style.top = px(r.bottom + 6);
  const current = lastState?.paneCount ?? 1;
  layoutMenuEl.querySelectorAll<HTMLButtonElement>('.layout-item').forEach((b) => b.classList.toggle('current-count', Number(b.dataset['count']) === current));
  layoutMenuEl.hidden = false;
  layoutButtonEl.setAttribute('aria-expanded', 'true');
  setPopupOpen(true);
}

layoutButtonEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (layoutMenuEl.hidden) openLayoutMenu();
  else closeMenu();
});
layoutMenuEl.querySelectorAll<HTMLButtonElement>('.layout-item').forEach((b) => {
  b.addEventListener('click', () => {
    closeMenu();
    send({ cmd: 'applyLayout', preset: b.dataset['preset'] as Extract<ShellCommand, { cmd: 'applyLayout' }>['preset'] });
  });
});

/**
 * 팝오버가 열린 동안만 셸 view 를 맨 위로 올린다(main 이 한다). 셸은 맨 아래 층이라, 안 올리면 탭 아래로 펼친 메뉴를
 * 어드민 · 네이버 view 가 덮는다(2026-10-03 사장님 «탭추가 버튼 작동 안됨» — smoke 는 JS 로 눌러 못 잡았다).
 * 셸 바탕은 투명이라 올려도 아래 페이지가 보인다.
 */
let popupOpen = false;
function setPopupOpen(open: boolean): void {
  if (popupOpen === open) return;
  popupOpen = open;
  send({ cmd: 'shell.popup', open });
}

function closeMenu(): void {
  menuEl.hidden = true;
  layoutMenuEl.hidden = true;
  layoutButtonEl.setAttribute('aria-expanded', 'false');
  setPopupOpen(false);
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

function render(state: ShellState): void {
  lastState = state;
  renderTitle(state);

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
  if (popupOpen) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
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
        id: 'p1', focused: true, aiTask: null, splitAllowed: true,
        stripRect: { x: 0, y: 40, width: left, height: 40 },
        contentRect: { x: 0, y: 80, width: left, height: h - 80 },
        tabs: [
          { id: 't1', kind: 'admin', title: 'Marktplatz-Produkte', favicon: null, loading: false, active: true },
          { id: 't2', kind: 'admin', title: 'Produkt · SW10001', favicon: null, loading: false, active: false },
        ],
      },
      {
        id: 'p2', focused: false, aiTask: null, splitAllowed: true,
        stripRect: { x: left + 4, y: 40, width: w - left - 4, height: 40 },
        contentRect: { x: left + 4, y: 80, width: w - left - 4, height: h - 80 },
        tabs: [{ id: 't3', kind: 'naver', title: '스마트스토어센터 · 상품 목록', favicon: null, loading: true, active: true }],
      },
    ],
    sashes: [{ id: 's1', splitId: 's1', orientation: 'horizontal', rect: { x: left, y: 40, width: 4, height: h - 40 }, splitRect: { x: 0, y: 40, width: w, height: h - 40 } }],
    paneCount: 2, maxPanes: 4, focusedPaneId: 'p1',
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
