// U03 — 단축키. 서버 페이지에 preload 가 없어도 main 의 before-input-event 로 잡는다(Electron 공식 문서 keyboard-shortcuts.md).
// Ctrl+\ 오른쪽 split · Ctrl+Shift+\ 아래 split(계획의 Ctrl+K Ctrl+\ 는 실측 뒤) · Ctrl+1..9 pane · Ctrl+T 새 탭 · Ctrl+W 탭 닫기 · Ctrl+PageUp/Down 이웃 탭
import type { Input, WebContents } from 'electron';
import type { ShellCommand } from '@cmh-hub-app/contracts';
import type { ShellWindow } from './window/shell-window.js';

export function commandForInput(input: Input, w: ShellWindow): ShellCommand | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const focused = w.focusedPaneId();
  const pane = w.activeTabOfFocusedPane();

  if (input.code === 'Backslash') {
    if (!focused) return null;
    return { cmd: 'split', paneId: focused, orientation: input.shift ? 'vertical' : 'horizontal' };
  }
  if (input.shift) return null;

  const digit = /^Digit([1-9])$/.exec(input.code);
  if (digit) {
    const paneId = w.paneIdByOrder(Number(digit[1]) - 1);
    return paneId ? { cmd: 'focusPane', paneId } : null;
  }
  if (input.code === 'KeyT') return focused ? { cmd: 'newTab', paneId: focused } : null;
  if (input.code === 'KeyW') return pane?.activeTabId ? { cmd: 'closeTab', tabId: pane.activeTabId } : null;
  if (input.code === 'PageUp' || input.code === 'PageDown') {
    if (!pane || !pane.activeTabId || pane.tabIds.length < 2) return null;
    const idx = pane.tabIds.indexOf(pane.activeTabId);
    const step = input.code === 'PageDown' ? 1 : -1;
    const next = pane.tabIds[(idx + step + pane.tabIds.length) % pane.tabIds.length];
    return next ? { cmd: 'activateTab', tabId: next } : null;
  }
  return null;
}

export function attachShortcuts(wc: WebContents, w: ShellWindow): void {
  wc.on('before-input-event', (event, input) => {
    const cmd = commandForInput(input, w);
    if (!cmd) return;
    event.preventDefault(); // 페이지와 메뉴에는 이 키가 안 간다
    w.handleCommand(cmd);
  });
}
