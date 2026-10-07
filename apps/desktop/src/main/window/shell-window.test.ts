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
