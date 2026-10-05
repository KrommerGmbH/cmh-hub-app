// U08 — 오른쪽 클릭 메뉴의 «계정 넣기 · 이 계정 저장 · 지우기» 를 만든다. 로그인 페이지의 아이디 · 비밀번호 칸 위에서만 나온다.
// 로그에는 kind 와 결과만 적는다 — 아이디(PII) · 비밀번호 · entry 객체는 console 에 넘기지 않는다(app-logger 가 서버로 보낸다).
import { app, Notification, safeStorage, type WebContents } from 'electron';
import { join } from 'node:path';
import type { TabKind } from '@cmh-hub-app/contracts';
import { captureTypedCredential, fillSavedCredential } from './credential-filler.js';
import { CredentialStore, type SavedAccount } from './credential-store.js';
import { matchLoginFieldClick, type LoginPage } from './login-pages.js';

export interface CredentialMenu {
  accounts: SavedAccount[];
  onFill(username: string): void;
  onSave(): void;
  onRemove(username: string): void;
}

const KIND_LABEL: Record<TabKind, string> = { admin: '어드민', naver: '네이버' };

let store: CredentialStore | null = null;

function credentialStore(): CredentialStore {
  store ??= new CredentialStore(join(app.getPath('userData'), 'credentials.json'), safeStorage);
  return store;
}

/** 저장 · 지우기는 화면에 아무것도 안 바뀐다 — Windows 알림 한 줄로 알린다(아이디는 안 적는다) */
function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'CMH Hub', body, silent: true }).show();
}

async function fill(wc: WebContents, page: LoginPage, kind: TabKind, username: string): Promise<void> {
  if (wc.isDestroyed()) return;
  const password = credentialStore().takePasswordForFill(kind, username);
  if (password === null) {
    console.info(`[credential] 넣기 kind=${kind} 결과=저장된 계정 없음`);
    return;
  }
  const result = await fillSavedCredential(wc, page, username, password);
  console.info(`[credential] 넣기 kind=${kind} 결과=${result}`);
  if (result === 'username-only') notify('아이디만 넣었습니다. 비밀번호 칸을 찾지 못했습니다.');
  else if (result !== 'filled') notify('로그인 칸을 찾지 못해 넣지 않았습니다.');
}

async function save(wc: WebContents, page: LoginPage, kind: TabKind): Promise<void> {
  if (wc.isDestroyed()) return;
  const typed = await captureTypedCredential(wc, page);
  if (!typed) {
    console.info(`[credential] 저장 kind=${kind} 결과=칸이 비어 안 함`);
    notify('아이디 · 비밀번호 칸을 못 찾았거나 비어 있습니다. 두 칸에 먼저 친 뒤 «이 계정 저장»을 누르십시오.');
    return;
  }
  const saved = credentialStore().save(kind, typed.username, typed.password);
  console.info(`[credential] 저장 kind=${kind} 결과=${saved ? '저장함' : '안 함'}`);
  notify(saved ? `${KIND_LABEL[kind]} 계정을 이 PC 에 저장했습니다.` : '계정을 저장하지 못했습니다(저장된 계정 파일을 풀 수 없음).');
}

/** 로그인 칸 위 오른쪽 클릭이 아니거나 암호화를 못 쓰면 null — 메뉴에 계정 절이 안 나온다 */
export function credentialMenuFor(wc: WebContents, kind: TabKind, params: Electron.ContextMenuParams): CredentialMenu | null {
  const page = matchLoginFieldClick(kind, {
    pageURL: params.pageURL,
    frameURL: params.frameURL,
    isEditable: params.isEditable,
    formControlType: params.formControlType,
  });
  if (!page || !credentialStore().available()) return null;
  return {
    accounts: credentialStore().list(kind),
    // 탭이 닫히는 등으로 넣기 · 저장이 throw 하면 여기서 끝낸다 — 오류 글만 적고(값 0) unhandledRejection 으로 새지 않게(제미나이 검수 2026-10-05)
    onFill: (username) => {
      fill(wc, page, kind, username).catch((error: unknown) => console.warn(`[credential] 넣기 실패 kind=${kind}`, error instanceof Error ? error.message : 'unknown'));
    },
    onSave: () => {
      save(wc, page, kind).catch((error: unknown) => console.warn(`[credential] 저장 실패 kind=${kind}`, error instanceof Error ? error.message : 'unknown'));
    },
    onRemove: (username) => {
      const removed = credentialStore().remove(kind, username);
      console.info(`[credential] 지우기 kind=${kind} 결과=${removed ? '지움' : '안 함'}`);
      notify(removed ? `저장된 ${KIND_LABEL[kind]} 계정 하나를 지웠습니다.` : '저장된 계정 파일을 풀 수 없어 지우지 못했습니다.');
    },
  };
}
