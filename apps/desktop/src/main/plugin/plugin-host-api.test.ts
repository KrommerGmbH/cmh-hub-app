import { describe, expect, it } from 'vitest';
import { HOST_METHODS, LogRateLimiter, createHostMethods, unknownHostMethod, type PermissionDeniedInfo, type PluginDataAccess } from './plugin-host-api.js';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import { RPC_ERROR, RpcEndpoint, RpcError, type RpcMessage } from './plugin-rpc.js';

function manifestOf(input: Record<string, unknown>): PluginManifest {
  const result = parseManifest({ name: 'matrix', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onStartup'], ...input });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

const MANIFEST = manifestOf({
  contributes: { settings: [{ key: 'greeting', type: 'string', default: 'hi' }, { key: 'limit', type: 'number' }] },
  permissions: ['entity:cmh_ai_prompt:read', 'entity:hello_note:crud', 'entity:cmh_ai_approval:read'],
});

class FakeData implements PluginDataAccess {
  readonly calls: string[] = [];
  async search(entity: string) { this.calls.push(`search:${entity}`); return { total: 0 }; }
  async get(entity: string, id: string) { this.calls.push(`get:${entity}:${id}`); return null; }
  async upsert(entity: string) { this.calls.push(`upsert:${entity}`); return { written: 1 }; }
  async delete(entity: string) { this.calls.push(`delete:${entity}`); return { deleted: 1 }; }
}

function setup(manifest = MANIFEST, settings: Record<string, unknown> = {}) {
  const data = new FakeData();
  const denied: PermissionDeniedInfo[] = [];
  const logs: string[] = [];
  const methods = createHostMethods({
    manifest,
    data,
    settings: { get: (plugin, key) => settings[`${plugin}/${key}`] },
    onPermissionDenied: (info) => denied.push(info),
    onLog: (plugin, level, message) => logs.push(`${plugin}:${level}:${message}`),
  });
  const call = async (method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; code: number; message: string }> => {
    const handler = methods[method];
    if (!handler) {
      const error = unknownHostMethod(method);
      return error ? { ok: false, code: error.code, message: error.message } : { ok: false, code: RPC_ERROR.methodNotFound, message: 'not found' };
    }
    try {
      return { ok: true, value: await handler(params) };
    } catch (error) {
      const e = error as RpcError;
      return { ok: false, code: e.code, message: e.message };
    }
  };
  return { data, denied, logs, call };
}

describe('host:* — 권한 표(deny by default)', () => {
  // [메서드, params, 통과?, 거부 코드]
  const matrix: Array<[string, unknown, boolean, number?]> = [
    ['host:log', { level: 'info', message: 'x' }, true],
    ['host:data.search', { entity: 'cmh_ai_prompt' }, true],
    ['host:data.get', { entity: 'cmh_ai_prompt', id: 'a' }, true],
    ['host:data.search', { entity: 'cmh_ai_task' }, false, RPC_ERROR.permissionDenied],
    ['host:data.upsert', { entity: 'cmh_ai_prompt', rows: [] }, false, RPC_ERROR.permissionDenied], // read 만 선언
    ['host:data.upsert', { entity: 'hello_note', rows: [{}] }, true],
    ['host:data.delete', { entity: 'hello_note', ids: ['1'] }, true],
    ['host:data.delete', { entity: 'cmh_ai_task', ids: ['1'] }, false, RPC_ERROR.permissionDenied],
    ['host:data.search', { entity: 'cmh_ai_approval' }, true], // 읽기는 선언하면 된다
    ['host:data.upsert', { entity: 'cmh_ai_approval', rows: [{ status: 'approved' }] }, false, RPC_ERROR.permissionDenied],
    ['host:data.upsert', { entity: 'cmhAiApproval', rows: [] }, false, RPC_ERROR.permissionDenied],
    ['host:settings.get', { key: 'greeting' }, true],
    ['host:settings.get', { key: 'other-plugin.secret' }, false, RPC_ERROR.permissionDenied],
    ['host:nope', {}, false, RPC_ERROR.permissionDenied],
    ['host:data.drop', { entity: 'hello_note' }, false, RPC_ERROR.permissionDenied],
    ['host:data.search', {}, false, RPC_ERROR.invalidParams],
    ['host:data.get', { entity: 'cmh_ai_prompt' }, false, RPC_ERROR.invalidParams],
    ['host:settings.get', {}, false, RPC_ERROR.invalidParams],
  ];
  for (const [method, params, allowed, code] of matrix) {
    it(`${method} ${JSON.stringify(params)} → ${allowed ? 'allow' : `deny(${code})`}`, async () => {
      const { call } = setup();
      const result = await call(method, params);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.code).toBe(code);
    });
  }

  it('거부되면 자료층을 부르지 않고 거부 기록을 남긴다', async () => {
    const { call, data, denied } = setup();
    await call('host:data.search', { entity: 'cmh_ai_task' });
    await call('host:data.upsert', { entity: 'cmh_ai_approval', rows: [] });
    await call('host:settings.get', { key: 'secret' });
    expect(data.calls).toEqual([]);
    expect(denied).toEqual([
      { plugin: 'matrix', method: 'host:data.search', entity: 'cmh_ai_task', operation: 'read', reason: 'permission "entity:cmh_ai_task:read" not declared' },
      { plugin: 'matrix', method: 'host:data.upsert', entity: 'cmh_ai_approval', operation: 'write', reason: 'writes to cmh_ai_approval are only allowed from the app UI' },
      { plugin: 'matrix', method: 'host:settings.get', reason: 'setting "secret" is not declared in contributes.settings' },
    ]);
  });

  it('settings.get — 자기 이름 공간 · 값이 없거나 타입이 다르면 선언한 default(없으면 null)', async () => {
    const { call } = setup(MANIFEST, { 'matrix/greeting': 'hallo', 'other/greeting': 'stolen', 'matrix/limit': 'not-a-number' });
    expect(await call('host:settings.get', { key: 'greeting' })).toEqual({ ok: true, value: 'hallo' });
    expect(await call('host:settings.get', { key: 'limit' })).toEqual({ ok: true, value: null });
    const fresh = setup(MANIFEST, {});
    expect(await fresh.call('host:settings.get', { key: 'greeting' })).toEqual({ ok: true, value: 'hi' });
  });

  it('옛 이름(repository.* · log)은 같은 검사를 지난다', async () => {
    const { call } = setup();
    expect((await call('repository.search', { entity: 'cmh_ai_task' })).ok).toBe(false);
    expect((await call('repository.search', { entity: 'cmh_ai_prompt' })).ok).toBe(true);
  });

  it('HOST_METHODS 의 이름은 전부 처리기가 있다', () => {
    const methods = createHostMethods({ manifest: MANIFEST });
    for (const name of HOST_METHODS) expect(typeof methods[name]).toBe('function');
  });

  it('unknownHostMethod — host: 만 permissionDenied · 그 밖은 null(Method not found 로)', () => {
    expect(unknownHostMethod('host:fs.read')?.code).toBe(RPC_ERROR.permissionDenied);
    expect(unknownHostMethod('ping')).toBeNull();
  });

  it('RpcEndpoint 에 꽂으면 모르는 host:* 는 permissionDenied 로 답한다', async () => {
    const sent: RpcMessage[] = [];
    const ep = new RpcEndpoint({ send: (m) => sent.push(m), methods: createHostMethods({ manifest: MANIFEST }), unknownMethod: unknownHostMethod });
    ep.handleMessage({ jsonrpc: '2.0', id: 1, method: 'host:exec', params: {} });
    ep.handleMessage({ jsonrpc: '2.0', id: 2, method: 'other', params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: host method "host:exec" is not available to plugins' } },
      { jsonrpc: '2.0', id: 2, error: { code: RPC_ERROR.methodNotFound, message: 'method "other" not found' } },
    ]);
  });
});

describe('LogRateLimiter', () => {
  it('초당 상한 · 다음 창에서 버린 개수를 한 번 알린다', () => {
    let now = 10_000;
    const limiter = new LogRateLimiter(2, () => now);
    const dropped: number[] = [];
    const results = [1, 2, 3, 4].map(() => limiter.accept((n) => dropped.push(n)));
    expect(results).toEqual([true, true, false, false]);
    now += 1_000;
    expect(limiter.accept((n) => dropped.push(n))).toBe(true);
    expect(dropped).toEqual([2]);
  });
});
