// U01 — BaseWindow + 셸 view(맨 아래 · 창 전체) + 탭 view 들. 트리(LayoutEngine)가 정본, 셸은 상태를 받아 그린다.
import { app, BaseWindow, Notification, shell, WebContentsView, type WebContents } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampSidebarWidth,
  computePaneViewport,
  frameSidebar,
  LAYOUT_LIMITS,
  maxSidebarWidthFor,
  SHELL_IPC,
  SHELL_SIDEBAR_ENABLED,
  type LayoutGeometry,
  type NewTabSpec,
  type Rect,
  type ShellCommand,
  type ShellSidebarView,
  type SidebarState,
  type UpdateState,
} from '@cmh-hub-app/contracts';
import type { BridgeToApp } from '@cmh-hub-app/driver-core';
import { APP_CONFIG } from '../../config.js';
import { APP_DISPLAY_NAME, APP_ICON_PNG } from '../app-identity.js';
import { LayoutEngine } from '../layout/layout-engine.js';
import { LayoutStore } from '../layout/layout-store.js';
import { attachShortcuts } from '../shortcuts.js';
import { buildState } from './state-builder.js';
import { ViewManager, type ChatViewFactory } from './view-manager.js';
import { resolveOmniboxInput } from '../omnibox.js';
import { AppUpdater } from '../update/app-updater.js';
import type { AppSession } from '../identity/app-session.js';
import { ScreenLookup } from '../ai-element/element-lookup.js';
import {
  CHAT_TAB_URL,
  ChatHandoff,
  HANDOFF_FAILURE_TEXT,
  isChatTabUrl,
  type HandoffRequest,
} from '../ai-element/chat-handoff.js';
import { INTENTS, type ElementInfo } from '../ai-element/element-intents.js';
import { isAllowedUrl } from '../url-policy.js';
import { rejectTabCreation } from '../tab-view-policy.js';
import { CHAT_ENTRY_URL } from '../chat/chat-policy.js';

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
  /** R6-a — 챗 pane 호스트(main/chat/chat-pane-host.ts). null 이면 chat 탭을 만들지 않고 «New Chat» 은 옛 어드민 «AI 채팅» 탭을 연다 */
  private readonly chatViews: ChatViewFactory | null;

  private constructor(appSession: AppSession | null, chatViews: ChatViewFactory | null) {
    this.chatViews = chatViews;
    this.screenLookup = new ScreenLookup(appSession);
    this.chatHandoff = new ChatHandoff({ findChatTab: () => this.findChatTab(), openChatTab: (sourceTabId) => this.openChatTabBeside(sourceTabId) });
    this.store = new LayoutStore(join(app.getPath('userData'), 'layout.json'));
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      show: false, // 최대화한 뒤에 보인다(create) — 1440×900 으로 깜빡 떴다가 커지지 않게
      backgroundColor: '#f2f5f8', // RD — 셸이 밝은 Aside 꼴(shell.css --frame 근처)
      title: 'CMH Hub',
      icon: APP_ICON,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      // Windows 창 단추 자리 — shell.css --titlebar · --muted 와 같은 색(RD 밝은 꼴)
      titleBarOverlay: { color: '#f7f9fb', symbolColor: '#5f6b7a', height: LAYOUT_LIMITS.titleBarHeight },
    });

    this.shellView = new WebContentsView({
      webPreferences: {
        preload: join(DIST, 'preload', 'shell-preload.mjs'),
        sandbox: false, // 우리 로컬 페이지 — preload 가 workspace 패키지를 import 하려고. 서버 페이지는 sandbox: true(A02)
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 검수 5 권고 4 — 셸 view 는 우리 로컬 페이지(loadFile) 하나만 보인다. 페이지 쪽에서 시작한 이동(링크 · 끌어 놓기 · location 바꾸기)과
    // 새 창은 모두 막는다. loadFile 같은 프로그램 이동과 같은 페이지 안 이동(#)에는 will-navigate 가 오지 않는다(electron.d.ts 'will-navigate' 설명)
    this.shellView.webContents.on('will-navigate', (event) => event.preventDefault());
    this.shellView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
          if (!this.views.inspect(tabId, x, y, () => this.refreshAfterInspector())) {
            this.notifyDevtoolsSpent();
            return;
          }
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
      chatViews,
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
  static async create(appSession: AppSession | null = null, chatViews: ChatViewFactory | null = null): Promise<ShellWindow> {
    const w = new ShellWindow(appSession, chatViews);
    // layout.json 에서 사이드바 상태만 읽어 둔다(2026-10-07 검수) — 첫 save 가 파일의 sidebar 를 기본값으로 덮지 않게.
    // 트리 · 탭은 아래처럼 되살리지 않는다(2026-10-04 «복원 끔» 그대로 · 돌려받은 트리는 버린다). 탭 owner 는 store 가 기억했다가 저장 때 붙인다
    await w.store.load();
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
        // U11 — 네이버는 크롬 · url-policy 가 스위치를 본다
        if (!isAllowedUrl('web', url)) {
          void shell.openExternal(url);
          return;
        }
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

    // 탭을 만드는 명령은 엔진에 넘기기 전에 종류부터(2026-10-07 검수) — admin · naver · web 이 아니면(chat · 아무 글자) 거절 · 로그.
    // 엔진(layout-engine.ts)은 newTab 의 kind 를 검사하지 않는다 — 여기가 셸 IPC · 단축키 · 덮개가 들어오는 한 곳이다
    // R6-a — chat 은 챗 pane 호스트가 있을 때 newTab 으로만(주소는 CHAT_ENTRY_URL 하나 · tab-view-policy.ts)
    const refused = rejectTabCreation(cmd, newTab, { chatEnabled: this.chatViews != null });
    if (refused) {
      console.warn('[layout] 거절:', refused);
      this.sendState();
      return;
    }

    let command: ShellCommand = cmd;
    if (cmd.cmd === 'newTab' && cmd.kind === 'naver' && !APP_CONFIG.naverTabEnabled) {
      const url = cmd.url ?? APP_CONFIG.newTabChoices.find((c) => c.kind === 'naver')?.url;
      if (url) void shell.openExternal(url);
      console.info('[layout] 네이버 탭 꺼짐(U11) — 기본 브라우저로 엶', url);
      this.sendState();
      return;
    }
    if (cmd.cmd === 'newTab' && cmd.kind === 'naver' && cmd.url === undefined) {
      const url = APP_CONFIG.newTabChoices.find((c) => c.kind === 'naver')?.url;
      if (url) command = { ...cmd, url };
    }
    // 주소 없는 chat newTab — 엔진은 주소가 없으면 새 탭 기본값(어드민 첫 화면)의 주소를 붙이므로 여기서 챗 첫 화면을 준다
    if (cmd.cmd === 'newTab' && cmd.kind === 'chat' && cmd.url === undefined) command = { ...cmd, url: CHAT_ENTRY_URL };
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
  handleInspectForSmoke(tabId: string, x: number, y: number): boolean {
    const ok = this.views.inspect(tabId, x, y, () => this.refreshAfterInspector());
    if (!ok) this.notifyDevtoolsSpent();
    return ok;
  }

  private notifyDevtoolsSpent(): void {
    if (Notification.isSupported()) {
      new Notification({
        title: APP_DISPLAY_NAME,
        body: '이 탭은 개발자 도구를 다시 열 수 없습니다(한 번 닫히면 그 탭에서는 못 엽니다 · Electron 제약). 탭을 새로 여십시오.',
        silent: true,
        icon: APP_ICON_PNG,
      }).show();
    }
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

  /** U11 — 크롬 확장의 오른쪽 클릭 «AI 작업» 을 받아 AI 채팅 탭으로 넘긴다 */
  async handoffFromExtension(msg: Extract<BridgeToApp, { type: 'context-action' }>): Promise<void> {
    const sourceTabId =
      this.activeTabOfFocusedPane()?.activeTabId ??
      Object.keys(this.engine.getTree().tabs)[0];
    if (!sourceTabId) {
      console.warn('[ai-handoff] AI 작업을 보낼 기준 탭이 없습니다');
      return;
    }

    const element: ElementInfo | null = msg.element ? { ...msg.element } : null;
    const intent = INTENTS[msg.intentKey];
    const screen = await this.screenLookup.lookup(msg.pageUrl);
    const request: HandoffRequest = {
      intent,
      kind: 'naver',
      pageUrl: msg.pageUrl,
      pageTitle: msg.pageTitle,
      element,
      screen,
    };

    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();

    try {
      const result = await this.chatHandoff.send(sourceTabId, request);
      if (result !== 'sent') {
        if (Notification.isSupported()) {
          new Notification({
            title: APP_DISPLAY_NAME,
            body: HANDOFF_FAILURE_TEXT[result],
            silent: true,
            icon: APP_ICON_PNG,
          }).show();
        }
      }
    } catch (error) {
      const line = ((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '').slice(0, 160);
      console.warn('[ai-handoff] 오류', line);
      if (Notification.isSupported()) {
        new Notification({
          title: APP_DISPLAY_NAME,
          body: `AI 채팅으로 넘기다 오류: ${line}`,
          silent: true,
          icon: APP_ICON_PNG,
        }).show();
      }
    }
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

  /**
   * RD — 셸 사이드바 접기 · 폭 끌기(ipc.ts shell:sidebar). store 가 폭을 180~400 으로 자르고 layout.json 에 쓴다(debounce) →
   * pane 영역(viewport)을 다시 계산해 view bounds 를 맞추고 셸에 새 상태를 보낸다. 트리(LayoutEngine)는 건드리지 않는다.
   */
  setSidebar(next: SidebarState): void {
    const before = this.store.getSidebar();
    // 트리를 아직 한 번도 저장하지 않았어도 사이드바를 파일에 쓰게 지금 트리를 같이 넘긴다(검수 5 권고 8)
    this.store.setSidebar(this.fitSidebarRequest(next), this.engine.getTree());
    const after = this.store.getSidebar();
    if (before.collapsed === after.collapsed && before.width === after.width) return;
    this.relayout();
    this.sendState();
  }

  /**
   * 검수 5 권고 2 — 사람이 펼치거나 끈 폭이 pane 트리 최소 너비를 못 남기면 남길 수 있는 폭까지 자른다(끄는 중에 frameSidebar 가 사이드바를
   * 접어 그려 끌던 손잡이가 사라지지 않게). 【AI 임시 결정】 그 폭조차 sidebarWidthMin 보다 작으면 요청 그대로 둔다(frameSidebar 가 접어 그린다).
   * 창 크기를 줄일 때는 이 함수를 지나지 않는다 — 저장 폭은 그대로이고 그 프레임만 접어 그린다.
   */
  private fitSidebarRequest(next: SidebarState): SidebarState {
    if (!SHELL_SIDEBAR_ENABLED || next.collapsed) return next;
    const max = maxSidebarWidthFor(this.contentRect().width, this.engine.minSize().width);
    if (max === null) return next;
    return { collapsed: false, width: Math.min(clampSidebarWidth(next.width), max) };
  }

  /** 검수 5 권고 2 — 이 프레임에 그릴 사이드바(창이 좁아 pane 트리가 안 들어가면 접어 그림 · 저장 값은 그대로) */
  private frameSidebarState(): SidebarState {
    return frameSidebar(this.contentRect().width, this.store.getSidebar(), this.engine.minSize().width, SHELL_SIDEBAR_ENABLED);
  }

  /** RD — ShellState.sidebar(사이드바 상태 · Agent tabs 묶음 · «New Chat» 이 여는 탭) — collapsed 는 이 프레임에 그린 값 · width 는 저장 값 */
  private sidebarView(): ShellSidebarView {
    const sidebar = this.frameSidebarState();
    return {
      enabled: SHELL_SIDEBAR_ENABLED,
      collapsed: sidebar.collapsed,
      width: sidebar.width,
      agentTabIds: Object.values(this.engine.getTree().tabs).filter((t) => t.owner === 'agent').map((t) => t.id),
      // R6-a — 챗 pane 호스트가 있으면 챗 pane(app://chat) · 없으면 옛 «AI 채팅» 어드민 탭(«+» 메뉴와 같은 것)
      newChat: this.chatViews ? { kind: 'chat', url: CHAT_ENTRY_URL } : { kind: 'admin', url: CHAT_TAB_URL },
    };
  }

  /** pane split 영역 — 창 안쪽 − 제목 줄 − 사이드바(RD · store 의 상태 · SHELL_SIDEBAR_ENABLED 가 false 면 0) − 상태 줄 */
  /** pane 영역(제목 줄 · 사이드바를 뺀 자리) — smoke 가 sash 자리를 같은 계산으로 구한다 */
  paneViewport(): Rect {
    return this.viewport();
  }

  private viewport(): Rect {
    return computePaneViewport(this.contentRect(), LAYOUT_LIMITS, this.frameSidebarState(), SHELL_SIDEBAR_ENABLED);
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
    wc.send(SHELL_IPC.state, {
      ...buildState(
        this.engine,
        this.geometry,
        this.window,
        this.update,
        (tabId) => this.historyOf(tabId),
        this.focusOmniboxPaneId,
        (tabId, content) => this.views.devToolsLayoutOf(tabId, content),
      ),
      sidebar: this.sidebarView(),
    });
    this.focusOmniboxPaneId = null;
  }

  private historyOf(tabId: string): { canGoBack: boolean; canGoForward: boolean } | undefined {
    const tabWc = this.views.get(tabId)?.webContents;
    if (!tabWc || tabWc.isDestroyed()) return undefined;
    return { canGoBack: tabWc.navigationHistory.canGoBack(), canGoForward: tabWc.navigationHistory.canGoForward() };
  }
}

let current: ShellWindow | null = null;

export async function createShellWindow(appSession: AppSession | null = null, chatViews: ChatViewFactory | null = null): Promise<ShellWindow> {
  current = await ShellWindow.create(appSession, chatViews);
  current.window.on('closed', () => {
    current = null;
  });
  return current;
}

export function getShellWindow(): ShellWindow | null {
  return current;
}
