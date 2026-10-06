// U01 · U03 — 셸 페이지 ↔ main 의 IPC. 채널은 이 둘(+덮개 셋)뿐이다. 서버 페이지에는 IPC 가 없다.
import type { LayoutPreset, Orientation, Rect, SashGeometry, TabKind } from './layout.js';
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
  | { cmd: 'applyLayout'; preset: LayoutPreset }
  /** 셸 팝오버(«+» · 레이아웃 메뉴)가 열린 동안 셸 view 를 맨 위로 — 아니면 어드민 view 가 메뉴를 덮는다(2026-10-03 «탭추가 버튼 작동 안됨») */
  | { cmd: 'shell.popup'; open: boolean; /** 닫을 때 키보드 포커스를 페이지 view 로 돌려줄까(Esc 로 닫으면 false · 셸 단추에 남는다) */ refocusPage?: boolean }
  | { cmd: 'closePane'; paneId: string }
  | { cmd: 'moveTab'; tabId: string; toPaneId: string; index?: number }
  | { cmd: 'reorderTab'; tabId: string; index: number }
  /** keepShellFocus — 빈 탭 주소창을 눌러 pane 을 바꿀 때 키보드 포커스를 셸(주소창)에 둔다 */
  | { cmd: 'focusPane'; paneId: string; keepShellFocus?: boolean }
  | { cmd: 'resize'; sashId: string; ratio: number }
  | { cmd: 'newTab'; paneId: string; kind?: TabKind; url?: string }
  /** keepShellFocus — 셸 키보드(← → · Delete)로 보낸 것. main 이 키보드 포커스를 페이지로 옮기지 않는다(검수 2026-10-03) */
  | { cmd: 'closeTab'; tabId: string; keepShellFocus?: boolean }
  | { cmd: 'activateTab'; tabId: string; keepShellFocus?: boolean }
  | { cmd: 'reloadTab'; tabId: string }
  /** 탭 줄 왼쪽 뒤로 · 앞으로 · 새로고침 단추(2026-10-05 사장님 «크롬처럼 refresh, 앞으로, 뒤로 버튼이 없어») */
  | { cmd: 'navigate'; tabId: string; action: 'back' | 'forward' | 'reload' }
  /** 빈 탭 주소창에서 Enter — 주소면 그리로 · 아니면 검색(main 의 resolveOmniboxInput 이 가른다) */
  | { cmd: 'omnibox'; tabId: string; text: string }
  | { cmd: 'aiTaskStop'; paneId: string }
  | { cmd: 'update.download' }
  | { cmd: 'update.install' }
  | { cmd: 'update.later' }
  | { cmd: 'window.minimize' }
  | { cmd: 'window.toggleMaximize' }
  | { cmd: 'window.close' }
  /** 개발자 도구 너비 조절 — ratio = 개발자 도구 칸 너비 / pane 내용 너비 */
  | { cmd: 'devtools.resize'; tabId: string; ratio: number }
  /** 개발자 도구 닫기 */
  | { cmd: 'devtools.close'; tabId: string };

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

export interface ShellDevToolsView {
  tabId: string;
  sashRect: Rect;
  headerRect: Rect;
  paneContentRect: Rect;
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
  /** 활성 탭의 방문 기록 — 뒤로 · 앞으로 단추를 켜고 끈다 */
  canGoBack: boolean;
  canGoForward: boolean;
  /** 활성 탭이 빈 탭(web)일 때 그 주소 — 셸이 주소창을 보이고 채운다 · 다른 종류면 null(주소창 없음) */
  omniboxUrl: string | null;
  /** 활성 탭의 개발자 도구가 열려 있으면 셸이 경계선 · 머리줄을 그린다 */
  devtools: ShellDevToolsView | null;
}

export interface ShellState {
  panes: ShellPaneView[];
  sashes: SashGeometry[];
  paneCount: number;
  /** 지금 트리가 어느 레이아웃 고르기 모양인가(sash 비율은 안 본다) · 손으로 만든 다른 모양이면 null — 셸 메뉴의 «현재» 표시(2026-10-04 «2단 좌우 · 상하 둘 다 표시됨») */
  layoutPreset: LayoutPreset | null;
  maxPanes: number;
  focusedPaneId: string | null;
  update: UpdateState;
  serverHost: string;
  platform: 'win32' | 'darwin' | 'linux';
  window: { width: number; height: number; maximized: boolean };
  /** «+» 메뉴 항목 — 서버 어드민 라우트(대시보드 · AI 채팅 · 네이버 등) */
  newTabChoices: Array<{ label: string; kind: TabKind; url: string }>;
  /** 방금 만든 빈 탭의 pane — 셸이 그 주소창에 키보드 포커스를 준다(한 번만 · 다음 상태에서는 null) */
  focusOmniboxPaneId: string | null;
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
