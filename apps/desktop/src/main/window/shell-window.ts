// U01 — BaseWindow + 셸 view(맨 아래 · 창 전체) + 탭 view 들. 트리(LayoutEngine)가 정본, 셸은 상태를 받아 그린다.
import { app, BaseWindow, WebContentsView, type WebContents } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYOUT_LIMITS,
  SHELL_IPC,
  type LayoutGeometry,
  type NewTabSpec,
  type Rect,
  type ShellCommand,
  type UpdateState,
} from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../../config.js';
import { APP_ICON_PNG } from '../app-identity.js';
import { LayoutEngine } from '../layout/layout-engine.js';
import { LayoutStore } from '../layout/layout-store.js';
import { attachShortcuts } from '../shortcuts.js';
import { buildState } from './state-builder.js';
import { ViewManager } from './view-manager.js';
import { resolveOmniboxInput } from '../omnibox.js';
import { AppUpdater } from '../update/app-updater.js';
import type { AppSession } from '../identity/app-session.js';
import { ScreenLookup } from '../ai-element/element-lookup.js';
import { CHAT_TAB_URL, ChatHandoff, isChatTabUrl } from '../ai-element/chat-handoff.js';

const here = dirname(fileURLToPath(import.meta.url)); // dist/main/window
const DIST = join(here, '..', '..');
/** 앱 아이콘(작업 표시줄 · 창) — 한 곳(app-identity.ts) */
const APP_ICON = APP_ICON_PNG;

export const DEFAULT_TAB: NewTabSpec = {
  kind: 'admin',
  url: `${APP_CONFIG.serverOrigin}${APP_CONFIG.adminPath}`,
  title: 'Shopware',
};

export class ShellWindow {
  readonly window: BaseWindow;
  readonly shellView: WebContentsView;
  readonly engine = new LayoutEngine();
  readonly store: LayoutStore;
  readonly views: ViewManager;
  private geometry: LayoutGeometry = { panes: [], sashes: [] };
  private update: UpdateState = { state: 'none' };
  /** G03 — 상태가 바뀌면 셸 모달(shell:state.update)로 보낸다 */
  readonly updater = new AppUpdater((state) => {
    this.update = state;
    this.sendState();
  });
  private relayoutTimer: NodeJS.Timeout | null = null;
  /** 셸 팝오버가 열려 셸이 맨 위인가 — 그동안 새 탭 view 가 생기면(단축키) 셸을 다시 올린다 */
  private shellOnTop = false;
  /** 다음 상태 한 번에만 실어 보낼 «주소창에 포커스» pane(빈 탭을 막 연 때) */
  private focusOmniboxPaneId: string | null = null;
  /** U10 — 네이버 주소 → 담당 AI(서버 화면 표 · 메모리) · 고른 작업을 «AI 채팅» 탭에 넘기기 */
  private readonly screenLookup: ScreenLookup;
  private readonly chatHandoff: ChatHandoff;

  private constructor(appSession: AppSession | null) {
    this.screenLookup = new ScreenLookup(appSession);
    this.chatHandoff = new ChatHandoff({ findChatTab: () => this.findChatTab(), openChatTab: (sourceTabId) => this.openChatTabBeside(sourceTabId) });
    this.store = new LayoutStore(join(app.getPath('userData'), 'layout.json'));
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      show: false, // 최대화한 뒤에 보인다(create) — 1440×900 으로 깜빡 떴다가 커지지 않게
      backgroundColor: '#1b1b1f',
      title: 'CMH Hub',
      icon: APP_ICON,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      titleBarOverlay: { color: '#141417', symbolColor: '#c7c9cc', height: LAYOUT_LIMITS.titleBarHeight },
    });

    this.shellView = new WebContentsView({
      webPreferences: {
        preload: join(DIST, 'preload', 'shell-preload.mjs'),
        sandbox: false, // 우리 로컬 페이지 — preload 가 workspace 패키지를 import 하려고. 서버 페이지는 sandbox: true(A02)
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.shellView.setBackgroundColor('#00000000'); // 투명 — 팝오버 때 맨 위로 올라가도 pane 자리는 아래 페이지가 보인다(setShellOnTop)
    this.window.contentView.addChildView(this.shellView); // 첫 자식 = 맨 아래
    this.shellView.setBounds(this.contentRect());

    this.views = new ViewManager(
      this.window,
      this.engine,
      {
        onTitle: (tabId, title) => this.patchTab(tabId, { title }),
        onFavicon: (tabId, favicon) => this.patchTab(tabId, { favicon }),
        onLoading: (tabId, loading) => this.patchTab(tabId, { loading }),
        onUrl: (tabId, url) => this.patchTab(tabId, { url }),
        onInspect: (tabId, x, y) => {
          this.views.inspect(tabId, x, y, () => this.refreshAfterInspector());
          // 셸 메뉴가 열린 채면 새 개발자 도구 view 가 메뉴를 덮는다 — 셸을 다시 맨 위로(제미나이 검수 2026-10-05)
          if (this.shellOnTop) this.setShellOnTop(true);
        },
        onCloseInspector: (tabId) => this.views.closeInspector(tabId, () => this.refreshAfterInspector()),
        isInspecting: (tabId) => this.views.isInspecting(tabId),
        onOpenWebTab: (tabId, url) => {
          const pane = this.engine.getPaneOfTab(tabId);
          if (pane) this.handleCommand({ cmd: 'newTab', paneId: pane.id, kind: 'web', url });
        },
        onOpenAdminTab: (tabId, url) => {
          const pane = this.engine.getPaneOfTab(tabId);
          if (pane) this.handleCommand({ cmd: 'newTab', paneId: pane.id, kind: 'admin', url });
        },
        aiLookup: (pageUrl) => this.screenLookup.lookup(pageUrl),
        aiSend: (tabId, request) => this.chatHandoff.send(tabId, request),
        onFocus: (tabId) => {
          const pane = this.engine.getPaneOfTab(tabId);
          if (pane && pane.id !== this.engine.getTree().focusedPaneId) this.handleCommand({ cmd: 'focusPane', paneId: pane.id });
        },
      },
      (view) => attachShortcuts(view.webContents, this),
    );
    attachShortcuts(this.shellView.webContents, this);

    this.window.on('resize', () => this.scheduleRelayout());
    this.window.on('maximize', () => this.sendState());
    this.window.on('unmaximize', () => this.sendState());
    this.window.on('closed', () => {
      this.views.closeAll();
      if (!this.shellView.webContents.isDestroyed()) this.shellView.webContents.close();
      void this.store.flush();
    });
  }

  /** appSession — U10 이 서버 화면 표를 읽는 데 쓴다(null 이면 담당 AI 없이 · smoke 등) */
  static async create(appSession: AppSession | null = null): Promise<ShellWindow> {
    const w = new ShellWindow(appSession);
    // 시작은 늘 1단 · 어드민 탭 하나(2026-10-04 사장님 «default 는 1개 창, 어드민만»). 지난 레이아웃(layout.json)은 되살리지 않는다
    // — 옛 U05 복원은 smoke 시험이 남긴 3단 · 탭 여럿까지 되살렸다. 저장(store.save)은 그대로 둔다(나중에 «마지막 배치로 열기» 설정을 붙일 자리)
    w.engine.resetToDefault(DEFAULT_TAB);
    w.views.ensureAll();
    // 기본 = 모니터 100%(최대화 · 2026-10-02 사장님 지시). 1440×900 은 «이전 크기로» 눌렀을 때의 크기다
    w.window.maximize();
    w.window.show();
    w.relayout();
    await w.shellView.webContents.loadFile(join(DIST, 'shell', 'index.html'));
    w.sendState();
    return w;
  }

  /** 셸 · 단축키 · 덮개가 보내는 명령 — 트리를 바꾸고 view · 상태를 맞춘다. newTab = split 이 새 pane 에 만들 첫 탭(기본 어드민 첫 화면 · U10 은 AI 채팅) */
  handleCommand(cmd: ShellCommand, newTab: NewTabSpec = DEFAULT_TAB): void {
    switch (cmd.cmd) {
      case 'window.minimize':
        this.window.minimize();
        return;
      case 'window.toggleMaximize':
        if (this.window.isMaximized()) this.window.unmaximize();
        else this.window.maximize();
        return;
      case 'window.close':
        this.window.close();
        return;
      case 'reloadTab':
        this.views.get(cmd.tabId)?.webContents.reload();
        return;
      case 'navigate': {
        // 탭 줄 뒤로 · 앞으로 · 새로고침(2026-10-05) — 기록이 없으면 아무것도 안 한다(셸 단추도 꺼져 있다)
        const tabWc = this.views.get(cmd.tabId)?.webContents;
        if (!tabWc || tabWc.isDestroyed()) return;
        if (cmd.action === 'reload') tabWc.reload();
        else if (cmd.action === 'back' && tabWc.navigationHistory.canGoBack()) tabWc.navigationHistory.goBack();
        else if (cmd.action === 'forward' && tabWc.navigationHistory.canGoForward()) tabWc.navigationHistory.goForward();
        return;
      }
      case 'omnibox': {
        // 빈 탭 주소창 Enter(2026-10-05) — 빈 탭만 · 주소면 그리로 · 아니면 Google 검색. 어드민 · 네이버 탭은 주소를 안 받는다(A02)
        const tab = this.engine.getTab(cmd.tabId);
        const tabWc = this.views.get(cmd.tabId)?.webContents;
        const url = resolveOmniboxInput(cmd.text);
        if (tab?.kind !== 'web' || !tabWc || tabWc.isDestroyed() || !url) return;
        void tabWc.loadURL(url).catch(() => undefined); // 못 여는 주소는 페이지가 오류 화면을 보인다
        tabWc.focus();
        return;
      }
      case 'update.download':
        this.updater.download();
        return;
      case 'update.install':
        this.updater.install();
        return;
      case 'update.later':
        this.updater.later();
        return;
      case 'aiTaskStop':
        console.info('[ai] 1차에서는 상태만 — W02 뒤에', cmd.paneId);
        return;
      case 'shell.popup':
        this.setShellOnTop(cmd.open, cmd.refocusPage ?? true);
        return;
      case 'devtools.resize':
        if (this.views.setDevToolsRatio(cmd.tabId, cmd.ratio)) {
          this.relayout();
          this.sendState();
        }
        return;
      case 'devtools.close':
        this.views.closeInspector(cmd.tabId, () => this.refreshAfterInspector());
        return;
      default:
        break;
    }

    let command: ShellCommand = cmd;
    if (cmd.cmd === 'newTab' && cmd.kind === 'naver' && cmd.url === undefined) {
      const url = APP_CONFIG.newTabChoices.find((c) => c.kind === 'naver')?.url;
      if (url) command = { ...cmd, url };
    }
    const change = this.engine.apply(command, { newTab });
    if (change.rejected) {
      console.info('[layout] 거절:', change.rejected, cmd);
      this.sendState();
      return;
    }
    this.views.applyChange(change);
    // 메뉴가 열린 채 단축키(Ctrl+T · Ctrl+\)로 view 가 생기면 그 view 가 셸 위에 붙는다 — 셸을 다시 맨 위로(검수 2026-10-03)
    if (this.shellOnTop && change.createdTabIds.length > 0) this.setShellOnTop(true);
    if (change.geometryChanged || change.createdTabIds.length > 0 || change.activeChangedPaneIds.length > 0) {
      this.relayout();
    }
    const keepShellFocus = (cmd.cmd === 'activateTab' || cmd.cmd === 'closeTab' || cmd.cmd === 'focusPane') && cmd.keepShellFocus === true;
    // 빈 탭을 «+» 로 새로 열면 크롬처럼 주소창에 키보드 포커스 — 페이지가 아니라 셸에
    const blankWebTab = cmd.cmd === 'newTab' && command.cmd === 'newTab' && command.kind === 'web' && (command.url ?? 'about:blank') === 'about:blank';
    if (blankWebTab && change.focusedPaneId) {
      this.focusOmniboxPaneId = change.focusedPaneId;
      this.shellView.webContents.focus();
    } else if (change.focusedPaneId && !keepShellFocus) this.focusActiveViewOf(change.focusedPaneId);
    this.store.save(this.engine.getTree());
    this.sendState();
  }

  /**
   * 셸 팝오버(«+» · 레이아웃 메뉴)가 열린 동안만 셸 view 를 맨 위로. 같은 view 를 addChildView 하면 순서만 바뀐다
   * (Electron View 문서 «If the same View is added to a parent which already contains it, it will be reordered»).
   * 닫히면 다시 맨 아래(index 0). 셸 바탕은 투명(setBackgroundColor #00000000 · shell.css)이라 올려도 아래 페이지가 보인다.
   */
  private setShellOnTop(on: boolean, refocusPage = true): void {
    if (this.window.isDestroyed()) return;
    this.shellOnTop = on;
    if (on) {
      this.window.contentView.addChildView(this.shellView);
      return;
    }
    this.window.contentView.addChildView(this.shellView, 0);
    // 페이지 자리를 눌러 메뉴를 닫으면 그 클릭은 셸이 먹는다 — 키보드 포커스를 포커스 pane 의 페이지로 돌려준다(Esc 로 닫으면 셸 단추에 남긴다)
    const paneId = this.focusedPaneId();
    if (refocusPage && paneId) this.focusActiveViewOf(paneId);
  }

  /** smoke — 오른쪽 클릭 «검사»와 같은 길(메뉴는 사람만 누를 수 있다) */
  handleInspectForSmoke(tabId: string, x: number, y: number): void {
    this.views.inspect(tabId, x, y, () => this.refreshAfterInspector());
  }

  closeInspectorForSmoke(tabId: string): void {
    this.views.closeInspector(tabId, () => this.refreshAfterInspector());
  }

  private refreshAfterInspector(): void {
    this.relayout();
    this.sendState();
  }

  /** smoke — 셸 view 가 지금 맨 위 층인가 */
  isShellOnTop(): boolean {
    const children = this.window.contentView.children;
    return children[children.length - 1] === this.shellView;
  }

  /** U10 — 이미 열린 «AI 채팅» 탭(admin · #/cmh/ai/chat-solo)을 그 pane 에서 활성으로 올리고 webContents 를 준다. 없으면 null */
  findChatTab(): WebContents | null {
    const tab = Object.values(this.engine.getTree().tabs).find((t) => t.kind === 'admin' && isChatTabUrl(t.url));
    const wc = tab ? this.views.get(tab.id)?.webContents : undefined;
    if (!tab || !wc || wc.isDestroyed()) return null;
    if (this.engine.getPaneOfTab(tab.id)?.activeTabId !== tab.id) this.handleCommand({ cmd: 'activateTab', tabId: tab.id });
    return wc;
  }

  /**
   * U10 — «AI 채팅» 탭을 소스 탭과 «다른» pane 에 연다(사람이 보던 화면을 가리지 않게). 다른 pane 이 없으면 소스 pane 을 좌우로 나눠 오른쪽에
   * — split 이 새 pane 의 첫 탭을 바로 chat-solo 로 만든다(어드민 첫 화면을 거치지 않는다). pane 상한(4)으로 split 이 거절되면 소스 pane 에 새 탭으로.
   */
  openChatTabBeside(sourceTabId: string): WebContents | null {
    const source = this.engine.getPaneOfTab(sourceTabId);
    if (!source) return null;
    const other = this.engine.listPanes().find((p) => p.id !== source.id);
    if (other) {
      this.handleCommand({ cmd: 'newTab', paneId: other.id, kind: 'admin', url: CHAT_TAB_URL });
      return this.activeWebContentsOf(other.id);
    }
    this.handleCommand({ cmd: 'split', paneId: source.id, orientation: 'horizontal' }, { kind: 'admin', url: CHAT_TAB_URL, title: 'AI 채팅' });
    const focused = this.focusedPaneId();
    if (focused && focused !== source.id) return this.activeWebContentsOf(focused);
    this.handleCommand({ cmd: 'newTab', paneId: source.id, kind: 'admin', url: CHAT_TAB_URL });
    return this.activeWebContentsOf(source.id);
  }

  private activeWebContentsOf(paneId: string): WebContents | null {
    const pane = this.engine.getPane(paneId);
    const wc = pane?.activeTabId ? this.views.get(pane.activeTabId)?.webContents : undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  focusedPaneId(): string | null {
    return this.engine.getTree().focusedPaneId;
  }

  /** 단축키 Ctrl+1..9 — 왼쪽 위부터 geometry 순 */
  paneIdByOrder(index: number): string | undefined {
    const ordered = [...this.geometry.panes].sort((a, b) => a.stripRect.y - b.stripRect.y || a.stripRect.x - b.stripRect.x);
    return ordered[index]?.paneId;
  }

  /** 포커스 pane 의 활성 탭 — 단축키 Ctrl+W · PageUp/Down */
  activeTabOfFocusedPane(): { paneId: string; tabIds: string[]; activeTabId: string | null } | undefined {
    const paneId = this.focusedPaneId();
    const pane = paneId ? this.engine.getPane(paneId) : undefined;
    return pane ? { paneId: pane.id, tabIds: pane.tabIds, activeTabId: pane.activeTabId } : undefined;
  }

  isShellSender(sender: WebContents): boolean {
    return sender.id === this.shellView.webContents.id;
  }

  private patchTab(tabId: string, patch: { title?: string; favicon?: string | null; loading?: boolean; url?: string }): void {
    if (!this.engine.getTab(tabId)) return;
    this.engine.updateTab(tabId, patch);
    if (patch.url !== undefined) this.store.save(this.engine.getTree());
    this.sendState();
  }

  private contentRect(): Rect {
    const [width, height] = this.window.getContentSize();
    return { x: 0, y: 0, width: width ?? 0, height: height ?? 0 };
  }

  private viewport(): Rect {
    const full = this.contentRect();
    return { x: 0, y: LAYOUT_LIMITS.titleBarHeight, width: full.width, height: Math.max(0, full.height - LAYOUT_LIMITS.titleBarHeight) };
  }

  private scheduleRelayout(): void {
    if (this.relayoutTimer) return;
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      this.relayout();
      this.sendState();
    }, 16);
  }

  private relayout(): void {
    this.shellView.setBounds(this.contentRect());
    this.geometry = this.engine.computeGeometry(this.viewport());
    this.views.applyGeometry(this.geometry);
  }

  private focusActiveViewOf(paneId: string): void {
    const pane = this.engine.getPane(paneId);
    const view = pane?.activeTabId ? this.views.get(pane.activeTabId) : undefined;
    view?.webContents.focus();
  }

  private sendState(): void {
    const wc = this.shellView.webContents;
    if (wc.isDestroyed()) return;
    wc.send(
      SHELL_IPC.state,
      buildState(
        this.engine,
        this.geometry,
        this.window,
        this.update,
        (tabId) => this.historyOf(tabId),
        this.focusOmniboxPaneId,
        (tabId, content) => this.views.devToolsLayoutOf(tabId, content),
      ),
    );
    this.focusOmniboxPaneId = null;
  }

  private historyOf(tabId: string): { canGoBack: boolean; canGoForward: boolean } | undefined {
    const tabWc = this.views.get(tabId)?.webContents;
    if (!tabWc || tabWc.isDestroyed()) return undefined;
    return { canGoBack: tabWc.navigationHistory.canGoBack(), canGoForward: tabWc.navigationHistory.canGoForward() };
  }
}

let current: ShellWindow | null = null;

export async function createShellWindow(appSession: AppSession | null = null): Promise<ShellWindow> {
  current = await ShellWindow.create(appSession);
  current.window.on('closed', () => {
    current = null;
  });
  return current;
}

export function getShellWindow(): ShellWindow | null {
  return current;
}
