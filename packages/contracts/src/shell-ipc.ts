// U01 · U03 — 셸 페이지 ↔ main 의 IPC. 채널은 이 둘(+덮개 셋)뿐이다. 서버 페이지에는 IPC 가 없다.
import type { Orientation, Rect, SashGeometry, TabKind } from './layout.js';
import type { UpdateState } from './update.js';

export const SHELL_IPC = {
  /** 셸 → main · ShellCommand */
  cmd: 'shell:cmd',
  /** main → 셸 · ShellState (바뀔 때마다 통째로) */
  state: 'shell:state',
} as const;

export const OVERLAY_IPC = {
  /** main → 덮개 · { x, y } (sendInputEvent 에 넣는 바로 그 점 · U07 ⑥) */
  cursor: 'overlay:cursor',
  /** main → 덮개 · AiTaskBand | null */
  band: 'overlay:band',
  /** 덮개 → main · { cmd: 'aiTaskStop', paneId } */
  cmd: 'overlay:cmd',
} as const;

export type ShellCommand =
  | { cmd: 'split'; paneId: string; orientation: Orientation }
  | { cmd: 'closePane'; paneId: string }
  | { cmd: 'moveTab'; tabId: string; toPaneId: string; index?: number }
  | { cmd: 'reorderTab'; tabId: string; index: number }
  | { cmd: 'focusPane'; paneId: string }
  | { cmd: 'resize'; sashId: string; ratio: number }
  | { cmd: 'newTab'; paneId: string; kind?: TabKind; url?: string }
  | { cmd: 'closeTab'; tabId: string }
  | { cmd: 'activateTab'; tabId: string }
  | { cmd: 'reloadTab'; tabId: string }
  | { cmd: 'aiTaskStop'; paneId: string }
  | { cmd: 'update.download' }
  | { cmd: 'update.install' }
  | { cmd: 'update.later' }
  | { cmd: 'window.minimize' }
  | { cmd: 'window.toggleMaximize' }
  | { cmd: 'window.close' };

export interface AiTaskBand {
  paneId: string;
  taskId: string;
  title: string;
  step: number;
  steps: number;
}

export interface ShellTabView {
  id: string;
  kind: TabKind;
  title: string;
  favicon: string | null;
  loading: boolean;
  active: boolean;
}

export interface ShellPaneView {
  id: string;
  stripRect: Rect;
  contentRect: Rect;
  tabs: ShellTabView[];
  focused: boolean;
  aiTask: AiTaskBand | null;
  /** pane 수가 상한이면 false — 셸이 split 단추를 끈다 */
  splitAllowed: boolean;
}

export interface ShellState {
  panes: ShellPaneView[];
  sashes: SashGeometry[];
  paneCount: number;
  maxPanes: number;
  focusedPaneId: string | null;
  update: UpdateState;
  serverHost: string;
  platform: 'win32' | 'darwin' | 'linux';
  window: { width: number; height: number; maximized: boolean };
  /** «+» 메뉴 항목 — 서버 어드민 라우트(대시보드 · AI 채팅 · 네이버 등) */
  newTabChoices: Array<{ label: string; kind: TabKind; url: string }>;
}

/** 셸 preload 가 contextBridge 로 노출하는 것 — 이 둘뿐(U01) */
export interface HubShellApi {
  send(cmd: ShellCommand): void;
  onState(cb: (state: ShellState) => void): () => void;
}

/** 덮개 preload 가 노출하는 것 — 셋뿐(U07 ⑥) */
export interface HubOverlayApi {
  onCursor(cb: (p: { x: number; y: number } | null) => void): () => void;
  onBand(cb: (band: AiTaskBand | null) => void): () => void;
  stop(paneId: string): void;
}

declare global {
  interface Window {
    hubShell?: HubShellApi;
    hubOverlay?: HubOverlayApi;
  }
}
