import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import {
  assetPathFromUrl,
  isAllowedPluginNavigation,
  isAllowedPluginRequest,
  isPluginUiUrl,
  mimeTypeOf,
  openAsset,
  PLUGIN_UI_BLOCKED_PROXY,
  pluginUiCsp,
  pluginUiProxyConfig,
  pluginUiPartition,
  pluginUiUrl,
  resolveAssetPath,
} from './plugin-ui-policy.js';

function manifestOf(input: Record<string, unknown>): PluginManifest {
  const result = parseManifest({ name: 'viewy', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onView:viewy.main'], ...input });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

const VIEWY = manifestOf({
  ui: 'ui/index.html',
  contributes: { views: [{ id: 'viewy.main', title: 'Viewy', where: 'pane' }] },
  permissions: ['host:api.example.com', 'host:*.example.org'],
});

describe('화면 주소 · 저장 공간', () => {
  it('첫 주소 = cmh-plugin://<이름>/<ui>?view=<id> · 선언 안 한 뷰 · ui 없음은 null', () => {
    expect(pluginUiUrl(VIEWY, 'viewy.main')).toBe('cmh-plugin://viewy/ui/index.html?view=viewy.main');
    expect(pluginUiUrl(VIEWY, 'other')).toBeNull();
    expect(pluginUiUrl(manifestOf({ contributes: { views: [{ id: 'viewy.main', title: 'V', where: 'pane' }] } }), 'viewy.main')).toBeNull();
  });
  it('partition 은 플러그인마다 · 메모리(persist: 없음)', () => {
    expect(pluginUiPartition('viewy')).toBe('plugin-ui-viewy');
    expect(pluginUiPartition('viewy').startsWith('persist:')).toBe(false);
  });
  it('isPluginUiUrl — 호스트가 그 플러그인 이름 · 사용자/포트 없음', () => {
    expect(isPluginUiUrl('viewy', 'cmh-plugin://viewy/ui/index.html')).toBe(true);
    for (const bad of ['cmh-plugin://other/ui/index.html', 'cmh-plugin://user@viewy/x', 'cmh-plugin://viewy:81/x', 'https://viewy/x', 'file:///etc/passwd', 'not a url']) {
      expect(isPluginUiUrl('viewy', bad)).toBe(false);
    }
  });
  it('이동 잠금 — 자기 화면만', () => {
    expect(isAllowedPluginNavigation('viewy', 'cmh-plugin://viewy/ui/other.html')).toBe(true);
    expect(isAllowedPluginNavigation('viewy', 'https://api.example.com/')).toBe(false);
    expect(isAllowedPluginNavigation('viewy', 'cmh-plugin://other/ui/index.html')).toBe(false);
  });
});

describe('네트워크 거름(session.webRequest)', () => {
  const allowed = (url: string): boolean => isAllowedPluginRequest('viewy', VIEWY.permissions, url);
  it('자기 화면 · data: · 자기 blob: · 선언한 https 호스트만', () => {
    expect(allowed('cmh-plugin://viewy/ui/app.js')).toBe(true);
    expect(allowed('data:image/png;base64,AA==')).toBe(true);
    expect(allowed('blob:cmh-plugin://viewy/1234')).toBe(true);
    expect(allowed('https://api.example.com/v1')).toBe(true);
    expect(allowed('https://a.example.org/x')).toBe(true);
  });
  it('나머지는 막는다 — 남의 플러그인 · http · 선언 안 한 호스트 · file · 남의 blob', () => {
    for (const url of ['cmh-plugin://other/x.js', 'http://api.example.com/', 'https://evil.com/', 'https://example.org/', 'file:///etc/passwd', 'blob:cmh-plugin://other/1', 'ws://api.example.com/']) {
      expect(allowed(url)).toBe(false);
    }
  });
  it('CSP 에 선언한 https 호스트만 connect-src 로', () => {
    const csp = pluginUiCsp(VIEWY);
    expect(csp).toContain("connect-src 'self' https://api.example.com https://*.example.org");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(pluginUiCsp(manifestOf({}))).toContain("connect-src 'self';");
  });
  it('mime', () => {
    expect(mimeTypeOf('a/B.HTML')).toBe('text/html; charset=utf-8');
    expect(mimeTypeOf('a.wasm')).toBe('application/octet-stream');
  });
});

describe('요청 주소 → 상대경로(assetPathFromUrl)', () => {
  it('디코드한 마디 · 남의 플러그인은 null', () => {
    expect(assetPathFromUrl('viewy', 'cmh-plugin://viewy/ui/my%20file.js?x=1#h')).toBe('ui/my file.js');
    expect(assetPathFromUrl('viewy', 'cmh-plugin://other/ui/a.js')).toBeNull();
    expect(assetPathFromUrl('viewy', 'cmh-plugin://viewy/')).toBeNull();
  });
  it('인코딩된 / · \\ · NUL · 깨진 인코딩은 null · 주소 해석이 지운 .. 는 폴더 밖으로 못 나간다', () => {
    for (const bad of ['cmh-plugin://viewy/ui%2F..%2F..%2Fsecret', 'cmh-plugin://viewy/ui%5Csecret', 'cmh-plugin://viewy/a%00b', 'cmh-plugin://viewy/%E0%A4%A']) {
      expect(assetPathFromUrl('viewy', bad)).toBeNull();
    }
    // WHATWG URL 은 `..` · `%2e%2e` 마디를 해석 때 접는다 — 결과는 루트 안
    expect(assetPathFromUrl('viewy', 'cmh-plugin://viewy/ui/../../../etc/passwd')).toBe('etc/passwd');
    expect(assetPathFromUrl('viewy', 'cmh-plugin://viewy/%2e%2e/%2e%2e/etc/passwd')).toBe('etc/passwd');
  });
});

describe('폴더 안 파일 고르기(resolveAssetPath) — 심볼릭 링크 탈출 막기', () => {
  let base = '';
  let dir = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'cmh-plugin-ui-'));
    dir = join(base, 'viewy');
    await mkdir(join(dir, 'ui'), { recursive: true });
    await writeFile(join(dir, 'ui', 'index.html'), '<p>hi</p>');
    await writeFile(join(base, 'secret.txt'), 'SECRET');
    await mkdir(join(base, 'outside-dir'));
    await writeFile(join(base, 'outside-dir', 'x.js'), 'x');
    await symlink(join(base, 'secret.txt'), join(dir, 'ui', 'leak.txt'));
    await symlink(join(base, 'outside-dir'), join(dir, 'linked'));
    await symlink(join(dir, 'ui', 'index.html'), join(dir, 'ui', 'alias.html'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('폴더 안 실제 파일은 고른다', async () => {
    expect(await resolveAssetPath(dir, 'ui/index.html')).toMatchObject({ ok: true, mimeType: 'text/html; charset=utf-8', size: 9 });
  });
  it('.. · 절대경로 · 드라이브 경로 · UNC · URL · 역슬래시 · NUL → 400', async () => {
    for (const bad of ['../secret.txt', 'ui/../../secret.txt', '/etc/passwd', join(base, 'secret.txt'), 'C:\\Windows\\win.ini', '\\\\srv\\share', 'file:///etc/passwd', 'ui\\index.html', 'ui/a\0b', '']) {
      expect(await resolveAssetPath(dir, bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
  it('폴더 밖을 가리키는 파일 링크 · 폴더 링크 → 403', async () => {
    expect(await resolveAssetPath(dir, 'ui/leak.txt')).toMatchObject({ ok: false, status: 403 });
    expect(await resolveAssetPath(dir, 'linked/x.js')).toMatchObject({ ok: false, status: 403 });
  });
  it('폴더 안을 가리키는 링크도 거부(403) · 없는 파일 · 폴더 → 404', async () => {
    expect(await resolveAssetPath(dir, 'ui/alias.html')).toMatchObject({ ok: false, status: 403 });
    expect(await resolveAssetPath(dir, 'ui/none.html')).toMatchObject({ ok: false, status: 404 });
    expect(await resolveAssetPath(dir, 'ui')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('openAsset — 하드 링크 · 핸들로 읽기(검수 8 🟢1 · 🟢2)', () => {
  let base = '';
  let dir = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'cmh-plugin-ui-open-'));
    dir = join(base, 'viewy');
    await mkdir(join(dir, 'ui'), { recursive: true });
    await writeFile(join(dir, 'ui', 'index.html'), '<p>hi</p>');
    await writeFile(join(dir, 'ui', 'empty.txt'), '');
    await writeFile(join(base, 'secret.txt'), 'SECRET');
    await link(join(base, 'secret.txt'), join(dir, 'ui', 'hard.txt'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('폴더 밖 파일의 하드 링크(nlink 2) → 403 · resolveAssetPath 도 같다', async () => {
    expect(await openAsset(dir, 'ui/hard.txt')).toMatchObject({ ok: false, status: 403, reason: 'hard links are not served from a plugin folder' });
    expect(await resolveAssetPath(dir, 'ui/hard.txt')).toMatchObject({ ok: false, status: 403 });
  });

  it('보통 파일은 열린 핸들을 돌려준다(그 핸들로 읽는다) · 빈 파일도', async () => {
    const opened = await openAsset(dir, 'ui/index.html');
    if (!opened.ok) throw new Error(opened.reason);
    try {
      expect((await opened.handle.readFile()).toString()).toBe('<p>hi</p>');
      expect(opened.size).toBe(9);
    } finally {
      await opened.handle.close();
    }
    const empty = await openAsset(dir, 'ui/empty.txt');
    expect(empty).toMatchObject({ ok: true, size: 0 });
    if (empty.ok) await empty.handle.close();
  });
});

describe('WebRTC 막기 — 막힌 프록시 설정(검수 8 🟡1)', () => {
  it('<-loopback> 이 맨 앞 · 선언한 호스트는 443 만 bypass', () => {
    expect(pluginUiProxyConfig(VIEWY.permissions)).toEqual({
      mode: 'fixed_servers',
      proxyRules: PLUGIN_UI_BLOCKED_PROXY,
      proxyBypassRules: '<-loopback>,api.example.com:443,*.example.org:443',
    });
    expect(pluginUiProxyConfig([]).proxyBypassRules).toBe('<-loopback>');
    expect(PLUGIN_UI_BLOCKED_PROXY).toMatch(/\.invalid:\d+$/);
  });
});
