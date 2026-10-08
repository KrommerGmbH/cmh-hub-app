import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { PluginDataAccess } from './plugin-host-api.js';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import { RPC_ERROR } from './plugin-rpc.js';
import { PLUGIN_UI_IPC_CHANNEL, PLUGIN_UI_REJECTED_PER_SECOND, PluginUiBridge, type PluginUiRejection, type PluginUiSender } from './plugin-ui-bridge.js';

function manifestOf(name: string, permissions: string[]): PluginManifest {
  const result = parseManifest({ name, version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', ui: 'ui/index.html', activationEvents: ['onStartup'], permissions });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

class FakeData implements PluginDataAccess {
  readonly calls: string[] = [];
  async search(entity: string) { this.calls.push(`search:${entity}`); return { total: 3 }; }
  async get() { return null; }
  async upsert(entity: string) { this.calls.push(`upsert:${entity}`); return { written: 1 }; }
  async delete() { return null; }
}

const VIEW_ID = 11;
const sender = (over: Partial<PluginUiSender> = {}): PluginUiSender => ({ webContentsId: VIEW_ID, frameUrl: 'cmh-plugin://viewy/ui/index.html?view=v', isMainFrame: true, ...over });

function setup() {
  const data = new FakeData();
  const rejected: PluginUiRejection[] = [];
  const logs: string[] = [];
  const bridge = new PluginUiBridge({ data, onRejected: (r) => rejected.push(r), onLog: (p, l, m) => logs.push(`${p}:${l}:${m}`) });
  bridge.attach(VIEW_ID, manifestOf('viewy', ['entity:cmh_ai_prompt:read']));
  bridge.attach(22, manifestOf('other', ['entity:cmh_ai_task:crud']));
  return { bridge, data, rejected, logs };
}

describe('PluginUiBridge — 보낸 쪽 검사', () => {
  it('붙인 화면 · 맨 위 프레임 · 자기 origin 이면 host:* 를 부른다', async () => {
    const { bridge, data, logs } = setup();
    expect(await bridge.handle(sender(), { method: 'host:data.search', params: { entity: 'cmh_ai_prompt' } })).toEqual({ ok: true, result: { total: 3 } });
    expect(await bridge.handle(sender(), { method: 'host:log', params: { message: 'from ui' } })).toEqual({ ok: true, result: null });
    expect(data.calls).toEqual(['search:cmh_ai_prompt']);
    expect(logs).toEqual(['viewy:info:from ui']);
  });

  it('붙이지 않은 webContents(셸 · 탭 · 닫힌 화면)는 거부', async () => {
    const { bridge, data, rejected } = setup();
    const reply = await bridge.handle(sender({ webContentsId: 999 }), { method: 'host:data.search', params: { entity: 'cmh_ai_prompt' } });
    expect(reply).toEqual({ ok: false, error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: sender is not a plugin view' } });
    expect(rejected).toEqual([{ webContentsId: 999, plugin: null, reason: 'permission denied: sender is not a plugin view' }]);
    bridge.detach(VIEW_ID);
    expect((await bridge.handle(sender(), { method: 'host:log', params: {} })).ok).toBe(false);
    expect(data.calls).toEqual([]);
  });

  it('남의 플러그인 화면 id 로는 남의 권한을 못 쓴다(id 마다 그 플러그인 매니페스트)', async () => {
    const { bridge, data } = setup();
    // viewy 화면이 other 의 엔티티를 부름 → viewy 매니페스트로 거부
    const reply = await bridge.handle(sender(), { method: 'host:data.upsert', params: { entity: 'cmh_ai_task', rows: [] } });
    expect(reply).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    // other 화면 id 인데 프레임 주소가 viewy → 거부
    const forged = await bridge.handle(sender({ webContentsId: 22 }), { method: 'host:data.upsert', params: { entity: 'cmh_ai_task', rows: [] } });
    expect(forged).toEqual({ ok: false, error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: sender frame is not this plugin\'s page' } });
    expect(data.calls).toEqual([]);
  });

  it('하위 프레임 · 프레임 없음 · 다른 곳으로 간 프레임은 거부', async () => {
    const { bridge } = setup();
    for (const s of [sender({ isMainFrame: false }), sender({ frameUrl: null }), sender({ frameUrl: 'https://evil.com/' }), sender({ frameUrl: 'about:blank' })]) {
      expect(await bridge.handle(s, { method: 'host:log', params: {} })).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    }
  });

  it('host:* 표 밖 · 옛 이름 · 꼴이 틀린 글 · 큰 글 · 승인 엔티티 쓰기', async () => {
    const { bridge } = setup();
    expect(await bridge.handle(sender(), { method: 'host:exec' })).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    expect(await bridge.handle(sender(), { method: 'repository.search', params: { entity: 'cmh_ai_prompt' } })).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    expect(await bridge.handle(sender(), { method: 'constructor' })).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    expect(await bridge.handle(sender(), 'host:log')).toMatchObject({ ok: false, error: { code: RPC_ERROR.invalidRequest } });
    expect(await bridge.handle(sender(), { method: 'host:log', params: { message: 'x'.repeat(2 * 1024 * 1024) } })).toMatchObject({ ok: false, error: { code: RPC_ERROR.invalidRequest } });
    expect(await bridge.handle(sender(), { method: 'host:data.upsert', params: { entity: 'cmh_ai_approval', rows: [] } })).toEqual({
      ok: false,
      error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: writes to cmh_ai_approval are only allowed from the app UI' },
    });
  });

  it('동시 요청 상한', async () => {
    const gates: Array<() => void> = [];
    const slow: PluginDataAccess = {
      search: () => new Promise((resolve) => gates.push(() => resolve('ok'))),
      get: async () => null,
      upsert: async () => null,
      delete: async () => null,
    };
    const bridge = new PluginUiBridge({ data: slow, maxConcurrent: 1 });
    bridge.attach(VIEW_ID, manifestOf('viewy', ['entity:cmh_ai_prompt:read']));
    const first = bridge.handle(sender(), { method: 'host:data.search', params: { entity: 'cmh_ai_prompt' } });
    expect(await bridge.handle(sender(), { method: 'host:data.search', params: { entity: 'cmh_ai_prompt' } })).toMatchObject({ ok: false, error: { code: RPC_ERROR.tooManyRequests } });
    gates.shift()?.();
    expect(await first).toEqual({ ok: true, result: 'ok' });
  });

  it('같은 id 를 두 번 붙이면 예외 · viewsOf', () => {
    const { bridge } = setup();
    expect(() => bridge.attach(VIEW_ID, manifestOf('viewy', []))).toThrow(/already attached/);
    expect(bridge.viewsOf('viewy')).toEqual([VIEW_ID]);
    expect(bridge.pluginOf(22)).toBe('other');
  });

  it('preload 의 채널 글자가 PLUGIN_UI_IPC_CHANNEL 과 같다(sandbox preload 는 이 모듈을 require 못 해 두 곳에 적는다)', async () => {
    const text = await readFile(new URL('../../preload/plugin-ui-preload.cts', import.meta.url), 'utf8');
    expect(text).toContain(`const PLUGIN_UI_IPC_CHANNEL = '${PLUGIN_UI_IPC_CHANNEL}';`);
    expect(text).not.toMatch(/from '\.\.?\//); // 우리 모듈 import 0
  });
});

describe('PluginUiBridge — onRejected 빈도 상한(검수 8 🟢6)', () => {
  it('플러그인마다 초당 상한 · 넘친 개수는 다음 창에 한 번 · 붙지 않은 보낸 쪽은 따로 센다', async () => {
    let now = 50_000;
    const rejected: PluginUiRejection[] = [];
    const bridge = new PluginUiBridge({ data: new FakeData(), onRejected: (r) => rejected.push(r), now: () => now });
    bridge.attach(VIEW_ID, manifestOf('viewy', []));
    const n = PLUGIN_UI_REJECTED_PER_SECOND + 5;
    for (let i = 0; i < n; i += 1) {
      expect(await bridge.handle(sender(), { method: 'host:nope' })).toMatchObject({ ok: false, error: { code: RPC_ERROR.permissionDenied } });
    }
    for (let i = 0; i < 3; i += 1) await bridge.handle(sender({ webContentsId: 999 }), { method: 'host:log' });
    expect(rejected.filter((r) => r.plugin === 'viewy')).toHaveLength(PLUGIN_UI_REJECTED_PER_SECOND);
    expect(rejected.filter((r) => r.plugin === null)).toHaveLength(3);
    now += 1_000;
    await bridge.handle(sender(), { method: 'host:nope' });
    expect(rejected.slice(-2).map((r) => r.reason)).toEqual(['rejections rate limited: 5 dropped', 'permission denied: host method "host:nope" is not available to plugin views']);
  });
});
