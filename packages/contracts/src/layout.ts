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
 * 탭 종류 — 셋 다 preload 0. 챗봇은 admin 탭(cmh-ai-chat 라우트). PLAN U02 · U06.
 * web = 빈 탭(2026-10-05 사장님 «빈 탭 · url 넣고 크롬처럼 검색») — 주소창이 있고 아무 http(s) 로 간다 · 저장 공간(persist:web)이 따로라 어드민 · 네이버 로그인 쿠키 · 저장된 계정을 안 쓴다.
 */
export type TabKind = 'admin' | 'naver' | 'web';

export interface TabRecord {
  id: string;
  kind: TabKind;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
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

/** userData/layout.json 에 그대로 저장되는 꼴(U05) */
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
} as const;
