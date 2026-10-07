// U02(main 쪽) — 탭 id → WebContentsView. LayoutChange 로 만들고 닫고, LayoutGeometry 로 setBounds · setVisible 한다.
import { WebContentsView, type BaseWindow } from 'electron';
import type { LayoutChange, LayoutEngineApi, LayoutGeometry, Rect } from '@cmh-hub-app/contracts';
import { createAdminView, type TabViewEvents } from '../admin-view.js';
import { splitForDevTools, type DevToolsSplit } from './devtools-split.js';

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();
  /** 탭 id → 그 탭의 개발자 도구 view(2026-10-05 «검사 → 크롬처럼 오른쪽에») */
  private readonly devtools = new Map<string, WebContentsView>();
  /** 지금 열려 있는(창에 붙은) 개발자 도구의 탭 id */
  private readonly devtoolsOpen = new Set<string>();
  /** 탭 id → 개발자 도구 너비 비율 (HUBAPP-DEVTOOLS) */
  private readonly devtoolsRatio = new Map<string, number>();
  /** 진짜로 닫아서 이 탭에서는 다시 못 여는 탭 id */
  private readonly devtoolsSpent = new Set<string>();

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
        const tools = this.devtoolsOpen.has(tabId) ? this.devtools.get(tabId) : undefined;
        if (tabId === pane.activeTabId) {
          if (tools) {
            const split = splitForDevTools(paneGeometry.contentRect, this.devtoolsRatio.get(tabId));
            view.setBounds(split.page);
            tools.setBounds(split.devtools);
            tools.setVisible(true);
          } else {
            view.setBounds(paneGeometry.contentRect);
          }
          view.setVisible(true);
        } else {
          view.setVisible(false);
          tools?.setVisible(false);
        }
      }
    }
  }

  /** 개발자 도구 너비 비율 설정 — 탭 id 에 저장 */
  setDevToolsRatio(tabId: string, ratio: number): boolean {
    if (!this.devtoolsOpen.has(tabId) || !Number.isFinite(ratio)) return false;
    this.devtoolsRatio.set(tabId, Math.min(0.95, Math.max(0.05, ratio)));
    return true;
  }

  /** 활성 탭의 개발자 도구 분할 배치 계산 — 닫혀 있으면 null */
  devToolsLayoutOf(tabId: string, content: Rect): DevToolsSplit | null {
    if (!this.devtoolsOpen.has(tabId)) return null;
    return splitForDevTools(content, this.devtoolsRatio.get(tabId));
  }

  /**
   * «검사» — 개발자 도구를 그 탭 pane 의 오른쪽 view 에 띄운다(Electron 기본은 따로 뜨는 창 · Electron 아이콘).
   * setDevToolsWebContents 는 탭마다 한 번만 — 닫았다 다시 열 때 새 webContents 를 붙이면 안 열린다(2026-10-05 smoke 실측 «다시 열림 false»).
   * 2026-10-07 실측 — 진짜로 닫으면(closeDevTools) 같은 view 를 다시 써도 빈 화면이다 → 어드민 · 빈 탭은 숨기기만, 네이버 탭만 진짜로 닫는다.
   * 그래서 개발자 도구 view 는 닫을 때 창에서 떼기만 하고, 탭이 닫힐 때 없앤다(electron.d.ts «closing the DevTools does not destroy the devToolsWebContents»).
   */
  inspect(tabId: string, x: number, y: number, onChanged: () => void): boolean {
    if (this.devtoolsSpent.has(tabId)) return false;
    const page = this.views.get(tabId);
    if (!page || page.webContents.isDestroyed()) return false;
    if (!this.devtoolsOpen.has(tabId)) {
      let tools = this.devtools.get(tabId);
      if (tools) {
        this.window.contentView.addChildView(tools);
        this.devtoolsOpen.add(tabId);
        onChanged();
      } else {
        tools = new WebContentsView();
        page.webContents.setDevToolsWebContents(tools.webContents);
        this.devtools.set(tabId, tools);
        // 개발자 도구 안에서 닫아도(단축키 등) 자리를 되돌린다
        page.webContents.on('devtools-closed', () => {
          if (!this.views.has(tabId)) return;
          this.devtoolsSpent.add(tabId);
          if (this.devtoolsOpen.has(tabId)) this.hideDevTools(tabId);
          onChanged();
        });
        this.window.contentView.addChildView(tools);
        this.devtoolsOpen.add(tabId);
        page.webContents.openDevTools({ mode: 'detach', activate: true });
        onChanged();
      }
    }
    page.webContents.inspectElement(x, y);
    return true;
  }

  /** 이 탭의 개발자 도구가 열려 있나 — 다른 view 에 띄우면 webContents.isDevToolsOpened() 가 false 다(2026-10-05 smoke 실측) · 그래서 우리가 센다 */
  isInspecting(tabId: string): boolean {
    return this.devtoolsOpen.has(tabId);
  }

  /** 오른쪽 클릭 «개발자 도구 닫기» */
  closeInspector(tabId: string, onChanged: () => void): void {
    if (!this.devtoolsOpen.has(tabId)) return;
    this.hideDevTools(tabId);
    onChanged();
  }

  /** 닫기 = 개발자 도구를 닫고 view 를 창에서 뗀다(webContents 는 다시 열 때 쓴다) */
  private hideDevTools(tabId: string): void {
    this.devtoolsOpen.delete(tabId);
    const kind = this.engine.getTab(tabId)?.kind;
    if (kind === 'naver') {
      // 계획서 U07 8번 3행 «네이버 작업 중에는 닫는다» — 붙은 채면 네이버가 개발자 도구 열림을 볼 수 있다
      const page = this.views.get(tabId);
      if (page && !page.webContents.isDestroyed()) page.webContents.closeDevTools();
      this.devtoolsSpent.add(tabId);
    }
    const tools = this.devtools.get(tabId);
    if (tools && !this.window.isDestroyed()) this.window.contentView.removeChildView(tools);
  }

  /** 탭이 닫힐 때 — 개발자 도구 webContents 까지 없앤다(closeDevTools 는 그것을 안 닫는다 · electron.d.ts) */
  private destroyDevTools(tabId: string): void {
    if (this.devtoolsOpen.has(tabId)) this.hideDevTools(tabId);
    const page = this.views.get(tabId);
    if (page && !page.webContents.isDestroyed()) page.webContents.closeDevTools();
    this.devtoolsSpent.delete(tabId);
    const tools = this.devtools.get(tabId);
    if (!tools) {
      this.devtoolsRatio.delete(tabId);
      return;
    }
    this.devtools.delete(tabId);
    this.devtoolsRatio.delete(tabId);
    if (!tools.webContents.isDestroyed()) tools.webContents.close();
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
    this.destroyDevTools(tabId);
    this.views.delete(tabId);
    // 창이 이미 닫힌 뒤(`closed`)에는 contentView 도 사라져 removeChildView 가 «Object has been destroyed» 를 던진다(2026-10-03 앱 닫을 때 오류창)
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    // BaseWindow 는 view 의 webContents 를 자동으로 안 닫는다(memory leak · Electron 문서)
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
