// R2-b — 플러그인 화면(App 꼴 · 합의안 5)의 규칙. 렌더러에 플러그인 ESM 을 import() 하지 않고, 플러그인마다 «따로 된 WebContentsView» 가
// 자기 폴더의 HTML 만 연다. 여기는 electron 을 import 하지 않는다(vitest 로 시험한다) — Electron 쪽은 plugin-view-host.ts.
//
// 주소: `cmh-plugin://<플러그인 이름>/<폴더 안 상대경로>` 【AI 임시 결정】 사용자 프로토콜(file:// 대신) —
//   ①origin 이 플러그인마다 따로(`cmh-plugin://plugin-hello`) → CSP 'self' 가 그 플러그인 폴더만 뜻한다 ②응답 머리에 CSP 를 붙일 수 있다
//   ③file:// 는 origin 이 불투명해 이동 잠금 · 상대경로 검사가 흐려진다. 표준 scheme 으로 쓰려면 main.ts 가 app ready 전에
//   PLUGIN_UI_SCHEME_PRIVILEGES 를 protocol.registerSchemesAsPrivileged 에 넣어야 한다(그 함수는 한 번만 부를 수 있다 — 다른 scheme 과 한 배열로).
// 저장 공간: `plugin-ui-<이름>`(앞에 persist: 없음 = 메모리) 【AI 임시 결정】 — 쿠키 · localStorage 를 디스크에 남기지 않는다.
//   오래 둘 값은 host:settings · host:data 로(권한 검사를 지나는 길). 플러그인끼리는 partition 이 달라 저장소를 못 나눠 본다.
// 파일 고르기: 경로 마디에 `..` · 절대경로 · NUL · 역슬래시 · 인코딩된 `/` 를 거부하고, realpath 가 «폴더 + 마디» 와 한 글자라도 다르면
//   (경로 어딘가가 심볼릭 링크) 거부한다 — 폴더 안을 가리키는 링크도 거부(start 때 inspectPluginFolder 와 같은 태도).
//   하드 링크(nlink > 1)도 403(검수 8 🟢1 — 폴더 밖 파일과 같은 inode 일 수 있다). 읽기는 연 파일 핸들로만(검수 8 🟢2 — stat 과 읽기 사이에
//   파일이 바뀌는 TOCTOU 를 줄인다): 열고 → 핸들 stat → realpath 다시 · lstat 의 dev/ino 가 핸들과 같은지 본 뒤 그 핸들로 읽는다.

import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isSafeRelativePath, type PluginManifest, type PluginPermission } from './plugin-manifest.js';
import { checkHostAccess } from './plugin-permissions.js';

export const PLUGIN_UI_SCHEME = 'cmh-plugin';

/** main.ts 가 app ready 전에 protocol.registerSchemesAsPrivileged([...]) 에 넣는다(electron CustomScheme 꼴 그대로) */
export const PLUGIN_UI_SCHEME_PRIVILEGES = Object.freeze({
  scheme: PLUGIN_UI_SCHEME,
  privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: false }),
});

/** 【AI 임시 결정】 한 파일 상한 — 플러그인 화면 파일은 작다 · 큰 것을 통째로 메모리에 올리지 않게 */
export const PLUGIN_UI_MAX_FILE_BYTES = 10 * 1024 * 1024;

export function pluginUiPartition(pluginName: string): string {
  return `plugin-ui-${pluginName}`;
}

export function pluginUiOrigin(pluginName: string): string {
  return `${PLUGIN_UI_SCHEME}://${pluginName}`;
}

/** 안전한 상대경로 → 마디 목록(빈 마디 · `.` 는 뺀다). 안전하지 않으면 null */
function segmentsOf(relPath: string): string[] | null {
  if (!isSafeRelativePath(relPath)) return null;
  if (relPath.includes('\\')) return null; // 화면 주소는 `/` 만 — Windows 꼴 역슬래시는 받지 않는다
  const segments = relPath.split('/').filter((s) => s !== '' && s !== '.');
  return segments.length > 0 ? segments : null;
}

/** 화면 첫 주소. manifest.ui 가 없거나 그 뷰를 선언하지 않았으면 null */
export function pluginUiUrl(manifest: PluginManifest, viewId: string): string | null {
  if (manifest.ui === undefined) return null;
  if (!manifest.contributes.views.some((v) => v.id === viewId)) return null;
  const segments = segmentsOf(manifest.ui);
  if (!segments) return null;
  return `${pluginUiOrigin(manifest.name)}/${segments.map(encodeURIComponent).join('/')}?view=${encodeURIComponent(viewId)}`;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 그 플러그인의 화면 주소인가 — scheme · 호스트(=플러그인 이름)가 맞고 사용자 · 비밀번호 · 포트가 없다 */
export function isPluginUiUrl(pluginName: string, url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === `${PLUGIN_UI_SCHEME}:` && parsed.hostname === pluginName
    && parsed.username === '' && parsed.password === '' && parsed.port === '';
}

/** 화면이 다른 곳으로 이동하려 할 때 — 자기 화면 주소만 */
export function isAllowedPluginNavigation(pluginName: string, url: string): boolean {
  return isPluginUiUrl(pluginName, url);
}

/**
 * 화면이 내는 네트워크 요청(session.webRequest) — 자기 화면 주소 · data: · 자기 origin 의 blob: · 매니페스트 `host:` 로 선언한 https 만.
 * 플러그인 프로세스는 네트워크를 못 막는다(Node 24 에 --allow-net 없음).
 * ⚠ 화면도 이 검사만으로는 다 못 막는다(검수 8 🟡1 실측 · Electron 44.5.1 · xvfb): WebRTC(RTCPeerConnection)의 STUN/TURN 은 CSP 와
 *   webRequest 를 둘 다 지나지 않는다. 그래서 plugin-view-host.ts 가 화면마다 setWebRTCIPHandlingPolicy('disable_non_proxied_udp')(UDP 0)와
 *   플러그인 partition 의 막힌 프록시(pluginUiProxyConfig — TURN/TCP 를 거기로 보낸다)를 같이 건다. 결과 숫자는 그 파일 머리 주석.
 */
export function isAllowedPluginRequest(pluginName: string, permissions: readonly PluginPermission[], url: string): boolean {
  if (isPluginUiUrl(pluginName, url)) return true;
  if (url.startsWith('data:')) return true;
  if (url.startsWith('blob:')) return isPluginUiUrl(pluginName, url.slice('blob:'.length));
  return checkHostAccess(permissions, url).allowed;
}

/**
 * 【AI 임시 결정】 플러그인 partition 의 막힌 프록시 — 이름이 `.invalid`(RFC 6761 · DNS 가 늘 실패)라 어디에도 닿지 않는다.
 * WebRTC 의 TURN/TCP 는 webRequest · CSP 를 지나지 않지만 session 프록시는 따른다 → 여기로 보내 막는다(검수 8 🟡1 · 실측은 plugin-view-host.ts 머리 주석).
 */
export const PLUGIN_UI_BLOCKED_PROXY = 'http://plugin-ui-blocked.invalid:9';

/** session.setProxy 에 넣을 값(electron ProxyConfig 꼴 그대로 · electron 을 import 하지 않으려고 여기 꼴을 적는다) */
export interface PluginUiProxyConfig {
  readonly mode: 'fixed_servers';
  readonly proxyRules: string;
  readonly proxyBypassRules: string;
}

/**
 * 모든 연결을 막힌 프록시로 · 매니페스트 `host:` 로 선언한 호스트의 443 포트만 바로(bypass — 포트를 안 붙이면 선언한 호스트의 아무 포트로나
 * TURN/TCP 가 나갔다 · 실측). `<-loopback>` = Chromium 이 localhost · 127.0.0.1 을
 * 늘 프록시 밖으로 빼는 규칙을 끈다(안 끄면 루프백 TURN 이 그대로 나간다). 선언한 https fetch 는 webRequest 가 따로 본다.
 * ⚠ `<-loopback>` 은 «맨 앞» 이어야 한다 — 실측(Electron 44.5.1 · session.resolveProxy): `127.0.0.1,<-loopback>` 이면 선언한 127.0.0.1 도
 *   PROXY(뒤 규칙이 이긴다) · `<-loopback>,127.0.0.1` 이면 127.0.0.1 만 DIRECT. `*.example.com` 은 example.com 자체를 안 뺀다(checkHostAccess 와 같다).
 */
export function pluginUiProxyConfig(permissions: readonly PluginPermission[]): PluginUiProxyConfig {
  const declared = permissions.filter((p): p is Extract<PluginPermission, { kind: 'host' }> => p.kind === 'host').map((p) => p.host);
  return { mode: 'fixed_servers', proxyRules: PLUGIN_UI_BLOCKED_PROXY, proxyBypassRules: ['<-loopback>', ...declared.map((host) => `${host}:443`)].join(',') };
}

/** 요청 주소 → 폴더 안 상대경로(디코드한 것). 남의 플러그인 주소 · 깨진 인코딩 · 인코딩된 `/` `\` · `..` 는 null */
export function assetPathFromUrl(pluginName: string, url: string): string | null {
  if (!isPluginUiUrl(pluginName, url)) return null;
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
  return decoded.length > 0 ? decoded.join('/') : null;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export type AssetResolution =
  | { readonly ok: true; readonly file: string; readonly size: number; readonly mimeType: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 413; readonly reason: string };

export type OpenedAsset =
  | { readonly ok: true; readonly file: string; readonly size: number; readonly mimeType: string; readonly handle: FileHandle }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 413; readonly reason: string };

/** O_NOFOLLOW 가 있는 OS(Linux · macOS)는 마지막 마디가 링크면 열기부터 실패 · Windows 는 0(위 realpath · lstat 대조가 막는다) */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * 플러그인 폴더 안의 실제 파일 하나를 «연다»(심볼릭 · 하드 링크 탈출 막기). 예외를 던지지 않는다. ok 면 부르는 쪽이 handle 을 닫는다.
 * relPath = 매니페스트 꼴 상대경로(`ui/index.html`) — 절대경로 · `..` · 역슬래시 → 400 · 경로에 링크가 끼거나 하드 링크면 403.
 */
export async function openAsset(pluginDir: string, relPath: string): Promise<OpenedAsset> {
  const segments = segmentsOf(relPath);
  if (!segments) return { ok: false, status: 400, reason: 'path must be a relative path inside the plugin folder' };
  let realDir: string;
  try {
    realDir = await realpath(pluginDir);
  } catch {
    return { ok: false, status: 404, reason: 'plugin folder not found' };
  }
  const candidate = join(realDir, ...segments);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { ok: false, status: 404, reason: 'not found' };
  }
  if (real !== candidate) return { ok: false, status: 403, reason: 'symbolic links are not served from a plugin folder' };
  let handle: FileHandle;
  try {
    handle = await open(candidate, OPEN_FLAGS);
  } catch (error) {
    // ELOOP = 열기 직전에 마지막 마디가 링크로 바뀌었다(O_NOFOLLOW)
    return (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? { ok: false, status: 403, reason: 'symbolic links are not served from a plugin folder' }
      : { ok: false, status: 404, reason: 'not found' };
  }
  const refuse = async (result: Extract<OpenedAsset, { ok: false }>): Promise<OpenedAsset> => {
    await handle.close().catch(() => undefined);
    return result;
  };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return await refuse({ ok: false, status: 404, reason: 'not a file' });
    if (info.nlink > 1) return await refuse({ ok: false, status: 403, reason: 'hard links are not served from a plugin folder' });
    if (info.size > PLUGIN_UI_MAX_FILE_BYTES) return await refuse({ ok: false, status: 413, reason: `file larger than ${PLUGIN_UI_MAX_FILE_BYTES} bytes` });
    // 연 뒤에 다시 — 경로가 여전히 링크 없이 같은 파일(dev · ino)을 가리키는가(realpath ↔ open 사이에 폴더 마디가 바뀌었으면 거부)
    const [again, named] = await Promise.all([realpath(candidate), lstat(candidate)]);
    if (again !== candidate || named.dev !== info.dev || named.ino !== info.ino) {
      return await refuse({ ok: false, status: 403, reason: 'file changed while opening' });
    }
    return { ok: true, file: candidate, size: info.size, mimeType: mimeTypeOf(candidate), handle };
  } catch {
    return await refuse({ ok: false, status: 404, reason: 'not found' });
  }
}

/**
 * openAsset 으로 열어 보고 닫는다(화면 첫 파일이 있는지 · 쓸 수 있는지만 볼 때). 예외를 던지지 않는다.
 * relPath = 매니페스트 꼴 상대경로(`ui/index.html`) — 절대경로 · `..` · 역슬래시 → 400 · 경로에 링크가 끼거나 하드 링크면 403.
 */
export async function resolveAssetPath(pluginDir: string, relPath: string): Promise<AssetResolution> {
  const opened = await openAsset(pluginDir, relPath);
  if (!opened.ok) return opened;
  await opened.handle.close().catch(() => undefined);
  return { ok: true, file: opened.file, size: opened.size, mimeType: opened.mimeType };
}

/**
 * 화면 응답 CSP 【AI 임시 결정】 — 스크립트는 자기 폴더 파일만(inline · eval 없음) · 스타일은 inline 허용(SFC 번들이 흔히 쓴다) ·
 * fetch 는 자기 origin + 선언한 https 호스트 · iframe · object · form 전송 · 남이 이 화면을 끼우기 전부 막음.
 */
export function pluginUiCsp(manifest: Pick<PluginManifest, 'permissions'>): string {
  const hosts = manifest.permissions.filter((p): p is Extract<PluginPermission, { kind: 'host' }> => p.kind === 'host').map((p) => `https://${p.host}`);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${hosts.length > 0 ? ` ${hosts.join(' ')}` : ''}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function pluginUiResponseHeaders(manifest: Pick<PluginManifest, 'permissions'>, mimeType: string): Record<string, string> {
  return {
    'Content-Type': mimeType,
    'Content-Security-Policy': pluginUiCsp(manifest),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
