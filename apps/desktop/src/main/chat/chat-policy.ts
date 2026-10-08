// R6-a — 챗 pane(TabKind 'chat')의 규칙. electron 을 import 하지 않는다(vitest 로 시험한다) — Electron 쪽은 chat-pane-host.ts.
// 렌더러 = CmhAiAgent `apps/chat-app`(Vue 3.5 · Vite 8)의 빌드 산출. 이 저장소에 복사본을 두지 않는다(PLAN R6 · 합의안 4):
//   빌드 때 scripts/fetch-chat-app.mjs 가 그 dist 를 apps/desktop/dist/chat-app/ 로 복사하고, 여기 규칙대로 `app://chat/…` 로 연다.
//
// 주소: `app://chat/<dist 안 상대경로>` — scheme 이름 `app` 은 PLAN R6 §4 «protocol.handle('app', …)» · §3 «`app://chat/` → 빌드 산출 폴더» 그대로.
//   origin 이 `app://chat` 하나 → CSP 'self' = chat-app dist 만. file:// 는 쿠키 · 상대경로 · origin 이 깨진다(PLAN R6 §3).
// 저장 공간: `persist:chat` 【AI 임시 결정】 — 대화 화면 설정(localStorage)이 재시작 뒤에도 남게. 어드민 · 네이버 · 빈 탭 · 플러그인과 따로.
// 파일 고르기 · 읽기는 plugin/plugin-ui-policy.ts 의 openAsset 을 그대로 쓴다(`..` · 절대경로 · 심볼릭 · 하드 링크 거부 · O_NOFOLLOW 핸들로 읽기).
//   이 파일은 URL → 상대경로와 응답 머리(CSP · nosniff)만 정한다.

/** PLAN R6 §4 — main.ts 가 app ready 전에 protocol.registerSchemesAsPrivileged([...]) 에 넣는다(cmh-plugin 과 한 배열 · 그 함수는 한 번만) */
export const CHAT_SCHEME = 'app';
export const CHAT_HOST = 'chat';
export const CHAT_ORIGIN = `${CHAT_SCHEME}://${CHAT_HOST}`;
export const CHAT_ENTRY_URL = `${CHAT_ORIGIN}/index.html`;
/** 【AI 임시 결정】 persist: = 디스크에 남김(대화 화면 설정 · 테마) */
export const CHAT_PARTITION = 'persist:chat';

/** electron CustomScheme 꼴 그대로 — PLUGIN_UI_SCHEME_PRIVILEGES 와 같은 권한(표준 · secure · fetch) */
export const CHAT_SCHEME_PRIVILEGES = Object.freeze({
  scheme: CHAT_SCHEME,
  privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: false }),
});

/**
 * 【AI 임시 결정】 CmhAiAgent chat-app 의 기본 빌드(`pnpm run build`)는 vite.config.ts 의 `base: '/bundles/cmhaiagent/chat-app/'` 로
 * 절대 주소를 쓴다(Shopware 플러그인 공개 폴더용). 그 산출을 그대로 가져와도 열리게 이 앞부분을 떼고 dist 안 경로로 본다.
 * 상대 base(`vite build --base ./`) 산출이면 이 접두가 안 나온다.
 */
export const CHAT_APP_SHOP_BASE = 'bundles/cmhaiagent/chat-app/';

/** 【AI 임시 결정】 챗 partition 의 막힌 프록시 — `.invalid`(RFC 6761)라 어디에도 닿지 않는다. WebRTC TURN/TCP 를 여기로 보낸다(plugin-ui-policy.ts PLUGIN_UI_BLOCKED_PROXY 와 같은 까닭) */
export const CHAT_BLOCKED_PROXY = 'http://chat-blocked.invalid:9';

/** session.setProxy 값 — 모든 연결을 막힌 프록시로 · `<-loopback>` 으로 localhost 도 프록시로(R6-a 는 바깥 네트워크 0 · 서버 호출은 R6-b 가 preload 로) */
export const CHAT_PROXY_CONFIG = Object.freeze({ mode: 'fixed_servers' as const, proxyRules: CHAT_BLOCKED_PROXY, proxyBypassRules: '<-loopback>' });

/** 화면마다 거는 WebRTC 정책(plugin-view-host.ts PLUGIN_UI_WEBRTC_POLICY 와 같은 값) */
export const CHAT_WEBRTC_POLICY = 'disable_non_proxied_udp';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 챗 화면 주소인가 — scheme · 호스트가 맞고 사용자 · 비밀번호 · 포트가 없다 */
export function isChatUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === `${CHAT_SCHEME}:` && parsed.hostname === CHAT_HOST
    && parsed.username === '' && parsed.password === '' && parsed.port === '';
}

/** 셸 명령(newTab kind 'chat')이 줄 수 있는 주소 — 첫 화면 하나(쿼리 · 조각 없이). 그 밖은 tab-view-policy 가 거절한다 */
export function isChatEntryUrl(url: string): boolean {
  return url === CHAT_ENTRY_URL;
}

/** 이동 잠금 — 챗 화면 주소 밖으로는 못 간다 */
export function isAllowedChatNavigation(url: string): boolean {
  return isChatUrl(url);
}

/** 챗 화면이 내는 요청(session.webRequest) — 자기 주소 · data: · 자기 origin 의 blob: · devtools: 만(R6-a 는 바깥 네트워크 0) */
export function isAllowedChatRequest(url: string): boolean {
  if (isChatUrl(url)) return true;
  if (url.startsWith('data:')) return true;
  if (url.startsWith('blob:')) return isChatUrl(url.slice('blob:'.length));
  // 개발판 개발자 도구가 자기 자원을 읽는다(devTools 는 개발판만 켠다)
  if (url.startsWith('devtools:')) return true;
  return false;
}

/**
 * 요청 주소 → dist 안 상대경로(디코드한 것). 남의 주소 · 깨진 인코딩 · 인코딩된 `/` `\` · `.` `..` · NUL 은 null.
 * 빈 경로(`app://chat/`)는 index.html. CHAT_APP_SHOP_BASE 로 시작하면 그 앞부분을 뗀다.
 */
export function chatAssetPathFromUrl(url: string): string | null {
  if (!isChatUrl(url)) return null;
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const decoded: string[] = [];
  for (const raw of parsed.pathname.split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '..' || segment === '.' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null;
    decoded.push(segment);
  }
  let rel = decoded.join('/');
  // 마디를 `/` 로 다시 이으면 끝 `/` 가 사라진다 — base 그 자체(`…/chat-app`)도 뿌리로 본다
  if (rel === CHAT_APP_SHOP_BASE.slice(0, -1)) rel = '';
  else if (rel.startsWith(CHAT_APP_SHOP_BASE)) rel = rel.slice(CHAT_APP_SHOP_BASE.length);
  return rel === '' ? 'index.html' : rel;
}

/**
 * 챗 화면 응답 CSP 【AI 임시 결정】 — plugin-ui-policy.ts pluginUiCsp 꼴에서 둘만 다르다:
 *   ①`'wasm-unsafe-eval'` — chat-app 의 코드 블록 색칠(shiki `createHighlighter` · components/ai-elements/code-block/utils.ts:41)이
 *     기본 정규식 엔진(oniguruma WebAssembly)을 쓴다(2026-10-08 빌드 산출 index-*.js 에 `WebAssembly.instantiate` 있음 · `eval(` ·
 *     `new Function(` · `new Worker` 는 grep 0). 자바스크립트 eval 은 그대로 막힌다.
 *   ②connect-src 는 'self' 만(R6-a 는 서버 호출 0 · R6-b 가 preload IPC 로 잇는다).
 */
export function chatCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** 대신 보이는 안내 화면(chat-app dist 가 없을 때) — 스크립트 0 · 스타일은 inline 만 */
export function chatFallbackCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

export function chatResponseHeaders(mimeType: string, csp: string = chatCsp()): Record<string, string> {
  return {
    'Content-Type': mimeType,
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

/** 안내 화면 스니펫 키(R8 · 세 장에 다 있어야 한다 — chat-policy.test.ts 가 본다) */
export const CHAT_SNIPPET_KEYS = Object.freeze({
  fallbackTitle: 'cmh-hub-app.chat.fallbackTitle',
  fallbackBody: 'cmh-hub-app.chat.fallbackBody',
  fallbackEnv: 'cmh-hub-app.chat.fallbackEnv',
});

/** 안내 화면에 그대로 보이는 명령(코드라 번역하지 않는다 · fetch-chat-app.mjs 머리 주석과 같은 차례) */
export const CHAT_BUILD_COMMANDS: readonly string[] = [
  'cd ../CmhAiAgent && pnpm install --frozen-lockfile',
  'cd apps/chat-app && pnpm exec vite build --base ./ --outDir dist --emptyOutDir',
  'cd ../../../cmh-hub-app && pnpm --filter desktop build',
];

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** 안내 화면 HTML — 글자는 부르는 쪽이 스니펫에서 꺼내 넘긴다(여기는 이스케이프만) */
export function renderChatFallbackHtml(text: { lang: string; title: string; body: string; env: string }): string {
  const commands = CHAT_BUILD_COMMANDS.map((c) => escapeHtml(c)).join('\n');
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(text.lang)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(text.title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#f7f9fb;color:#1f2a37}' +
      'h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.6;max-width:640px}' +
      'pre{background:#fff;border:1px solid #d9e1ea;border-radius:6px;padding:12px;font-size:12px;overflow:auto}' +
      'code{font-family:ui-monospace,monospace}@media (prefers-color-scheme:dark){body{background:#151a21;color:#e3e8ef}pre{background:#1d242d;border-color:#2c3540}}</style>',
    '</head>',
    '<body data-chat-fallback="1">',
    `<h1>${escapeHtml(text.title)}</h1>`,
    `<p>${escapeHtml(text.body)}</p>`,
    `<pre><code>${commands}</code></pre>`,
    `<p>${escapeHtml(text.env)}</p>`,
    '</body></html>',
  ].join('\n');
}
