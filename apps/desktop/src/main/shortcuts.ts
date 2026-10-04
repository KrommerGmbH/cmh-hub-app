// U03 — 단축키. 서버 페이지에 preload 가 없어도 main 의 before-input-event 로 잡는다(Electron 공식 문서 keyboard-shortcuts.md).
// Ctrl+Shift+1..8 레이아웃 고르기(메뉴 차례 · LAYOUT_PRESET_ORDER) · Ctrl+\ 오른쪽 split · Ctrl+Shift+\ 아래 split(계획의 Ctrl+K Ctrl+\ 는 실측 뒤) · Ctrl+1..9 pane · Ctrl+T 새 탭 · Ctrl+W 탭 닫기 · Ctrl+PageUp/Down 이웃 탭
import type { Input, WebContents } from 'electron';
import { LAYOUT_PRESET_ORDER, type ShellCommand } from '@cmh-hub-app/contracts';
import type { ShellWindow } from './window/shell-window.js';

export function commandForInput(input: Input, w: ShellWindow): ShellCommand | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  // 숫자 패드 1~8 = Ctrl+Shift 레이아웃(2026-10-04 사장님 «오른쪽 번호 키로는 작동이 안됨»).
  // Windows 는 NumLock 이 켜진 채 Shift+숫자 패드를 누르면 Shift 를 뗀 것으로 하고 이동 키(End · ↓ …)로 보낸다 → shift 가 false 로 온다.
  // 그래서 «NumLock 켜짐 + (Shift 이거나 key 가 숫자가 아님)» 이면 Shift 를 누른 것으로 본다.
  // NumLock 이 꺼져 있으면 숫자 패드는 이동 키다 — Ctrl+End 같은 페이지 동작을 가로채지 않는다(제미나이 검수 2026-10-04).
  const numpad = /^Numpad([1-8])$/.exec(input.code);
  if (numpad) {
    const numLock = input.modifiers.some((m) => m.toLowerCase() === 'numlock');
    if (!numLock || !(input.shift || !/^[0-9]$/.test(input.key))) return null;
    const preset = LAYOUT_PRESET_ORDER[Number(numpad[1]) - 1];
    return preset ? { cmd: 'applyLayout', preset } : null;
  }
  const focused = w.focusedPaneId();
  const pane = w.activeTabOfFocusedPane();

  if (input.code === 'Backslash') {
    if (!focused) return null;
    return { cmd: 'split', paneId: focused, orientation: input.shift ? 'vertical' : 'horizontal' };
  }
  if (input.shift) {
    // 레이아웃 고르기 — 탭이 모자라면 엔진이 거절한다(메뉴에서도 꺼져 있다)
    const layoutDigit = /^Digit([1-8])$/.exec(input.code);
    const preset = layoutDigit ? LAYOUT_PRESET_ORDER[Number(layoutDigit[1]) - 1] : undefined;
    return preset ? { cmd: 'applyLayout', preset } : null;
  }

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
    // 진단 — Ctrl 과 숫자 패드를 함께 누르면 실제 키 값을 로그에 남긴다(자판 · NumLock 마다 다를 수 있어 사장님 PC 값을 본다 · 2026-10-04)
    if (input.type === 'keyDown' && input.control && input.code.startsWith('Numpad')) {
      console.info(`[shortcut] numpad code=${input.code} key=${input.key} shift=${String(input.shift)} alt=${String(input.alt)} modifiers=${input.modifiers.join(',')}`);
    }
    const cmd = commandForInput(input, w);
    if (!cmd) return;
    event.preventDefault(); // 페이지와 메뉴에는 이 키가 안 간다
    w.handleCommand(cmd);
  });
}
