// U08c — 로그인하면 «이 계정 저장»을 안 눌러도 자동으로 저장한다(2026-10-05 사장님 «계정저장 클릭안해도 자동으로 저장되게»).
// 페이지에 리스너 · 통로를 넣지 않는다(A02): 로그인 화면에서 사람이 누를 때마다(before-mouse-event) · Enter 를 칠 때마다(before-input-event)
// isolated world 에서 두 칸 값을 한 번 읽어 «메모리에만» 잡아 둔다(마지막에 잡은 값이 이긴다 — 로그인 단추를 누를 때 잡은 완전한 값).
// «단추 위 클릭만» 은 버리었다 — 누른 순간 Shopware 가 단추를 로딩 표시로 덮어 판정이 틀렸다(2026-10-05 실측 DIV.mt-loader). 탭이 «로그인 뒤 도착 화면»(config loginPages.successUrlPrefixes ·
// 어드민 해시 화면 · 네이버 판매자센터 첫 화면)에 오면 그때 저장한다. 로그인 화면을 벗어나기만 한 것(실패 뒤 다른 링크 · F5)으로는 저장하지 않는다
// (제미나이 검수 2026-10-05). 잡아 둔 값은 PENDING_TTL_MS 뒤 타이머로 지운다.
import type { WebContents } from 'electron';
import type { TabKind } from '@cmh-hub-app/contracts';
import { captureTypedCredential } from './credential-filler.js';
import { autoSaveLoggedInAccount } from './credential-menu.js';
import { findLoginPage, isLoginSuccessUrl, type LoginPage } from './login-pages.js';

/** 로그인 단추를 누른 뒤 2단계 인증 · 자동입력 방지 문자를 거쳐 도착 화면에 올 때까지 기다리는 시간 */
const PENDING_TTL_MS = 3 * 60_000;

interface PendingCredential {
  page: LoginPage;
  username: string;
  password: string;
}

/** 순수 판단 — 이 이동 뒤에 저장할까: 잡아 둔 값이 있고 «로그인 뒤 도착 화면»에 왔을 때만 */
export function shouldSaveAfterNavigation(pending: Pick<PendingCredential, 'page'> | null, url: string): boolean {
  return pending !== null && isLoginSuccessUrl(pending.page, url);
}

/** 검증(credential-check)은 사람의 credentials.json 에 쓰지 않게 저장 함수를 바꾼다 */
export type SaveLoggedInAccount = (kind: TabKind, username: string, password: string) => void;

export function watchLoginSubmit(wc: WebContents, kind: TabKind, save: SaveLoggedInAccount = autoSaveLoggedInAccount): void {
  let pending: PendingCredential | null = null;
  let expiry: NodeJS.Timeout | null = null;

  const clear = (): void => {
    pending = null;
    if (expiry) clearTimeout(expiry);
    expiry = null;
  };

  const capture = (page: LoginPage): void => {
    void captureTypedCredential(wc, page).then((typed) => {
      if (!typed) return;
      clear();
      pending = { page, ...typed };
      expiry = setTimeout(clear, PENDING_TTL_MS);
    });
  };

  wc.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseDown' || mouse.button !== 'left' || wc.isDestroyed()) return;
    const page = findLoginPage(kind, wc.getURL());
    if (page) capture(page);
  });
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || (input.key !== 'Enter' && input.code !== 'NumpadEnter') || wc.isDestroyed()) return;
    const page = findLoginPage(kind, wc.getURL());
    if (page) capture(page);
  });

  const onNavigated = (_event: unknown, url: string): void => {
    if (pending && shouldSaveAfterNavigation(pending, url)) {
      save(kind, pending.username, pending.password);
      clear();
    }
  };
  wc.on('did-navigate', onNavigated);
  wc.on('did-navigate-in-page', onNavigated);
  wc.once('destroyed', clear);
}
