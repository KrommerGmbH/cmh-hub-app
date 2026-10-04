// 페이지 오른쪽 클릭 메뉴 — Electron 은 기본 메뉴를 주지 않는다(2026-10-04 사장님 «마우스 오른쪽 키 → 메뉴가 랜더링 안됨»).
// 어드민 · 네이버 view(A02)에 붙인다. 페이지에 아무것도 넣지 않는다(preload 0 그대로) — main 의 `context-menu` 이벤트와 Menu.popup 만 쓴다.
// 개발자 도구(검사)는 넣지 않는다 — 자동화 통로 흔적(U07 8-3)이고 업체 직원에게 필요 없다.
import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

export function buildContextMenuTemplate(
  params: Electron.ContextMenuParams,
  wc: Pick<WebContents, 'navigationHistory' | 'reload' | 'replaceMisspelling' | 'copyImageAt' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'>,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const sep = (): void => {
    if (items.length > 0 && items[items.length - 1]?.type !== 'separator') items.push({ type: 'separator' });
  };

  // 맞춤법 — 틀린 낱말 위에서 고칠 말
  if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    sep();
  }

  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', enabled: f.canUndo, click: () => wc.undo() },
      { label: '다시 실행', accelerator: 'CmdOrCtrl+Y', enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: '잘라내기', accelerator: 'CmdOrCtrl+X', enabled: f.canCut, click: () => wc.cut() },
      { label: '복사', accelerator: 'CmdOrCtrl+C', enabled: f.canCopy, click: () => wc.copy() },
      { label: '붙여넣기', accelerator: 'CmdOrCtrl+V', enabled: f.canPaste, click: () => wc.paste() },
      { type: 'separator' },
      { label: '모두 선택', accelerator: 'CmdOrCtrl+A', enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
  } else if (params.selectionText.trim() !== '') {
    items.push({ label: '복사', accelerator: 'CmdOrCtrl+C', click: () => wc.copy() });
  }

  // http(s) 링크만 — `javascript:void(0)` 같은 가짜 링크는 주소 복사를 안 보인다(제미나이 검수 2026-10-04)
  if (/^https?:\/\//i.test(params.linkURL)) {
    sep();
    items.push({ label: '링크 주소 복사', click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    sep();
    items.push(
      { label: '이미지 복사', click: () => wc.copyImageAt(params.x, params.y) },
      { label: '이미지 주소 복사', click: () => clipboard.writeText(params.srcURL) },
    );
  }

  sep();
  items.push(
    { label: '뒤로', accelerator: 'Alt+Left', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: '앞으로', accelerator: 'Alt+Right', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: '새로고침', accelerator: 'F5', click: () => wc.reload() },
  );
  return items;
}

export function attachContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    // 메뉴가 열린 사이 탭이 닫히면(Ctrl+W) 항목 click 이 사라진 webContents 를 부른다 — 누를 때 한 번 더 본다(제미나이 검수)
    const guarded = buildContextMenuTemplate(params, wc).map((item) =>
      item.click ? { ...item, click: (...args: Parameters<NonNullable<typeof item.click>>) => { if (!wc.isDestroyed()) item.click?.(...args); } } : item,
    );
    Menu.buildFromTemplate(guarded).popup();
  });
}
