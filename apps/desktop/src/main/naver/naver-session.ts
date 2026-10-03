// U07 8-1 · 8-8 · A02 — 세션(partition) 준비. 네이버 세션은 UA 를 «Electron 토막을 뺀 Chromium» 으로 둔다(앞뒤가 맞는 UA · 꾸미지 않는다).
// 2026-10-03 지문 비교(scripts/fingerprint-diff.mjs · 사장님 크롬 154 와 견줌)로 고친 것:
//   ①Accept-Language 에 q 값을 우리가 넣어 `ko;q=0.9;q=0.9` 처럼 겹쳤다 — Chromium 이 q 를 붙이므로 낱말 목록만 넘긴다
//   ②크롬은 UA 의 판을 `154.0.0.0` 으로 줄여 보낸다(UA reduction) — 우리는 `152.0.7977.130` 전체를 보냈다
//   ③권한 «확인»(permissions.query · Notification.permission)이 전부 granted 였다 — 요청만 막고 확인 handler 가 없었다
//      (지금은 전부 denied — 크롬의 prompt 는 Electron API 로 못 낸다 · 한계)
//   ④Sec-CH-UA* 요청 헤더가 아예 없었다(아래 addClientHintHeaders)
import { app, session, WebContentsView, type Session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG } from '../../config.js';
import { chromiumLikeUserAgent, clientHintHeaders, type ClientHintHeaders, type UserAgentDataLow } from './user-agent.js';

const UA_PROBE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shell', 'ua-probe.html');
const UA_PROBE_TIMEOUT_MS = 5_000;

const DENIED_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'display-capture', 'clipboard-read']);

/** 네이버 판매자센터 사용자(한국)의 언어 목록 — q 값은 Chromium 이 붙인다(Electron `session.setUserAgent` 둘째 인자) */
export const NAVER_ACCEPT_LANGUAGES = 'ko-KR,ko,en-US,en';

function denyRiskyPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => !DENIED_PERMISSIONS.has(permission));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ms}ms 안에 끝나지 않았습니다`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/**
 * U07 8-12 — Electron 은 Sec-CH-UA* 요청 헤더를 보내지 않는다(2026-10-03 지문 비교 · 크롬 154 는 모든 secure 요청에 보냄 ·
 * `enable-features=UserAgentClientHint` 스위치로도 안 나옴 · UA 를 override 대신 `userAgentFallback` 으로 둬도 안 나옴).
 * 요즘 Chromium UA 인데 이 헤더가 없으면 그 자체가 표시다. 엔진이 JS 에 주는 값을 읽어 헤더로 옮긴다 — 둘이 어긋나지 않게.
 * 읽는 곳은 우리 빈 로컬 페이지(`shell/ua-probe.html`)뿐이다. 네이버 페이지에 JS 를 넣지 않는다.
 * about:blank 은 secure context 가 아니라 `navigator.userAgentData` 가 없다(실측) — 그래서 파일 페이지.
 */
async function readEngineClientHints(partition: string): Promise<ClientHintHeaders | null> {
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await view.webContents.loadFile(UA_PROBE_FILE);
    const data = (await view.webContents.executeJavaScript(
      'navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null',
    )) as UserAgentDataLow | null;
    return data ? clientHintHeaders(data) : null;
  } finally {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}

/** 실패해도 앱은 뜬다 — 헤더 없이 간다(지문 비교 전과 같은 상태) · 시간 상한 5초 */
async function addClientHintHeaders(ses: Session, partition: string): Promise<void> {
  let hints: ClientHintHeaders | null = null;
  try {
    hints = await withTimeout(readEngineClientHints(partition), UA_PROBE_TIMEOUT_MS);
  } catch (error) {
    console.warn('[naver-session] UA 값을 못 읽어 Sec-CH-UA 헤더를 안 넣습니다', error);
    return;
  }
  if (!hints) {
    console.warn('[naver-session] navigator.userAgentData 가 없어 Sec-CH-UA 헤더를 안 넣습니다');
    return;
  }
  const value = hints;
  // secure 요청에만(크롬과 같음) — filter 로 file: · 비보안 http: 는 main 까지 오지 않는다
  const filter = { urls: ['https://*/*', 'wss://*/*', 'http://127.0.0.1/*', 'http://localhost/*'] };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const already = Object.keys(details.requestHeaders).some((h) => h.toLowerCase() === 'sec-ch-ua');
    // 크롬은 sec-ch-ua* 를 다른 헤더보다 «앞»에 보낸다(지문 비교 · 순서도 표시다) — 객체 순서로 앞에 둔다
    callback({ requestHeaders: already ? details.requestHeaders : { ...value, ...details.requestHeaders } });
  });
}

export async function prepareSessions(): Promise<void> {
  const naver = session.fromPartition(APP_CONFIG.naverPartition);
  naver.setUserAgent(chromiumLikeUserAgent(app.userAgentFallback, app.getName(), app.getVersion()), NAVER_ACCEPT_LANGUAGES);
  denyRiskyPermissions(naver);
  await addClientHintHeaders(naver, APP_CONFIG.naverPartition);

  const admin = session.fromPartition(APP_CONFIG.adminPartition);
  // `--lang=ko-KR`(main.ts)은 앱 전체에 걸린다 — 서버 어드민 요청의 Accept-Language 는 OS 언어 그대로 둔다(어드민 화면 언어가 바뀌지 않게)
  const systemLanguages = app.getPreferredSystemLanguages();
  if (systemLanguages.length > 0) admin.setUserAgent(admin.getUserAgent(), systemLanguages.join(','));
  denyRiskyPermissions(admin);
}
