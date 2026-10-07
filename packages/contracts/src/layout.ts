// U02 — 레이아웃 트리(정본은 main 의 LayoutEngine). 셸은 이 모양을 받아 그리기만 한다.

export type Orientation = 'horizontal' | 'vertical'; // horizontal = 좌우로 나눔(Ctrl+\) · vertical = 상하

/**
 * 레이아웃 고르기(2026-10-03 사장님 «split 아이콘 하나로 · 2단 가로 · 2단 세로 · 3단 위 가로 아래 솔로 · 4단»).
 * single = pane 1 · columns2 = 좌우 2 · rows2 = 상하 2 · top2bottom1 = 위 좌우 2 + 아래 1 · top1bottom2 = 위 1 + 아래 좌우 2(2026-10-04) · left2right1 = 왼쪽 위아래 2 + 오른쪽 1 · left1right2 = 왼쪽 1 + 오른쪽 위아래 2(2026-10-04) · grid4 = 2×2
 */
export type LayoutPreset = 'single' | 'columns2' | 'rows2' | 'top2bottom1' | 'top1bottom2' | 'left2right1' | 'left1right2' | 'grid4';

/**
 * 메뉴 차례 = 단축키 숫자(Ctrl+Shift+1 … 8 · 2026-10-04 사장님 «모든 split view 단축키 · 아이콘 옆에»).
 * 셸 index.html 의 메뉴 항목 차례와 같아야 한다(layout.test.ts 가 맞춘다).
 */
export const LAYOUT_PRESET_ORDER: readonly LayoutPreset[] = ['single', 'columns2', 'rows2', 'top2bottom1', 'top1bottom2', 'left2right1', 'left1right2', 'grid4'];

export const LAYOUT_PRESET_PANES: Readonly<Record<LayoutPreset, number>> = { single: 1, columns2: 2, rows2: 2, top2bottom1: 3, top1bottom2: 3, left2right1: 3, left1right2: 3, grid4: 4 };

/**
 * 탭 종류 — admin · naver · web 셋은 preload 0. 지금 챗봇은 admin 탭(cmh-ai-chat 라우트). PLAN U02 · U06.
 * web = 빈 탭(2026-10-05 사장님 «빈 탭 · url 넣고 크롬처럼 검색») — 주소창이 있고 아무 http(s) 로 간다 · 저장 공간(persist:web)이 따로라 어드민 · 네이버 로그인 쿠키 · 저장된 계정을 안 쓴다.
 * chat = R6 챗 pane · `app://` · preload **있음**(다른 셋은 preload 0 — 예외 · PLAN 합의안 6). 이 종류의 탭을 만드는 코드는 아직 없다(만드는 쪽은 R6) —
 * LayoutEngine.loadTree 는 아직 chat 을 받지 않는다(틀린 트리로 거절).
 */
export type TabKind = 'admin' | 'naver' | 'web' | 'chat';

/** 탭을 연 쪽(RD · Aside «Agent tabs») — user = 사람 · agent = 에이전트가 연 탭(포커스를 뺏지 않는 묶음) */
export type TabOwner = 'user' | 'agent';

export interface TabRecord {
  id: string;
  kind: TabKind;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  /** 없으면 'user'(RD · 사이드바 «Agent tabs» 묶음 = owner 'agent') */
  owner?: TabOwner;
}

export interface PaneNode {
  type: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitNode {
  type: 'split';
  id: string;
  orientation: Orientation;
  /** 첫 자식의 몫 · LAYOUT_LIMITS.minRatio ~ maxRatio */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

/**
 * main 의 LayoutEngine 이 들고 있는 트리(U02 · 메모리 안 정본). userData/layout.json 의 옛 저장 꼴(v1 · U05)과 같다.
 * 2026-10-07(RD-a)부터 파일은 LayoutFileV2 로 쓴다 — 바꿈은 LayoutStore 가 맡는다.
 */
export interface LayoutTree {
  version: 1;
  root: LayoutNode;
  tabs: Record<string, TabRecord>;
  focusedPaneId: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneGeometry {
  paneId: string;
  /** 탭 스트립(셸이 그린다) */
  stripRect: Rect;
  /** 활성 탭 WebContentsView 가 차지하는 자리 */
  contentRect: Rect;
}

export interface SashGeometry {
  id: string;
  splitId: string;
  orientation: Orientation;
  /** sash 자체(4px) */
  rect: Rect;
  /** 그 split 노드 전체 자리 — 셸이 드래그 중 ratio = (포인터 − 시작) / 길이 를 센다 */
  splitRect: Rect;
}

export interface LayoutGeometry {
  panes: PaneGeometry[];
  sashes: SashGeometry[];
}

export const LAYOUT_LIMITS = {
  /** 사장님 2026-10-01 «4단까지» */
  maxPanes: 4,
  minPaneWidth: 320,
  minPaneHeight: 200,
  sashSize: 4,
  /** 시안: 스트립 40px · 탭 34px */
  stripHeight: 40,
  titleBarHeight: 40,
  minRatio: 0.2,
  maxRatio: 0.8,
  /** RD 왼쪽 사이드바 — 사장님 Aside 캡처(assets/aside-reference-2026-10-07.png · 1321×707) 기준 약 252px */
  sidebarWidthDefault: 252,
  sidebarWidthMin: 180,
  sidebarWidthMax: 400,
  /** 창 전체 상태 줄 — 0(«Local · Guard · 모델 · High» 도구 줄은 챗 pane 입력칸 아래 · 합의 권고 · 캡처 x≈275) · 칸만 둔다 */
  statusBarHeight: 0,
} as const;

/** RD 셸 화면(사이드바를 그리는 셸)이 들어오면 true — 그 전에는 pane 영역을 사이드바 폭만큼 줄이지 않는다(지금 보이는 동작 그대로) */
export const SHELL_SIDEBAR_ENABLED = false;

/** RD 왼쪽 사이드바 상태 — layout.json(v2)의 sidebar */
export interface SidebarState {
  collapsed: boolean;
  /** px · LAYOUT_LIMITS.sidebarWidthMin ~ sidebarWidthMax */
  width: number;
}

/**
 * userData/layout.json 저장 꼴 v2(RD-a · 2026-10-07). v1(LayoutTree 그대로)은 LayoutStore.load 가 v2 로 바꿔 읽는다.
 * tree · tabs · focusedPaneId 는 v1 의 root · tabs · focusedPaneId 그대로.
 */
export interface LayoutFileV2 {
  version: 2;
  sidebar: SidebarState;
  /** v1 의 root(LayoutNode) 그대로 */
  tree: LayoutNode;
  tabs: Record<string, TabRecord>;
  focusedPaneId: string | null;
  /** 사이드바 «Agent tabs» 묶음 차례(재시작 뒤 묶음 유지) — 들어 있는 id 의 탭은 owner 'agent' · 비면 칸을 쓰지 않는다 */
  agentTabIds?: string[];
}

/** 사이드바 폭을 min ~ max 로 자른다(정수 · 숫자가 아니면 기본값) */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LAYOUT_LIMITS.sidebarWidthDefault;
  return Math.min(LAYOUT_LIMITS.sidebarWidthMax, Math.max(LAYOUT_LIMITS.sidebarWidthMin, Math.round(width)));
}

/** computePaneViewport 가 보는 높이 둘(보통 LAYOUT_LIMITS 를 그대로 넘긴다) */
export interface PaneViewportLimits {
  readonly titleBarHeight: number;
  readonly statusBarHeight: number;
}

/**
 * pane split 영역 = 창 안쪽 − 제목 줄(위) − 사이드바(왼쪽 · 펼쳤고 enabled 일 때만) − 상태 줄(아래). 순수 함수(ShellWindow.viewport 가 부른다).
 * 창이 사이드바보다 좁으면 너비 0 · x 는 창 오른쪽 끝을 넘지 않는다 — 너비 · 높이는 0 아래로 가지 않는다.
 */
export function computePaneViewport(windowBounds: Rect, limits: PaneViewportLimits, sidebar: SidebarState, enabled: boolean): Rect {
  const width = Math.max(0, windowBounds.width);
  const height = Math.max(0, windowBounds.height);
  const left = enabled && !sidebar.collapsed ? Math.min(clampSidebarWidth(sidebar.width), width) : 0;
  return {
    x: windowBounds.x + left,
    y: windowBounds.y + limits.titleBarHeight,
    width: width - left,
    height: Math.max(0, height - limits.titleBarHeight - limits.statusBarHeight),
  };
}
