// U01 — 셸 페이지. 상태(ShellState)가 정본 · 받을 때마다 통째로 다시 그린다. window.hubShell 만 쓴다(Node · electron 없음).
import type { ShellCommand, ShellState } from '@cmh-hub-app/contracts';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`셸 요소 없음: ${sel}`);
  return el;
};

const panesEl = $<HTMLElement>('#panes');
const tabTemplate = $<HTMLTemplateElement>('#tab-template');
const stripTemplate = $<HTMLTemplateElement>('#strip-template');
const menuEl = $<HTMLElement>('#newtab-menu');
const modalEl = $<HTMLElement>('#update-modal');

let lastState: ShellState | null = null;
let dragging: { sashId: string; orientation: 'horizontal' | 'vertical'; start: number; length: number; raf: number | null; pending: number | null } | null = null;

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

function renderTitle(state: ShellState): void {
  $<HTMLElement>('#server-host').textContent = `· ${state.serverHost}`;
  $<HTMLElement>('#pane-count').textContent = `pane ${state.paneCount} / ${state.maxPanes}`;
  $<HTMLElement>('#update-dot').hidden = !(state.update.state === 'available' || state.update.state === 'ready' || state.update.state === 'required');
  $<HTMLElement>('#window-controls').hidden = state.platform !== 'linux';
}

function renderStrip(state: ShellState, pane: ShellState['panes'][number]): HTMLElement {
  const strip = (stripTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  strip.dataset['paneId'] = pane.id;
  strip.classList.toggle('pane-focused', pane.focused);
  place(strip, pane.stripRect);

  const tabsEl = strip.querySelector<HTMLElement>('.strip-tabs')!;
  for (const tab of pane.tabs) {
    const el = (tabTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    el.dataset['tabId'] = tab.id;
    el.classList.toggle('active', tab.active);
    el.title = tab.title;
    el.querySelector<HTMLElement>('.tab-title')!.textContent = tab.title || (tab.kind === 'naver' ? '네이버' : '불러오는 중');
    const favicon = el.querySelector<HTMLImageElement>('.tab-favicon')!;
    const spinner = el.querySelector<HTMLElement>('.tab-spinner')!;
    if (tab.loading) {
      spinner.hidden = false;
    } else if (tab.favicon) {
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
    tabsEl.appendChild(el);
  }

  const newTabBtn = strip.querySelector<HTMLButtonElement>('.strip-newtab')!;
  newTabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openNewTabMenu(state, pane.id, newTabBtn.getBoundingClientRect());
  });
  const splitRight = strip.querySelector<HTMLButtonElement>('.strip-split-right')!;
  const splitDown = strip.querySelector<HTMLButtonElement>('.strip-split-down')!;
  splitRight.disabled = !pane.splitAllowed;
  splitDown.disabled = !pane.splitAllowed;
  splitRight.addEventListener('click', () => send({ cmd: 'split', paneId: pane.id, orientation: 'horizontal' }));
  splitDown.addEventListener('click', () => send({ cmd: 'split', paneId: pane.id, orientation: 'vertical' }));
  strip.addEventListener('mousedown', () => {
    if (!pane.focused) send({ cmd: 'focusPane', paneId: pane.id });
  });
  return strip;
}

function renderSash(sash: ShellState['sashes'][number]): HTMLElement {
  const el = document.createElement('div');
  el.className = `sash ${sash.orientation}`;
  el.dataset['sashId'] = sash.id;
  place(el, sash.rect);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const horizontal = sash.orientation === 'horizontal';
    dragging = {
      sashId: sash.id,
      orientation: sash.orientation,
      start: horizontal ? sash.splitRect.x : sash.splitRect.y,
      length: horizontal ? sash.splitRect.width : sash.splitRect.height,
      raf: null,
      pending: null,
    };
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.sashId !== sash.id) return;
    const pos = dragging.orientation === 'horizontal' ? e.clientX : e.clientY;
    const ratio = Math.min(0.8, Math.max(0.2, (pos - dragging.start) / dragging.length));
    dragging.pending = ratio;
    if (dragging.raf === null) {
      dragging.raf = requestAnimationFrame(() => {
        if (!dragging) return;
        dragging.raf = null;
        if (dragging.pending !== null) send({ cmd: 'resize', sashId: dragging.sashId, ratio: dragging.pending });
        dragging.pending = null;
      });
    }
  });
  const end = (e: PointerEvent): void => {
    if (!dragging || dragging.sashId !== sash.id) return;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (dragging.pending !== null) send({ cmd: 'resize', sashId: dragging.sashId, ratio: dragging.pending });
    dragging = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return el;
}

function openNewTabMenu(state: ShellState, paneId: string, anchor: DOMRect): void {
  menuEl.replaceChildren();
  for (const choice of state.newTabChoices) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `${escapeHtml(choice.label)}<span class="kind">${choice.kind === 'naver' ? '네이버' : '어드민'}</span>`;
    item.addEventListener('click', () => {
      closeMenu();
      send({ cmd: 'newTab', paneId, kind: choice.kind, url: choice.url });
    });
    menuEl.appendChild(item);
  }
  menuEl.style.left = px(Math.min(anchor.left, window.innerWidth - 240));
  menuEl.style.top = px(anchor.bottom + 4);
  menuEl.hidden = false;
}

function closeMenu(): void {
  menuEl.hidden = true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

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

function render(state: ShellState): void {
  lastState = state;
  renderTitle(state);
  const nodes: HTMLElement[] = [];
  for (const pane of state.panes) nodes.push(renderStrip(state, pane));
  for (const sash of state.sashes) nodes.push(renderSash(sash));
  panesEl.replaceChildren(...nodes);
  renderUpdate(state);
}

document.addEventListener('click', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target as Node)) closeMenu();
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
