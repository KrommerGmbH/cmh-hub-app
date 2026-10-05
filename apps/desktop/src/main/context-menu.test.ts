import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ clipboard: { writeText: () => undefined }, Menu: { buildFromTemplate: () => ({ popup: () => undefined }) } }));
const { buildContextMenuTemplate } = await import('./context-menu.js');

const noop = (): void => undefined;
function fakeWc(canGoBack = false) {
  return {
    navigationHistory: { canGoBack: () => canGoBack, canGoForward: () => false, goBack: noop, goForward: noop },
    reload: noop, inspectElement: noop, replaceMisspelling: noop, copyImageAt: noop, undo: noop, redo: noop, cut: noop, copy: noop, paste: noop, selectAll: noop,
  } as never;
}
const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false };
function params(p: Partial<Electron.ContextMenuParams>): Electron.ContextMenuParams {
  return { x: 1, y: 1, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: allFlags, ...p } as Electron.ContextMenuParams;
}
const labels = (items: Array<{ label?: string; type?: string }>): string[] => items.map((i) => i.label ?? `-${i.type ?? ''}-`);

describe('오른쪽 클릭 메뉴(2026-10-04 «마우스 오른쪽 키 → 메뉴가 랜더링 안됨»)', () => {
  it('입력칸: 실행 취소 · 잘라내기 · 복사 · 붙여넣기 · 모두 선택 + 뒤로 · 앞으로 · 새로고침', () => {
    const l = labels(buildContextMenuTemplate(params({ isEditable: true }), fakeWc()));
    expect(l).toEqual(['실행 취소', '다시 실행', '-separator-', '잘라내기', '복사', '붙여넣기', '-separator-', '모두 선택', '-separator-', '뒤로', '앞으로', '새로고침', '-separator-', '검사']);
  });

  it('글자를 고른 빈 자리: 복사가 먼저 · 링크면 링크 주소 복사 · 뒤로는 기록에 따라 켬', () => {
    const items = buildContextMenuTemplate(params({ selectionText: '상품명', linkURL: 'https://x.test/a' }), fakeWc(true));
    expect(labels(items)).toEqual(['복사', '-separator-', '링크 주소 복사', '-separator-', '뒤로', '앞으로', '새로고침', '-separator-', '검사']);
    expect(items.find((i) => i.label === '뒤로')?.enabled).toBe(true);
  });

  it('javascript: 같은 가짜 링크는 «링크 주소 복사»를 안 보인다', () => {
    expect(labels(buildContextMenuTemplate(params({ linkURL: 'javascript:void(0)' }), fakeWc()))).not.toContain('링크 주소 복사');
  });

  it('로그인 칸: 계정 넣기(5개까지) · 이 계정 저장 · 지우기 하위 메뉴가 맨 위 · & 는 그대로 보이게', () => {
    const accounts = ['a&b', 'u2', 'u3', 'u4', 'u5', 'u6'].map((username) => ({ username, lastUsedAt: '' }));
    const filled: string[] = [];
    const credential = { accounts, onFill: (u: string) => filled.push(u), onSave: noop, onRemove: noop };
    const items = buildContextMenuTemplate(params({ isEditable: true }), fakeWc(), credential);
    const l = labels(items);
    expect(l.slice(0, 8)).toEqual(['계정 넣기: a&&b', '계정 넣기: u2', '계정 넣기: u3', '계정 넣기: u4', '계정 넣기: u5', '이 계정 저장', '저장된 계정 지우기', '-separator-']);
    expect((items[6]?.submenu as unknown[]).length).toBe(6);
    (items[0]?.click as () => void)();
    expect(filled).toEqual(['a&b']);
  });

  it('로그인 칸: 저장된 계정이 없으면 «이 계정 저장»만', () => {
    const credential = { accounts: [], onFill: noop, onSave: noop, onRemove: noop };
    expect(labels(buildContextMenuTemplate(params({ isEditable: true }), fakeWc(), credential)).slice(0, 2)).toEqual(['이 계정 저장', '-separator-']);
  });

  it('이미지 · 맞춤법 고칠 말', () => {
    const l = labels(buildContextMenuTemplate(params({ mediaType: 'image', srcURL: 'https://x.test/i.png', misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'] }), fakeWc()));
    expect(l.slice(0, 2)).toEqual(['the', 'ten']);
    expect(l).toContain('이미지 복사');
    expect(l).toContain('이미지 주소 복사');
  });
});
