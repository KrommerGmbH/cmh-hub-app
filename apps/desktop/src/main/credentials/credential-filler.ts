// U08 — 저장된 계정을 로그인 칸에 넣는다 · 사람이 친 계정을 읽어 저장한다. 사람의 오른쪽 클릭 한 번에만 돈다.
// 페이지에 남기는 것 0: 스크립트는 isolated world 에서 «읽기만» 한 번 돌고 끝난다(리스너 · 전역 · prototype · 값 쓰기 0 — U07 8-5).
// 글자는 키보드와 같은 길(sendInputEvent 클릭 → insertText · isTrusted=true · U07 8-4)로 넣는다. 로그인 단추는 누르지 않는다(사람 몫).
import type { WebContents } from 'electron';
import type { LoginPage } from './login-pages.js';

/** 우리 읽기 전용 world — 0(main) · 999(Electron contextIsolation preload world)를 피한 고정 번호 */
const CREDENTIAL_WORLD_ID = 1207;
/** 클릭 뒤 포커스가 옮겨 갈 때까지 — 한 번 기다리는 시간과 다시 읽는 횟수(합 최대 약 0.6초) */
const FOCUS_SETTLE_MS = 60;
const FOCUS_WAIT_TRIES = 10;

interface Point {
  x: number;
  y: number;
}

export interface FieldState {
  username: Point | null;
  password: Point | null;
  active: 'username' | 'password' | null;
  /** 포커스가 있는 로그인 칸의 왼쪽 아래(CSS px) — 왼쪽 클릭 계정 목록을 그 아래에 띄운다 */
  activeAnchor: Point | null;
  /** 포커스가 있는 로그인 칸의 상자(CSS px) — 사람이 «그 칸 안»을 눌렀는지 본다 */
  activeRect: { left: number; top: number; right: number; bottom: number } | null;
  usernameEmpty: boolean;
  passwordIsPasswordType: boolean;
  usernameValue?: string;
  passwordValue?: string;
}

export type FillResult = 'filled' | 'username-only' | 'no-username-field' | 'read-failed';

/**
 * 칸 찾기 — 표의 선택자 → 못 찾으면 비밀번호 칸과 같은 form 안에서 비밀번호 칸 «바로 앞»의 보이는 글자 칸(form 이 없으면 안 찾는다 —
 * 페이지 위쪽 검색창을 아이디 칸으로 잡지 않게 · 제미나이 검수 2026-10-05). 화면 밖 칸은 null. 좌표는 CSS px(줌은 clickAt 이 곱한다).
 * withValues 는 «이 계정 저장» 때만.
 */
export function buildFieldStateScript(page: LoginPage, withValues: boolean): string {
  return `(() => {
  const pick = (sels) => { for (const s of sels) { try { const e = document.querySelector(s); if (e) return e; } catch (_) {} } return null; };
  let pw = pick(${JSON.stringify(page.passwordSelectors)}) || document.querySelector('input[type="password"]');
  let id = pick(${JSON.stringify(page.usernameSelectors)});
  if (!id && pw) {
    const form = pw.closest('form');
    if (form) {
      const before = Array.from(form.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'))
        .filter((e) => e.offsetParent !== null && (e.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING));
      id = before.length > 0 ? before[before.length - 1] : null;
    }
  }
  const center = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
    return { x, y };
  };
  const a = document.activeElement;
  const active = a && a === id ? 'username' : a && a === pw ? 'password' : null;
  const ar = active ? a.getBoundingClientRect() : null;
  const anchor = ar ? { x: ar.left, y: ar.bottom } : null;
  const activeRect = ar ? { left: ar.left, top: ar.top, right: ar.right, bottom: ar.bottom } : null;
  const out = { username: center(id), password: center(pw), active, activeAnchor: anchor, activeRect, usernameEmpty: !id || String(id.value) === '', passwordIsPasswordType: !!pw && pw.type === 'password' };
  ${withValues ? "out.usernameValue = id ? String(id.value) : ''; out.passwordValue = pw ? String(pw.value) : '';" : ''}
  return out;
})()`;
}

/** isolated world 는 실패해도 reject 하지 않고 undefined 를 준다(electron.d.ts executeJavaScriptInIsolatedWorld) — 그때 null */
export async function readFieldState(wc: WebContents, page: LoginPage, withValues = false): Promise<FieldState | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(CREDENTIAL_WORLD_ID, [{ code: buildFieldStateScript(page, withValues) }]);
    return result && typeof result === 'object' ? (result as FieldState) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 사람의 왼쪽 클릭과 같은 입력(U07 8-4). getBoundingClientRect 는 CSS px · sendInputEvent 는 view 의 DIP — 줌(Ctrl+휠)이면 배율을 곱한다 */
async function clickAt(wc: WebContents, p: Point): Promise<void> {
  const zoom = wc.getZoomFactor();
  const x = Math.round(p.x * zoom);
  const y = Math.round(p.y * zoom);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(FOCUS_SETTLE_MS);
}

/**
 * 포커스가 그 칸에 갈 때까지 다시 읽는다(최대 FOCUS_WAIT_TRIES 번). 느린 PC · 가려진 창은 렌더러가 늦어 한 번 읽기로는 놓친다
 * (2026-10-05 검증 실행마다 결과가 달랐다 — «display surface not available» 이던 실행에서 비밀번호 칸 확인이 실패).
 */
export async function waitForActiveField(wc: WebContents, page: LoginPage, field: 'username' | 'password' | 'any'): Promise<FieldState | null> {
  let last: FieldState | null = null;
  for (let i = 0; i < FOCUS_WAIT_TRIES; i++) {
    last = await readFieldState(wc, page);
    if (last && (field === 'any' ? last.active !== null : last.active === field)) return last;
    await sleep(FOCUS_SETTLE_MS);
  }
  return last;
}

/** 칸을 눌러 포커스가 «그 칸»에 갔을 때만 기존 글을 고르고 새 글로 바꾼다 */
async function typeInto(wc: WebContents, page: LoginPage, field: 'username' | 'password', text: string): Promise<boolean> {
  const before = await readFieldState(wc, page);
  const point = before?.[field];
  if (!point) return false;
  await clickAt(wc, point);
  const after = await waitForActiveField(wc, page, field);
  if (after?.active !== field) return false;
  // 비밀번호는 type=password 칸에만 — 글자 칸에 평문으로 보이는 사고를 막는다
  if (field === 'password' && !after.passwordIsPasswordType) return false;
  wc.selectAll();
  await wc.insertText(text);
  return true;
}

/** 넣는 중인 탭 — 우리 sendInputEvent 클릭도 before-mouse-event 로 오므로 그동안 왼쪽 클릭 목록을 안 띄운다(제미나이 검수 2026-10-05) */
const fillingUntil = new WeakMap<WebContents, number>();
const FILL_QUIET_MS = 500;

export function isFilling(wc: WebContents): boolean {
  return (fillingUntil.get(wc) ?? 0) > Date.now();
}

/** 아이디 → 비밀번호 차례로 넣는다. 보내기(로그인 단추) · 자동입력 방지 문자 · 2단계 인증은 하지 않는다 */
export async function fillSavedCredential(wc: WebContents, page: LoginPage, username: string, password: string): Promise<FillResult> {
  fillingUntil.set(wc, Number.POSITIVE_INFINITY);
  try {
    return await fillInOrder(wc, page, username, password);
  } finally {
    fillingUntil.set(wc, Date.now() + FILL_QUIET_MS);
  }
}

async function fillInOrder(wc: WebContents, page: LoginPage, username: string, password: string): Promise<FillResult> {
  wc.focus();
  const first = await readFieldState(wc, page);
  if (!first) return 'read-failed';
  if (!(await typeInto(wc, page, 'username', username))) return 'no-username-field';
  // 아이디를 넣으면 지우기 단추 등으로 자리가 바뀔 수 있다 — typeInto 가 비밀번호 칸 자리를 다시 읽는다
  return (await typeInto(wc, page, 'password', password)) ? 'filled' : 'username-only';
}

/** «이 계정 저장» — 사람이 칸에 친 값을 한 번 읽는다. 둘 중 하나라도 비면 null. 비밀번호 «보기»를 켜 type=text 여도 읽는다(읽기는 안 샌다) */
export async function captureTypedCredential(wc: WebContents, page: LoginPage): Promise<{ username: string; password: string } | null> {
  const state = await readFieldState(wc, page, true);
  if (!state) return null;
  const username = (state.usernameValue ?? '').trim();
  const password = state.passwordValue ?? '';
  return username !== '' && password !== '' ? { username, password } : null;
}
