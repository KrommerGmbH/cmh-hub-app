// 2026-10-07 검수(RD-a) — ShellWindow.handleCommand 가 엔진 앞에서 탭 종류를 거른다(electron 은 가짜 · 실제 LayoutEngine)
import { describe, expect, it, vi } from 'vitest';
import type { NewTabSpec, ShellCommand } from '@cmh-hub-app/contracts';
import type { ShellWindow as ShellWindowInstance } from './shell-window.js';

class Stub {}
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => '' },
  shell: { openExternal: () => Promise.resolve() },
  BaseWindow: Stub,
  WebContentsView: Stub,
  BrowserWindow: Stub,
  Notification: Object.assign(Stub, { isSupported: () => false }),
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  clipboard: { writeText: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
  webContents: { getAllWebContents: () => [] },
  powerMonitor: { on: () => undefined },
  utilityProcess: { fork: () => undefined },
  ipcMain: { on: () => undefined, handle: () => undefined },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: () => undefined } } }));

const { ShellWindow, DEFAULT_TAB } = await import('./shell-window.js');
const { LayoutEngine } = await import('../layout/layout-engine.js');

/** handleCommand 가 쓰는 칸만 둔 가짜 ShellWindow — 메서드는 진짜(prototype) */
function fakeShell() {
  const engine = new LayoutEngine();
  engine.resetToDefault(DEFAULT_TAB);
  const self = Object.create(ShellWindow.prototype) as ShellWindowInstance;
  const spies = {
    sendState: vi.fn(),
    relayout: vi.fn(),
    focusActiveViewOf: vi.fn(),
    applyChange: vi.fn(),
    save: vi.fn(),
  };
  Object.assign(self, {
    engine,
    views: { applyChange: spies.applyChange },
    store: { save: spies.save },
    shellOnTop: false,
    shellView: { webContents: { focus: vi.fn() } },
    sendState: spies.sendState,
    relayout: spies.relayout,
    focusActiveViewOf: spies.focusActiveViewOf,
  });
  return { self, engine, spies, paneId: engine.listPanes()[0]!.id };
}

describe('ShellWindow.handleCommand — 탭 종류', () => {
  it("newTab kind 'chat' 은 거절된다", () => {
    const { self, engine, spies, paneId } = fakeShell();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      self.handleCommand({ cmd: 'newTab', paneId, kind: 'chat', url: 'https://evil.example/' });
      // 로그를 남기고(조용히 무시 아님) · 상태는 다시 보내고 · 엔진 · view · 저장은 안 건드린다
      expect(warn).toHaveBeenCalledWith('[layout] 거절:', expect.stringMatching(/'chat'/));
      expect(spies.sendState).toHaveBeenCalledTimes(1);
      expect(spies.applyChange).not.toHaveBeenCalled();
      expect(spies.save).not.toHaveBeenCalled();
      expect(Object.values(engine.getTree().tabs).map((t) => t.kind)).toEqual(['admin']);

      // IPC 로 온 아무 글자 kind 도 같다
      self.handleCommand({ cmd: 'newTab', paneId, kind: 'evil' } as unknown as ShellCommand);
      // 새 탭 기본값이 chat 인 split 도 거절
      self.handleCommand({ cmd: 'split', paneId, orientation: 'horizontal' }, { kind: 'chat', url: 'app://chat' } as NewTabSpec);
      expect(engine.paneCount()).toBe(1);
      expect(Object.keys(engine.getTree().tabs)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('newTab admin · web 은 그대로 엔진에 간다(대조)', () => {
    const { self, engine, spies, paneId } = fakeShell();
    self.handleCommand({ cmd: 'newTab', paneId, kind: 'admin', url: `${DEFAULT_TAB.url}#/cmh/ai/chat-solo` });
    self.handleCommand({ cmd: 'newTab', paneId, kind: 'web' });
    expect(Object.values(engine.getTree().tabs).map((t) => t.kind)).toEqual(['admin', 'admin', 'web']);
    expect(spies.applyChange).toHaveBeenCalledTimes(2);
    expect(spies.save).toHaveBeenCalledTimes(2);
  });
});

describe('ShellWindow.handleCommand — R6-a 챗 pane 호스트가 있을 때', () => {
  it('newTab kind chat(주소 없음) → 엔진에 chat 탭 · 주소는 app://chat/index.html · 다른 주소는 거절', () => {
    const { self, engine, spies, paneId } = fakeShell();
    Object.assign(self, { chatViews: { createView: vi.fn() } });
    self.handleCommand({ cmd: 'newTab', paneId, kind: 'chat' });
    const chat = Object.values(engine.getTree().tabs).find((t) => t.kind === 'chat');
    expect(chat?.url).toBe('app://chat/index.html');
    expect(spies.applyChange).toHaveBeenCalledTimes(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      self.handleCommand({ cmd: 'newTab', paneId, kind: 'chat', url: 'https://evil.example/' });
      expect(warn).toHaveBeenCalledWith('[layout] 거절:', expect.stringMatching(/'chat'/));
      expect(Object.values(engine.getTree().tabs).filter((t) => t.kind === 'chat')).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
  it('«New Chat» 은 호스트가 있으면 chat · 없으면 옛 어드민 AI 채팅', () => {
    const { self } = fakeShell();
    const sidebarOf = (s: ShellWindowInstance) => (s as unknown as { sidebarView(): { newChat: { kind: string; url: string } | null } }).sidebarView();
    Object.assign(self, { window: { getContentSize: () => [1440, 900] }, store: { getSidebar: () => ({ collapsed: false, width: 252 }) } });
    expect(sidebarOf(self).newChat?.kind).toBe('admin');
    Object.assign(self, { chatViews: { createView: vi.fn() } });
    expect(sidebarOf(self).newChat).toEqual({ kind: 'chat', url: 'app://chat/index.html' });
  });
});

describe('ShellWindow 사이드바 — 좁은 창(검수 5 권고 2) · 트리 저장 전 저장(권고 8)', () => {
  /** 창 width × 600 · 저장 사이드바 · 2단 좌우 엔진 — viewport · sidebarView · setSidebar 가 쓰는 칸만 둔 가짜(메서드는 진짜) */
  function fakeSidebarShell(width: number, saved: { collapsed: boolean; width: number }) {
    const engine = new LayoutEngine();
    engine.resetToDefault(DEFAULT_TAB);
    const paneId = engine.listPanes()[0]!.id;
    engine.apply({ cmd: 'newTab', paneId }, { newTab: DEFAULT_TAB });
    engine.apply({ cmd: 'applyLayout', preset: 'columns2' }, { newTab: DEFAULT_TAB });
    let sidebar = { ...saved };
    const setSidebar = vi.fn((next: { collapsed: boolean; width: number }) => {
      sidebar = { ...next };
    });
    const self = Object.create(ShellWindow.prototype) as ShellWindowInstance;
    Object.assign(self, {
      engine,
      window: { getContentSize: () => [width, 600] },
      store: { getSidebar: () => ({ ...sidebar }), setSidebar },
      relayout: vi.fn(),
      sendState: vi.fn(),
    });
    return { self, engine, setSidebar, saved: () => sidebar };
  }

  it('창 800 · 사이드바 400 · 2단 좌우 → pane 영역이 창 전체 · 어느 pane 도 창 밖으로 안 나간다 · 저장 폭 그대로', () => {
    const { self, engine, saved } = fakeSidebarShell(800, { collapsed: false, width: 400 });
    expect(engine.paneCount()).toBe(2);
    const vp = self.paneViewport();
    expect(vp.x).toBe(0);
    const g = engine.computeGeometry(vp);
    for (const p of g.panes) expect(p.contentRect.x + p.contentRect.width).toBeLessThanOrEqual(800);
    const view = (self as unknown as { sidebarView(): { collapsed: boolean; width: number } }).sidebarView();
    expect(view.collapsed).toBe(true); // 셸도 접어 그린다(viewport 와 같은 값)
    expect(view.width).toBe(400);
    expect(saved()).toEqual({ collapsed: false, width: 400 });
  });

  it('창이 넉넉하면 펼친 그대로(1440 · 400 → pane 영역 x = 400)', () => {
    const { self } = fakeSidebarShell(1440, { collapsed: false, width: 400 });
    expect(self.paneViewport().x).toBe(400);
  });

  it('사람이 끈 폭은 pane 트리 최소 너비를 남기게 자른다 · 접기 요청은 그대로 · 지금 트리를 같이 넘긴다', () => {
    const { self, engine, setSidebar } = fakeSidebarShell(1000, { collapsed: false, width: 252 });
    self.setSidebar({ collapsed: false, width: 400 });
    // 1000 − (320 + 4 + 320) = 356
    expect(setSidebar).toHaveBeenLastCalledWith({ collapsed: false, width: 356 }, engine.getTree());
    self.setSidebar({ collapsed: true, width: 356 });
    expect(setSidebar).toHaveBeenLastCalledWith({ collapsed: true, width: 356 }, engine.getTree());
  });
});
