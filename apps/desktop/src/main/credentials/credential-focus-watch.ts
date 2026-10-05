// U08b — 크롬처럼 «아이디 · 비밀번호 칸을 왼쪽 클릭하면 아래에 계정 목록»(2026-10-05 사장님 «필드 클릭해도 자동 넣기 안됨»).
// 페이지에 리스너 · 통로를 넣지 않는다(A02 · U07 8-5): 사람의 왼쪽 클릭은 main 의 `before-mouse-event` 로 받고,
// 그 클릭 뒤에 isolated world 에서 «포커스가 로그인 칸인가»를 한 번 읽기만 한다. 로딩 때 자동 포커스로는 안 뜬다(클릭이 없으니까).
// 비어 있는 로그인 칸이고 저장된 계정이 있으면 네이티브 메뉴를 그 칸 아래에 띄운다. 고른 계정은 오른쪽 클릭 «계정 넣기»와 같은 길로 넣는다.
import { Menu, type Rectangle, type WebContents } from 'electron';
import type { TabKind } from '@cmh-hub-app/contracts';
import { isFilling, readFieldState, type FieldState } from './credential-filler.js';
import { fillSavedAccount, listSavedAccounts } from './credential-menu.js';
import type { SavedAccount } from './credential-store.js';
import { findLoginPage } from './login-pages.js';

/** 클릭 뒤 포커스가 칸으로 옮겨 갈 때까지 */
const AFTER_CLICK_MS = 80;
/** 클릭한 칸에 포커스가 올 때까지 다시 읽는 횟수 · 간격(합 최대 약 0.6초) */
const FOCUS_WAIT_TRIES = 10;
const FOCUS_WAIT_MS = 60;
/** 목록에 보일 계정 수 — 오른쪽 클릭 메뉴와 같다 */
const MAX_LIST_ITEMS = 5;

/** 순수 판단 — 이 클릭 뒤 목록을 띄울까 */
export function shouldOfferAccounts(field: Pick<FieldState, 'active' | 'usernameEmpty' | 'activeAnchor'>, accountCount: number): boolean {
  return field.active !== null && field.activeAnchor !== null && field.usernameEmpty && accountCount > 0;
}

/** 사람이 누른 점(view 좌표)이 포커스된 칸 상자 안인가 — 빈 곳 · 버튼을 눌렀는데 포커스가 칸에 남아 있는 경우를 거른다 */
export function clickIsInsideActiveField(field: Pick<FieldState, 'activeRect'>, click: { x: number; y: number }, zoom: number): boolean {
  const r = field.activeRect;
  if (!r) return false;
  return click.x >= r.left * zoom && click.x <= r.right * zoom && click.y >= r.top * zoom && click.y <= r.bottom * zoom;
}

export interface AccountListItem {
  label: string;
  click: () => void;
}

/** 실제 앱 = 네이티브 메뉴. 검증(credential-check)은 이것을 바꿔 «첫 계정을 고른 것»으로 잇는다 */
export type ShowAccountList = (items: AccountListItem[], x: number, y: number) => void;

const showNativeAccountList: ShowAccountList = (items, x, y) => {
  Menu.buildFromTemplate([...items, { type: 'separator' }, { label: '계정 저장 · 지우기는 칸을 오른쪽 클릭', enabled: false }]).popup({ x, y });
};

export interface FocusWatchOptions {
  showList?: ShowAccountList;
  /** 검증은 사람의 credentials.json 을 읽지 않게 바꾼다 */
  accountsOf?: (kind: TabKind) => SavedAccount[];
}

export function watchLoginFieldFocus(wc: WebContents, kind: TabKind, viewBounds: () => Rectangle, options: FocusWatchOptions = {}): void {
  const showList = options.showList ?? showNativeAccountList;
  const accountsOf = options.accountsOf ?? listSavedAccounts;
  let reading = false;

  /** 누른 점이 들어간 칸에 포커스가 올 때까지 읽는다 — 옛 칸의 포커스를 보고 엉뚱한 칸 아래에 띄우지 않게 */
  const readClickedField = async (page: NonNullable<ReturnType<typeof findLoginPage>>, click: { x: number; y: number }): Promise<FieldState | null> => {
    for (let i = 0; i < FOCUS_WAIT_TRIES; i++) {
      const field = await readFieldState(wc, page);
      if (field && clickIsInsideActiveField(field, click, wc.getZoomFactor())) return field;
      await new Promise((resolve) => setTimeout(resolve, FOCUS_WAIT_MS));
    }
    return null;
  };

  const offer = async (click: { x: number; y: number }): Promise<void> => {
    if (reading || wc.isDestroyed() || isFilling(wc)) return;
    const page = findLoginPage(kind, wc.getURL());
    if (!page) return;
    reading = true;
    try {
      const field = await readClickedField(page, click);
      // 그사이 다른 탭으로 바꿨으면(이 탭이 포커스를 잃음) 안 띄운다 · 그사이 넣기가 시작됐어도 안 띄운다
      if (!field || wc.isDestroyed() || !wc.isFocused() || isFilling(wc)) return;
      const accounts = accountsOf(kind);
      if (!shouldOfferAccounts(field, accounts.length) || !field.activeAnchor) return;
      const bounds = viewBounds();
      const zoom = wc.getZoomFactor();
      const items = accounts.slice(0, MAX_LIST_ITEMS).map((account) => ({
        label: account.username.replace(/&/g, '&&'),
        click: () => fillSavedAccount(wc, page, kind, account.username),
      }));
      showList(items, Math.round(bounds.x + field.activeAnchor.x * zoom), Math.round(bounds.y + field.activeAnchor.y * zoom + 2));
    } finally {
      reading = false;
    }
  };

  wc.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseUp' || mouse.button !== 'left') return;
    if (isFilling(wc) || !findLoginPage(kind, wc.getURL())) return;
    const click = { x: mouse.x, y: mouse.y };
    setTimeout(() => void offer(click), AFTER_CLICK_MS);
  });
}
