// U02 · U03 — main 의 LayoutEngine 이 지키는 인터페이스. window 쪽(view-manager)은 이것만 보고 코딩한다.
import type { LayoutGeometry, LayoutTree, PaneNode, Rect, TabKind, TabRecord } from './layout.js';
import type { ShellCommand } from './shell-ipc.js';

export interface LayoutChange {
  /** 새로 만들 view (A02) */
  createdTabIds: string[];
  /** webContents.close() 할 view */
  closedTabIds: string[];
  closedPaneIds: string[];
  /** 활성 탭이 바뀐 pane → view setVisible 갱신 */
  activeChangedPaneIds: string[];
  focusedPaneId: string | null;
  /** rect 를 다시 계산해야 하나(split · resize · close · move) */
  geometryChanged: boolean;
  /** 명령이 거절됐으면 까닭 하나(예: pane 상한) · 없으면 null */
  rejected: string | null;
}

export interface NewTabSpec {
  kind: TabKind;
  url: string;
  title?: string;
}

export interface LayoutEngineApi {
  getTree(): LayoutTree;
  /** U05 복원 — 깨진 트리면 false 를 돌려주고 기본 트리로 시작한다 */
  loadTree(tree: unknown): boolean;
  /** pane 1 · 탭 1(url) */
  resetToDefault(firstTab: NewTabSpec): void;
  apply(cmd: ShellCommand, defaults: { newTab: NewTabSpec }): LayoutChange;
  /** viewport = 제목줄 아래 영역(x,y 는 창 기준 px) */
  computeGeometry(viewport: Rect): LayoutGeometry;
  listPanes(): PaneNode[];
  getPane(paneId: string): PaneNode | undefined;
  getTab(tabId: string): TabRecord | undefined;
  getPaneOfTab(tabId: string): PaneNode | undefined;
  updateTab(tabId: string, patch: Partial<Omit<TabRecord, 'id' | 'kind'>>): void;
  paneCount(): number;
}
