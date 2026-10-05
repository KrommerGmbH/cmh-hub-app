// U02(main 쪽) — 탭 id → WebContentsView. LayoutChange 로 만들고 닫고, LayoutGeometry 로 setBounds · setVisible 한다.
import { WebContentsView, type BaseWindow } from 'electron';
import type { LayoutChange, LayoutEngineApi, LayoutGeometry, Rect } from '@cmh-hub-app/contracts';
import { createAdminView, type TabViewEvents } from '../admin-view.js';

/** 개발자 도구 너비 — pane 너비의 이 비율 · 양쪽 최소(크롬 오른쪽 도킹과 비슷하게) */
const DEVTOOLS_WIDTH_RATIO = 0.4;
const DEVTOOLS_MIN_WIDTH = 320;
const PAGE_MIN_WIDTH = 320;

/** pane 자리를 페이지(왼쪽)와 개발자 도구(오른쪽)로 나눈다 — pane 이 좁으면 개발자 도구를 줄인다 */
export function splitForDevTools(content: Rect): { page: Rect; devtools: Rect } {
  const want = Math.round(content.width * DEVTOOLS_WIDTH_RATIO);
  // pane 이 둘의 최소 합(640)보다 좁으면 반씩 — 개발자 도구가 0px 로 사라지지 않게(제미나이 검수 2026-10-05)
  const width = content.width < DEVTOOLS_MIN_WIDTH + PAGE_MIN_WIDTH
    ? Math.floor(content.width / 2)
    : Math.min(Math.max(want, DEVTOOLS_MIN_WIDTH), content.width - PAGE_MIN_WIDTH);
  return {
    page: { ...content, width: content.width - width },
    devtools: { x: content.x + content.width - width, y: content.y, width, height: content.height },
  };
}

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();
  /** 탭 id → 그 탭의 개발자 도구 view(2026-10-05 «검사 → 크롬처럼 오른쪽에») */
  private readonly devtools = new Map<string, WebContentsView>();
  /** 지금 열려 있는(창에 붙은) 개발자 도구의 탭 id */
  private readonly devtoolsOpen = new Set<string>();

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
            const split = splitForDevTools(paneGeometry.contentRect);
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

  /**
   * «검사» — 개발자 도구를 그 탭 pane 의 오른쪽 view 에 띄운다(Electron 기본은 따로 뜨는 창 · Electron 아이콘).
   * setDevToolsWebContents 는 탭마다 한 번만 — 닫았다 다시 열 때 새 webContents 를 붙이면 안 열린다(2026-10-05 smoke 실측 «다시 열림 false»).
   * 그래서 개발자 도구 view 는 닫을 때 창에서 떼기만 하고, 탭이 닫힐 때 없앤다(electron.d.ts «closing the DevTools does not destroy the devToolsWebContents»).
   */
  inspect(tabId: string, x: number, y: number, onChanged: () => void): void {
    const page = this.views.get(tabId);
    if (!page || page.webContents.isDestroyed()) return;
    if (!this.devtoolsOpen.has(tabId)) {
      let tools = this.devtools.get(tabId);
      if (!tools) {
        tools = new WebContentsView();
        page.webContents.setDevToolsWebContents(tools.webContents);
        this.devtools.set(tabId, tools);
        // 개발자 도구 안에서 닫아도(단축키 등) 자리를 되돌린다
        page.webContents.on('devtools-closed', () => {
          if (this.devtoolsOpen.has(tabId)) this.hideDevTools(tabId);
          onChanged();
        });
      }
      this.window.contentView.addChildView(tools);
      this.devtoolsOpen.add(tabId);
      page.webContents.openDevTools({ mode: 'detach', activate: true });
      onChanged();
    }
    page.webContents.inspectElement(x, y);
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
    const page = this.views.get(tabId);
    if (page && !page.webContents.isDestroyed()) page.webContents.closeDevTools();
    const tools = this.devtools.get(tabId);
    if (tools && !this.window.isDestroyed()) this.window.contentView.removeChildView(tools);
  }

  /** 탭이 닫힐 때 — 개발자 도구 webContents 까지 없앤다(closeDevTools 는 그것을 안 닫는다 · electron.d.ts) */
  private destroyDevTools(tabId: string): void {
    if (this.devtoolsOpen.has(tabId)) this.hideDevTools(tabId);
    const tools = this.devtools.get(tabId);
    if (!tools) return;
    this.devtools.delete(tabId);
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
