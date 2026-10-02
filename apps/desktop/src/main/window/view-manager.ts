// U02(main 쪽) — 탭 id → WebContentsView. LayoutChange 로 만들고 닫고, LayoutGeometry 로 setBounds · setVisible 한다.
import type { BaseWindow, WebContentsView } from 'electron';
import type { LayoutChange, LayoutEngineApi, LayoutGeometry } from '@cmh-hub-app/contracts';
import { createAdminView, type TabViewEvents } from '../admin-view.js';

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();

  constructor(
    private readonly window: BaseWindow,
    private readonly engine: LayoutEngineApi,
    private readonly events: TabViewEvents,
    private readonly onViewCreated: (view: WebContentsView) => void,
  ) {}

  get(tabId: string): WebContentsView | undefined {
    return this.views.get(tabId);
  }

  tabIdOf(webContentsId: number): string | undefined {
    for (const [tabId, view] of this.views) if (view.webContents.id === webContentsId) return tabId;
    return undefined;
  }

  /** 시작 때 — 트리에 있는데 view 가 없는 탭을 전부 만든다 */
  ensureAll(): void {
    for (const pane of this.engine.listPanes()) {
      for (const tabId of pane.tabIds) if (!this.views.has(tabId)) this.create(tabId);
    }
  }

  applyChange(change: LayoutChange): void {
    for (const tabId of change.closedTabIds) this.destroy(tabId);
    for (const tabId of change.createdTabIds) this.create(tabId);
  }

  /** 활성 탭만 보이고 자리 잡는다 · 같은 pane 의 비활성 탭은 숨긴다 */
  applyGeometry(geometry: LayoutGeometry): void {
    for (const paneGeometry of geometry.panes) {
      const pane = this.engine.getPane(paneGeometry.paneId);
      if (!pane) continue;
      for (const tabId of pane.tabIds) {
        const view = this.views.get(tabId);
        if (!view) continue;
        if (tabId === pane.activeTabId) {
          view.setBounds(paneGeometry.contentRect);
          view.setVisible(true);
        } else {
          view.setVisible(false);
        }
      }
    }
  }

  closeAll(): void {
    for (const tabId of [...this.views.keys()]) this.destroy(tabId);
  }

  private create(tabId: string): void {
    const tab = this.engine.getTab(tabId);
    if (!tab) return;
    const view = createAdminView(tab, this.events);
    this.views.set(tabId, view);
    this.window.contentView.addChildView(view); // 맨 위에 붙는다 — 셸 view 는 처음에 붙어 맨 아래
    this.onViewCreated(view);
  }

  private destroy(tabId: string): void {
    const view = this.views.get(tabId);
    if (!view) return;
    this.views.delete(tabId);
    this.window.contentView.removeChildView(view);
    // BaseWindow 는 view 의 webContents 를 자동으로 안 닫는다(memory leak · Electron 문서)
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
