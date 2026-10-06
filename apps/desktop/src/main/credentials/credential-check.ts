// U08 검증 — CMH_HUB_CRED_CHECK=1 (개발판만). 쓰고 버리는 메모리 세션(persist: 없음)에서 어드민 · 네이버 로그인 화면을 열고
// ①칸 찾기 ②오른쪽 클릭 메뉴 이벤트 ③가짜 계정 넣기 ④safeStorage 저장 왕복을 재서 `[cred-check]` 줄로 찍고 앱을 끈다.
// 로그인 단추는 누르지 않는다. 사람 앱의 persist:admin · persist:naver · credentials.json 은 건드리지 않는다.
import { app, safeStorage, WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TabKind } from '@cmh-hub-app/contracts';
import { fillSavedCredential, readFieldState } from './credential-filler.js';
import { watchLoginFieldFocus } from './credential-focus-watch.js';
import { watchLoginSubmit } from './credential-autosave.js';
import { CredentialStore } from './credential-store.js';
import { APP_CONFIG } from '../../config.js';
import { findLoginPage, matchLoginFieldClick } from './login-pages.js';

const FAKE_USERNAME = 'cred-check-user';
const FAKE_PASSWORD = 'NotReal-0000';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFields(wc: WebContents, kind: TabKind, timeoutMs: number): Promise<boolean> {
  const page = findLoginPage(kind, wc.getURL());
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = page ? await readFieldState(wc, page) : null;
    if (s?.username && s.password) return true;
    await sleep(500);
  }
  return false;
}

async function checkPage(window: BaseWindow, kind: TabKind, url: string): Promise<Record<string, unknown>> {
  const view = new WebContentsView({ webPreferences: { partition: `cred-check-${kind}`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 40, width: 1100, height: 760 });
  const wc = view.webContents;
  const out: Record<string, unknown> = { kind };
  try {
    await wc.loadURL(url).catch(() => undefined); // SPA 리다이렉트로 reject 될 수 있다 — 칸이 뜨는지로 본다
    out['url'] = wc.getURL();
    out['fieldsFound'] = await waitForFields(wc, kind, 25_000);
    const page = findLoginPage(kind, wc.getURL());
    out['loginPageMatched'] = page !== null;
    if (!page || out['fieldsFound'] !== true) return out;

    // 오른쪽 클릭 — 페이지가 contextmenu 를 막으면 이 이벤트가 안 온다(결정서 D7-4)
    const first = await readFieldState(wc, page);
    // 진단 — 아이디 칸 가운데 점에 실제로 무엇이 있나(덮개 · 다른 칸) · 화면 사진(tmp)
    if (first?.username) {
      const pt = first.username;
      out['elementAtUsernamePoint'] = await wc.executeJavaScriptInIsolatedWorld(1207, [{ code: `(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); return e ? e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 60) + ' placeholder=' + (e.getAttribute('placeholder') || '') : null; })()` }]);
      out['usernamePoint'] = pt;
    }
    try {
      const shotFile = join(tmpdir(), `cred-check-${kind}.png`);
      writeFileSync(shotFile, (await wc.capturePage()).toPNG());
      out['screenshot'] = shotFile;
    } catch (error) {
      // 창이 화면에 안 그려지면(가려짐 · 화면 꺼짐) 사진을 못 찍는다 — 그때 클릭 시험도 믿기 어렵다는 표시로 남긴다
      out['screenshot'] = `못 찍음: ${error instanceof Error ? error.message : 'unknown'}`;
    }
    out['windowVisible'] = window.isVisible() && !window.isMinimized();
    const menu = new Promise<Electron.ContextMenuParams | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      wc.once('context-menu', (_e, params) => { clearTimeout(timer); resolve(params); });
    });
    wc.focus();
    const p = first?.username ?? { x: 0, y: 0 };
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    const params = await menu;
    out['contextMenuFired'] = params !== null;
    out['formControlType'] = params?.formControlType ?? null;
    out['menuWouldShowAccounts'] = params ? matchLoginFieldClick(kind, params) !== null : false;

    // 우리 서버(어드민)에서만 — Vue v-model 이 듣는 input 이벤트가 «신뢰된» 것으로 났는지 본다. 네이버 페이지에는 안 넣는다
    if (kind === 'admin') {
      await wc.executeJavaScript("window.__credCheckInputs = []; document.addEventListener('input', (e) => window.__credCheckInputs.push({ id: e.target && e.target.id, trusted: e.isTrusted }), true); 0");
    }
    out['fillResult'] = await fillSavedCredential(wc, page, FAKE_USERNAME, FAKE_PASSWORD);
    if (kind === 'admin') {
      const inputs = (await wc.executeJavaScript('window.__credCheckInputs')) as Array<{ id: string; trusted: boolean }>;
      out['trustedInputEvents'] = [...new Set(inputs.filter((i) => i.trusted).map((i) => i.id))];
      out['untrustedInputEvents'] = inputs.filter((i) => !i.trusted).length;
    }
    await sleep(1000); // React · Vue 가 다시 그린 뒤에도 값이 남는지
    const after = await readFieldState(wc, page, true);
    // 진단 — 비밀번호 칸 점에 무엇이 있나 · 지금 포커스는 어디인가
    if (after?.password) {
      const pp = after.password;
      out['passwordPoint'] = pp;
      out['elementAtPasswordPoint'] = await wc.executeJavaScriptInIsolatedWorld(1207, [{ code: `(() => { const e = document.elementFromPoint(${pp.x}, ${pp.y}); const a = document.activeElement; return { at: e ? e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 50) : null, active: a ? a.tagName + '#' + a.id : null, inner: [innerWidth, innerHeight] }; })()` }]);
    }
    out['usernameInField'] = after?.usernameValue === FAKE_USERNAME;
    out['passwordInField'] = after?.passwordValue === FAKE_PASSWORD;
    out['passwordFieldIsPasswordType'] = after?.passwordIsPasswordType ?? null;

    // 왼쪽 클릭 계정 목록(U08b) — 칸을 비우고(새로고침) 진짜 클릭 → before-mouse-event → 목록 → 첫 계정 고름 → 넣기.
    // 계정 목록은 사람의 credentials.json 이 아니라 가짜 한 줄을 준다 — «클릭 → 목록이 떴나» 까지 본다(넣기는 위에서 쟀다)
    {
      wc.reload();
      await sleep(500);
      await waitForFields(wc, kind, 25_000);
      let offered: string[] | null = null;
      const listed = new Promise<void>((resolve) => {
        watchLoginFieldFocus(wc, kind, () => view.getBounds(), {
          accountsOf: () => [{ username: FAKE_USERNAME, lastUsedAt: '' }],
          showList: (items) => {
            offered = items.map((i) => i.label);
            resolve();
          },
        });
        setTimeout(resolve, 3000);
      });
      const empty = await readFieldState(wc, page);
      if (empty?.username) {
        wc.focus();
        wc.sendInputEvent({ type: 'mouseDown', x: empty.username.x, y: empty.username.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: empty.username.x, y: empty.username.y, button: 'left', clickCount: 1 });
      }
      await listed;
      out['leftClickListShown'] = offered !== null;
      out['leftClickListItems'] = offered === null ? 0 : (offered as string[]).length;
    }

    // 줌 125%(Ctrl+휠) — CSS px 좌표에 배율을 곱해 클릭하는지(제미나이 검수 2026-10-05)
    if (kind === 'admin') {
      wc.setZoomFactor(1.25);
      await sleep(800);
      const zoomFill = await fillSavedCredential(wc, page, 'zoom-user', 'Zoom-1111');
      await sleep(500);
      const z = await readFieldState(wc, page, true);
      out['zoom125'] = { fillResult: zoomFill, usernameInField: z?.usernameValue === 'zoom-user', passwordInField: z?.passwordValue === 'Zoom-1111' };
      wc.setZoomFactor(1);
    }
    return out;
  } finally {
    window.contentView.removeChildView(view);
    if (!wc.isDestroyed()) wc.close();
  }
}

/**
 * 어드민 자동 저장 끝-끝(U08c) — CMH_HUB_CRED_CHECK_PW_FILE(시험 계정 e2e-test 비밀번호 파일 경로)이 있을 때만.
 * ①틀린 비밀번호로 로그인 단추 → 저장 0 ②맞는 비밀번호 → 대시보드 도착 → 저장 1. 저장은 기록용 가짜(사람 credentials.json 에 안 씀).
 * 비밀번호 값은 찍지 않는다. 네이버는 로그인 단추를 누르지 않는다(이 시험은 우리 서버 어드민만).
 */
async function checkAdminAutoSave(window: BaseWindow): Promise<Record<string, unknown>> {
  // 비밀번호 파일이 없으면 «연결 시험»: 맞는 로그인 대신 대시보드 주소로 옮겨 «도착 화면에서 저장» 연결만 본다(실제 로그인 성공 증명 아님)
  const pwFile = process.env['CMH_HUB_CRED_CHECK_PW_FILE'];
  const password = pwFile && existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : null;
  const view = new WebContentsView({ webPreferences: { partition: 'cred-check-autosave', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 40, width: 1100, height: 760 });
  const wc = view.webContents;
  const saves: Array<{ kind: string; username: string; passwordMatches: boolean }> = [];
  const wrongPassword = 'Wrong-Password-0000';
  watchLoginSubmit(wc, 'admin', (kind, username, pw) => saves.push({ kind, username, passwordMatches: pw === (password ?? wrongPassword) }));
  const clickLoginButton = async (): Promise<boolean> => {
    const pt = (await wc.executeJavaScriptInIsolatedWorld(1207, [{ code: "(() => { const b = document.querySelector('button[type=\"submit\"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()" }])) as { x: number; y: number } | null;
    if (!pt) return false;
    wc.focus();
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 });
    return true;
  };
  try {
    await wc.loadURL(`${APP_CONFIG.serverOrigin}/admin#/login/`).catch(() => undefined);
    await waitForFields(wc, 'admin', 25_000);
    const page = findLoginPage('admin', wc.getURL());
    if (!page) return { error: '로그인 화면 아님', url: wc.getURL() };
    const out: Record<string, unknown> = {};
    out['mode'] = password ? 'real-login' : 'wiring-only';
    out['wrongFill'] = await fillSavedCredential(wc, page, 'e2e-test', wrongPassword);
    out['wrongClicked'] = await clickLoginButton();
    await sleep(8000);
    out['savesAfterWrong'] = saves.length;
    out['urlAfterWrong'] = (wc.getURL().split('#')[1] ?? '').slice(0, 30);
    if (password) {
      await waitForFields(wc, 'admin', 10_000);
      out['rightFill'] = await fillSavedCredential(wc, page, 'e2e-test', password);
      out['rightClicked'] = await clickLoginButton();
    } else {
      await wc.loadURL(`${APP_CONFIG.serverOrigin}/admin#/sw/dashboard/index`).catch(() => undefined); // 성공 흉내 — 해시만 바뀌어 did-navigate-in-page
    }
    const end = Date.now() + 25_000;
    while (Date.now() < end && saves.length === 0) await sleep(500);
    out['savesAfterRight'] = saves.length;
    out['saved'] = saves[0] ? { kind: saves[0].kind, username: saves[0].username, passwordMatches: saves[0].passwordMatches } : null;
    out['urlAfterRight'] = (wc.getURL().split('#')[1] ?? '').slice(0, 30);
    return out;
  } finally {
    window.contentView.removeChildView(view);
    if (!wc.isDestroyed()) wc.close();
  }
}

function checkStore(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'cred-check-'));
  try {
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore(file, safeStorage);
    const saved = store.save('admin', FAKE_USERNAME, FAKE_PASSWORD);
    const raw = readFileSync(file, 'utf8');
    return {
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      saved,
      roundTrip: store.takePasswordForFill('admin', FAKE_USERNAME) === FAKE_PASSWORD,
      plaintextInFile: raw.includes(FAKE_USERNAME) || raw.includes(FAKE_PASSWORD),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runCredentialCheckIfRequested(window: BaseWindow): void {
  if (!process.env['CMH_HUB_CRED_CHECK'] || app.isPackaged) return;
  void (async () => {
    try {
      console.info('[cred-check] store', JSON.stringify(checkStore()));
      if (process.env['CMH_HUB_CRED_CHECK'] === 'autosave') {
        console.info('[cred-check] autosave', JSON.stringify(await checkAdminAutoSave(window)));
        return;
      }
      console.info('[cred-check] admin', JSON.stringify(await checkPage(window, 'admin', `${APP_CONFIG.serverOrigin}/admin#/login/`)));
      if (process.env['CMH_HUB_CRED_CHECK'] === 'all') {
        const naverLogin = 'https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F%23%2Flogin-callback';
        console.info('[cred-check] naver', JSON.stringify(await checkPage(window, 'naver', naverLogin)));
      }
    } catch (error) {
      console.error('[cred-check] 실패', error);
    } finally {
      setTimeout(() => app.quit(), 500);
    }
  })();
}
