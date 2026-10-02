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
import { LayoutEngine } from '../layout/layout-engine.js';
import { LayoutStore } from '../layout/layout-store.js';
import { attachShortcuts } from '../shortcuts.js';
import { buildState } from './state-builder.js';
import { ViewManager } from './view-manager.js';

const here = dirname(fileURLToPath(import.meta.url)); // dist/main/window
const DIST = join(here, '..', '..');

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
  private relayoutTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.store = new LayoutStore(join(app.getPath('userData'), 'layout.json'));
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#1b1b1f',
      title: 'cmh-hub',
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

  static async create(): Promise<ShellWindow> {
    const w = new ShellWindow();
    const saved = await w.store.load();
    if (saved === null || !w.engine.loadTree(saved)) w.engine.resetToDefault(DEFAULT_TAB);
    w.views.ensureAll();
    w.relayout();
    await w.shellView.webContents.loadFile(join(DIST, 'shell', 'index.html'));
    w.sendState();
    return w;
  }

  /** 셸 · 단축키 · 덮개가 보내는 명령 — 트리를 바꾸고 view · 상태를 맞춘다 */
  handleCommand(cmd: ShellCommand): void {
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
      case 'update.download':
      case 'update.install':
      case 'update.later':
        console.info('[update] 1차에서는 상태만 — G03 뒤에', cmd.cmd);
        return;
      case 'aiTaskStop':
        console.info('[ai] 1차에서는 상태만 — W02 뒤에', cmd.paneId);
        return;
      default:
        break;
    }

    let command: ShellCommand = cmd;
    if (cmd.cmd === 'newTab' && cmd.kind === 'naver' && cmd.url === undefined) {
      const url = APP_CONFIG.newTabChoices.find((c) => c.kind === 'naver')?.url;
      if (url) command = { ...cmd, url };
    }
    const change = this.engine.apply(command, { newTab: DEFAULT_TAB });
    if (change.rejected) {
      console.info('[layout] 거절:', change.rejected, cmd);
      this.sendState();
      return;
    }
    this.views.applyChange(change);
    if (change.geometryChanged || change.createdTabIds.length > 0 || change.activeChangedPaneIds.length > 0) {
      this.relayout();
    }
    if (change.focusedPaneId) this.focusActiveViewOf(change.focusedPaneId);
    this.store.save(this.engine.getTree());
    this.sendState();
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
    wc.send(SHELL_IPC.state, buildState(this.engine, this.geometry, this.window, this.update));
  }
}

let current: ShellWindow | null = null;

export async function createShellWindow(): Promise<ShellWindow> {
  current = await ShellWindow.create();
  current.window.on('closed', () => {
    current = null;
  });
  return current;
}

export function getShellWindow(): ShellWindow | null {
  return current;
}
