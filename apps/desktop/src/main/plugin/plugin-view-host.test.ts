// R2-b · 검수 8 🟡4 — plugin-view-host.ts 를 electron 없이 시험한다(vi.mock 으로 ipcMain · session · WebContentsView 를 가짜로).
// 실제 Chromium 동작(WebRTC · CSP · 이동 잠금)은 xvfb 로 따로 쟀다 — 여기서는 «무엇을 어떤 차례로 거는가» 와 파일 응답 · 네트워크 거름 처리기를 본다.
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RequestHandler = (request: Request) => Promise<Response>;
type BeforeRequest = (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void;

const events: string[] = [];
class FakeSession {
  protocolHandler: RequestHandler | null = null;
  beforeRequest: BeforeRequest | null = null;
  proxy: unknown = null;
  protocol = { handle: (_scheme: string, handler: RequestHandler) => { this.protocolHandler = handler; } };
  webRequest = { onBeforeRequest: (fn: BeforeRequest) => { this.beforeRequest = fn; } };
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  on() {}
  async setProxy(config: unknown) { events.push('setProxy'); this.proxy = config; }
}
const sessions = new Map<string, FakeSession>();
let nextId = 1;
class FakeWebContents {
  readonly id = nextId++;
  policy: string | null = null;
  url: string | null = null;
  on() {}
  once() {}
  setWindowOpenHandler() {}
  setWebRTCIPHandlingPolicy(policy: string) { events.push(`webrtc:${policy}`); this.policy = policy; }
  async loadURL(url: string) { events.push('loadURL'); this.url = url; }
  isDestroyed() { return false; }
  close() {}
}
class FakeView {
  readonly webContents = new FakeWebContents();
  constructor(readonly options: { webPreferences: Record<string, unknown> }) {}
}

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: {
    fromPartition: (partition: string) => {
      let s = sessions.get(partition);
      if (!s) {
        s = new FakeSession();
        sessions.set(partition, s);
      }
      return s;
    },
  },
  WebContentsView: FakeView,
}));

const { PluginViewHost, PLUGIN_UI_WEBRTC_POLICY } = await import('./plugin-view-host.js');
const { parseManifest } = await import('./plugin-manifest.js');
const { pluginUiPartition, PLUGIN_UI_BLOCKED_PROXY } = await import('./plugin-ui-policy.js');

function manifestOf(name: string) {
  const result = parseManifest({
    name, version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', ui: 'ui/index.html', activationEvents: [`onView:${name}.main`],
    contributes: { views: [{ id: `${name}.main`, title: name, where: 'pane' }] },
    permissions: ['host:api.example.com'],
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

let base = '';
let dir = '';
let linkedDir = '';
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'cmh-plugin-view-'));
  dir = join(base, 'viewy');
  await mkdir(join(dir, 'ui'), { recursive: true });
  await writeFile(join(dir, 'main.mjs'), 'export {}');
  await writeFile(join(dir, 'ui', 'index.html'), '<p>hi</p>');
  await writeFile(join(base, 'secret.txt'), 'SECRET');
  // 폴더에 심볼릭 링크가 든 플러그인(open 이 거부해야 한다)
  linkedDir = join(base, 'linky');
  await mkdir(join(linkedDir, 'ui'), { recursive: true });
  await writeFile(join(linkedDir, 'ui', 'index.html'), '<p>x</p>');
  await symlink(join(base, 'secret.txt'), join(linkedDir, 'ui', 'leak.txt'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(() => {
  events.length = 0;
});

function hostFor() {
  const targets: Record<string, { manifest: ReturnType<typeof manifestOf>; pluginDir: string }> = {
    viewy: { manifest: manifestOf('viewy'), pluginDir: dir },
    linky: { manifest: manifestOf('linky'), pluginDir: linkedDir },
  };
  return new PluginViewHost({ preloadPath: '/x/plugin-ui-preload.cjs', resolvePlugin: (name) => targets[name] ?? null });
}

describe('PluginViewHost.open', () => {
  it('WebRTC 정책 · 막힌 프록시를 loadURL 전에 건다 · sandbox · contextIsolation · nodeIntegration 없음', async () => {
    const host = hostFor();
    const view = (await host.open('viewy', 'viewy.main')) as unknown as FakeView;
    expect(events).toEqual(['setProxy', `webrtc:${PLUGIN_UI_WEBRTC_POLICY}`, 'loadURL']);
    expect(PLUGIN_UI_WEBRTC_POLICY).toBe('disable_non_proxied_udp');
    expect(sessions.get(pluginUiPartition('viewy'))?.proxy).toEqual({ mode: 'fixed_servers', proxyRules: PLUGIN_UI_BLOCKED_PROXY, proxyBypassRules: '<-loopback>,api.example.com:443' });
    expect(view.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: pluginUiPartition('viewy') });
    expect(view.webContents.url).toBe('cmh-plugin://viewy/ui/index.html?view=viewy.main');
    host.dispose();
  });

  it('폴더에 심볼릭 링크가 있으면 · 모르는 플러그인 · 선언 안 한 뷰는 거부', async () => {
    const host = hostFor();
    await expect(host.open('linky', 'linky.main')).rejects.toThrow(/symbolic links/);
    await expect(host.open('ghost', 'ghost.main')).rejects.toThrow(/not active/);
    await expect(host.open('viewy', 'nope')).rejects.toThrow(/no ui for view/);
    host.dispose();
  });
});

describe('PluginViewHost — 파일 응답(protocol.handle) · 네트워크 거름(webRequest)', () => {
  it('자기 파일 200 · 심볼릭 링크 · 하드 링크 403 · 남의 origin 400 · POST 405', async () => {
    const host = hostFor();
    await host.open('viewy', 'viewy.main');
    const serve = sessions.get(pluginUiPartition('viewy'))?.protocolHandler;
    if (!serve) throw new Error('protocol handler not registered');
    const own = await serve(new Request('cmh-plugin://viewy/ui/index.html'));
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('<p>hi</p>');
    expect(own.headers.get('content-security-policy')).toContain("default-src 'self'");
    // 열린 뒤에 만든 링크(검수 8 실측 P_hardlinkAfterOpen 은 고치기 전 200 secret-outside)
    await symlink(join(base, 'secret.txt'), join(dir, 'ui', 'late-symlink.txt'));
    await link(join(base, 'secret.txt'), join(dir, 'ui', 'late-hardlink.txt'));
    try {
      expect((await serve(new Request('cmh-plugin://viewy/ui/late-symlink.txt'))).status).toBe(403);
      expect((await serve(new Request('cmh-plugin://viewy/ui/late-hardlink.txt'))).status).toBe(403);
    } finally {
      await rm(join(dir, 'ui', 'late-symlink.txt'));
      await rm(join(dir, 'ui', 'late-hardlink.txt'));
    }
    expect((await serve(new Request('cmh-plugin://other/ui/index.html'))).status).toBe(400);
    expect((await serve(new Request('cmh-plugin://viewy/ui/%2e%2e%2f..%2fsecret.txt'))).status).toBe(400);
    expect((await serve(new Request('cmh-plugin://viewy/ui/index.html', { method: 'POST', body: 'x' }))).status).toBe(405);
    expect((await serve(new Request('cmh-plugin://viewy/ui/none.html'))).status).toBe(404);
    host.dispose();
  });

  it('webRequest — 자기 화면 · 선언한 https 만 통과 · 남의 origin · 선언 안 한 호스트 · http 는 cancel', async () => {
    const host = hostFor();
    await host.open('viewy', 'viewy.main');
    const before = sessions.get(pluginUiPartition('viewy'))?.beforeRequest;
    if (!before) throw new Error('webRequest handler not registered');
    const cancelOf = (url: string): boolean => {
      let cancel: boolean | null = null;
      before({ url }, (r) => { cancel = r.cancel; });
      if (cancel === null) throw new Error('callback not called');
      return cancel;
    };
    expect(cancelOf('cmh-plugin://viewy/ui/app.js')).toBe(false);
    expect(cancelOf('https://api.example.com/v1')).toBe(false);
    expect(cancelOf('cmh-plugin://other/ui/app.js')).toBe(true);
    expect(cancelOf('https://evil.example.net/')).toBe(true);
    expect(cancelOf('http://api.example.com/')).toBe(true);
    expect(cancelOf('file:///etc/passwd')).toBe(true);
    host.dispose();
  });
});
