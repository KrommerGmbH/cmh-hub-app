// U02 — main 의 트리 + geometry → 셸이 그릴 ShellState(통째로)
import type { BaseWindow } from 'electron';
import {
  LAYOUT_LIMITS,
  type LayoutEngineApi,
  type LayoutGeometry,
  type ShellPaneView,
  type ShellState,
  type UpdateState,
} from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../../config.js';
import { detectLayoutPreset } from '../layout/layout-engine.js';

/** 탭 view 의 방문 기록 — view 가 없거나 닫혔으면 undefined */
export type TabHistoryOf = (tabId: string) => { canGoBack: boolean; canGoForward: boolean } | undefined;

export function buildState(engine: LayoutEngineApi, geometry: LayoutGeometry, window: BaseWindow, update: UpdateState, historyOf: TabHistoryOf): ShellState {
  const tree = engine.getTree();
  const paneCount = engine.paneCount();
  const panes: ShellPaneView[] = [];
  for (const g of geometry.panes) {
    const pane = engine.getPane(g.paneId);
    if (!pane) continue;
    const history = pane.activeTabId ? historyOf(pane.activeTabId) : undefined;
    panes.push({
      id: pane.id,
      stripRect: g.stripRect,
      contentRect: g.contentRect,
      tabs: pane.tabIds.flatMap((tabId) => {
        const t = engine.getTab(tabId);
        return t ? [{ id: t.id, kind: t.kind, title: t.title, favicon: t.favicon, loading: t.loading, active: tabId === pane.activeTabId }] : [];
      }),
      focused: tree.focusedPaneId === pane.id,
      aiTask: null,
      splitAllowed: paneCount < LAYOUT_LIMITS.maxPanes,
      canGoBack: history?.canGoBack ?? false,
      canGoForward: history?.canGoForward ?? false,
    });
  }
  const [width, height] = window.getContentSize();
  return {
    panes,
    sashes: geometry.sashes,
    paneCount,
    layoutPreset: detectLayoutPreset(tree.root),
    maxPanes: LAYOUT_LIMITS.maxPanes,
    focusedPaneId: tree.focusedPaneId,
    update,
    serverHost: new URL(APP_CONFIG.serverOrigin).host,
    platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32',
    window: { width: width ?? 0, height: height ?? 0, maximized: window.isMaximized() },
    newTabChoices: APP_CONFIG.newTabChoices.map((c) => ({ label: c.label, kind: c.kind, url: c.url })),
  };
}
