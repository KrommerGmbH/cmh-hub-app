// 오류 보내기 끝-끝 시험 한 번 — 이 PC 의 «진짜» 설치 ID · 개인키(safeStorage)로 서명해 서버 error-report 를 부르고,
// 서버 var/log/cmh_hub_app_errors-<날짜>.log 에 그 줄이 생겼는지 ssh 로 본다.
// 쓰는 법(apps/desktop 에서 · pnpm run build 뒤):
//   CMH_E2E_USER=e2e-test CMH_E2E_PASSWORD=<비밀번호> env -u ELECTRON_RUN_AS_NODE npx electron scripts/e2e-error-report.mjs
// 비밀번호는 환경값으로만 받는다 — 파일 · 로그에 남기지 않는다.
import { app } from 'electron';
import { execFileSync } from 'node:child_process';

app.setName('cmh-hub'); // 앱과 같은 userData(%APPDATA%/cmh-hub) — 같은 installation.json 을 읽는다

app.whenReady().then(async () => {
  const { APP_CONFIG } = await import('../dist/config.js');
  const { ensureInstallationIdentity } = await import('../dist/main/identity/installation-identity.js');
  const { signHeaders } = await import('../dist/main/identity/signature.js');
  const base = APP_CONFIG.serverOrigin;
  const identity = ensureInstallationIdentity();

  const tokenRes = await fetch(`${base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', client_id: 'administration', scopes: 'write', username: process.env.CMH_E2E_USER, password: process.env.CMH_E2E_PASSWORD }),
  });
  console.log('[e2e] token', tokenRes.status);
  const token = (await tokenRes.json()).access_token;

  const marker = `e2e-error-report ${new Date().toISOString()}`;
  const call = async (body, path = '/api/_action/cmh-hub-app/error-report') => {
    const url = `${base}${path}`;
    const headers = signHeaders({ installationId: identity.installationId, privateKey: identity.privateKey, method: 'POST', url, appVersion: app.getVersion() });
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  };

  // 앱과 같이 — 서버가 모르는 설치면 먼저 등록한다(app-session.ts register)
  const reg = await call({ installationId: identity.installationId, publicKeyPem: identity.publicKeyPem, os: process.platform, osVersion: process.getSystemVersion(), appVersion: '0.1.0' }, '/api/_action/cmh-hub-app/installation/register');
  console.log('[e2e] 설치 등록', reg.status, reg.body);
  const ok = await call({ appVersion: '0.1.0', entries: [{ time: new Date().toISOString(), level: 'error', message: `[test] ${marker}\n    at e2e (scripts/e2e-error-report.mjs)` }] });
  console.log('[e2e] 1번째', ok.status, ok.body);
  const forged = await call({ appVersion: '1\n2026-01-01 [error] 가짜', entries: [{ time: '-', level: 'warn', message: `[test] ${marker} 위조 시도` }] });
  console.log('[e2e] 2번째(appVersion 위조 시도)', forged.status, forged.body);
  const third = await call({ appVersion: '0.1.0', entries: [{ time: '-', level: 'warn', message: 'x' }] });
  console.log('[e2e] 3번째(같은 분 · 429 여야)', third.status, third.body);

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const out = execFileSync('ssh', ['-o', 'BatchMode=yes', 'mymik-main',
    `grep -F "${marker}" /var/www/vhosts/my-mik.de/testumgebung.my-mik.de/var/log/cmh_hub_app_errors-${day}.log`], { encoding: 'utf8' });
  console.log('[e2e] 서버 파일 줄:\n' + out);
  app.quit();
}).catch((e) => {
  console.error('[e2e] 실패', e);
  app.exit(1);
});
