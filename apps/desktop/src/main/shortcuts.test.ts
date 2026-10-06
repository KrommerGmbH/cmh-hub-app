import { describe, expect, it } from 'vitest';
import type { Input } from 'electron';
import { LAYOUT_PRESET_ORDER } from '@cmh-hub-app/contracts';
import { commandForInput } from './shortcuts.js';
import type { ShellWindow } from './window/shell-window.js';

// commandForInput 이 쓰는 셋만 흉내 낸다(창 · Electron 없이)
const fakeWindow = {
  focusedPaneId: () => 'p1',
  activeTabOfFocusedPane: () => ({ paneId: 'p1', tabIds: ['t1', 't2'], activeTabId: 't1' }),
  paneIdByOrder: (i: number) => (i === 0 ? 'p1' : undefined),
} as unknown as ShellWindow;

function key(code: string, mods: { control?: boolean; shift?: boolean; alt?: boolean; key?: string; numLock?: boolean } = {}): Input {
  const modifiers = [mods.control ?? true ? 'control' : '', mods.shift ? 'shift' : '', mods.numLock ?? true ? 'numLock' : ''].filter(Boolean);
  return { type: 'keyDown', code, key: mods.key ?? '', control: mods.control ?? true, shift: mods.shift ?? false, alt: mods.alt ?? false, meta: false, modifiers } as unknown as Input;
}

describe('레이아웃 단축키 Ctrl+Shift+1..8(2026-10-04)', () => {
  it('윗줄 숫자 · 숫자 패드 둘 다 메뉴 차례대로 applyLayout', () => {
    LAYOUT_PRESET_ORDER.forEach((preset, i) => {
      expect(commandForInput(key(`Digit${i + 1}`, { shift: true }), fakeWindow)).toEqual({ cmd: 'applyLayout', preset });
      expect(commandForInput(key(`Numpad${i + 1}`, { shift: true }), fakeWindow)).toEqual({ cmd: 'applyLayout', preset });
    });
  });

  it('숫자 패드: NumLock 켜짐 + Shift 를 떼고 이동 키로 온 것(Windows) = 레이아웃', () => {
    expect(commandForInput(key('Numpad3', { key: 'PageDown' }), fakeWindow)).toEqual({ cmd: 'applyLayout', preset: LAYOUT_PRESET_ORDER[2] });
    expect(commandForInput(key('Numpad9', { key: 'PageUp' }), fakeWindow)).toBeNull();
  });

  it('숫자 패드: NumLock 꺼짐 = 이동 키(Ctrl+End 등) — 가로채지 않는다', () => {
    expect(commandForInput(key('Numpad1', { key: 'End', numLock: false }), fakeWindow)).toBeNull();
    expect(commandForInput(key('Numpad7', { key: 'Home', numLock: false, shift: true }), fakeWindow)).toBeNull();
  });

  it('숫자 패드: NumLock 켜짐 · Shift 없이 숫자 = 레이아웃 아님(메뉴 글씨 Ctrl+Shift 와 맞춤)', () => {
    expect(commandForInput(key('Numpad2', { key: '2' }), fakeWindow)).toBeNull();
  });

  it('9 · Alt 섞임 · Ctrl 없음은 레이아웃이 아니다', () => {
    expect(commandForInput(key('Digit9', { shift: true }), fakeWindow)).toBeNull();
    expect(commandForInput(key('Digit2', { shift: true, alt: true }), fakeWindow)).toBeNull();
    expect(commandForInput(key('Digit2', { control: false, shift: true }), fakeWindow)).toBeNull();
  });

  it('Shift 없는 Ctrl+1 은 그대로 pane 포커스', () => {
    expect(commandForInput(key('Digit1'), fakeWindow)).toEqual({ cmd: 'focusPane', paneId: 'p1' });
  });

  it('Ctrl+T = 빈 탭(크롬처럼 · 2026-10-06)', () => {
    expect(commandForInput(key('KeyT'), fakeWindow)).toEqual({ cmd: 'newTab', paneId: 'p1', kind: 'web', url: 'about:blank' });
  });
});
