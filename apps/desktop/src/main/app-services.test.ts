// R7-c — app-services: 플러그인 설정 키 · 플러그인 자료 길 · 설정 열기(자료층 / 메모리) · settings.changed · startAppServices 묶기.
// electron 과 start-data-service 는 가짜(vi.mock) — 자료층은 DataWorkerCore 를 이 프로세스 안에서 바로 부른다.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriteResult } from '@cmh-hub-app/data';
import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userData: '',
  handled: [] as string[],
  removed: [] as string[],
  startOptions: null as null | { beforeStop?: () => Promise<void> },
  started: Promise.resolve(false),
  fakeService: { state: 'failed', search: async () => ({ total: null, elements: [], aggregations: {} }), get: async () => null, upsert: async () => ({ ids: [] }), delete: async () => ({ ids: [] }) },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, getVersion: () => '0.1.0' },
  ipcMain: { handle: (channel: string) => void h.handled.push(channel), removeHandler: (channel: string) => void h.removed.push(channel) },
  session: { fromPartition: () => ({}) },
  WebContentsView: class {},
  utilityProcess: { fork: () => { throw new Error('not in tests'); } },
}));

vi.mock('./data/start-data-service.js', () => ({
  startDataService: (options: { beforeStop?: () => Promise<void> }) => {
    h.startOptions = options;
    return { service: h.fakeService, started: h.started };
  },
}));

const {
  PLUGIN_BLOCKED_ENTITIES,
  SETTINGS_CHANGED_EVENT,
  bridgeSettingsToBus,
  createPluginDataAccess,
  createPluginSettingsReader,
  decodeSettingsSegment,
  encodeSettingsSegment,
  openAppSettings,
  parsePluginSettingsKey,
  pluginSettingsKey,
  startAppServices,
} = await import('./app-services.js');
const { DATA_METHOD } = await import('./data/data-protocol.js');
const { DataWorkerCore } = await import('./data/data-worker-core.js');
const { EventBus } = await import('./plugin/event-bus.js');
const { RpcError } = await import('./plugin/plugin-rpc.js');
const { RPC_ERROR } = await import('./plugin/plugin-rpc.js');
const { InMemorySettingsBackend, SettingsStore } = await import('./settings/settings-store.js');
const { PLUGIN_NAME_PATTERN } = await import('./plugin/plugin-manifest.js');

type Logged = { level: string; message: string };
function collectingLog(): { log: (level: 'info' | 'warn' | 'error', message: string) => void; lines: Logged[] } {
  const lines: Logged[] = [];
  return { log: (level, message) => void lines.push({ level, message }), lines };
}

async function coreOver(filename = ':memory:') {
  const core = new DataWorkerCore();
  await core.methods()[DATA_METHOD.open]!({ filename });
  const m = core.methods();
  const access = {
    state: 'running' as const,
    search: (async (entity: string, criteria?: unknown) => m[DATA_METHOD.search]!({ entity, criteria: criteria ?? {} })) as never,
    upsert: async (entity: string, rows: readonly Record<string, unknown>[]) => (await m[DATA_METHOD.upsert]!({ entity, rows })) as WriteResult,
    delete: async (entity: string, ids: readonly string[]) => (await m[DATA_METHOD.delete]!({ entity, ids })) as WriteResult,
  };
  return { core, access };
}

describe('플러그인 설정 키', () => {
  it('영숫자 밖 글자는 _hex 로 · 거꾸로 풀린다 · SettingsStore 키 규칙을 지킨다', () => {
    expect(encodeSettingsSegment('plugin-hello')).toBe('plugin_2dhello');
    expect(encodeSettingsSegment('a_b.c:d-e')).toBe('a_5fb_2ec_3ad_2de');
    expect(decodeSettingsSegment('a_5fb_2ec_3ad_2de')).toBe('a_b.c:d-e');
    expect(decodeSettingsSegment('a_b')).toBeNull(); // `_` 뒤에 hex 두 자리가 아니다
    expect(pluginSettingsKey('plugin-hello', 'greeting.text')).toBe('plugin.plugin_2dhello.greeting_2etext');
    expect(parsePluginSettingsKey('plugin.plugin_2dhello.greeting_2etext')).toEqual({ plugin: 'plugin-hello', setting: 'greeting.text' });
    // 겹치지 않는다: `a_2d` 라는 원래 글과 `a-` 는 다른 키
    expect(pluginSettingsKey('p', 'a_2d')).not.toBe(pluginSettingsKey('p', 'a-'));
    expect(parsePluginSettingsKey('app.ui.theme')).toBeNull();
    expect(PLUGIN_NAME_PATTERN.test('plugin-hello')).toBe(true);
  });

  it('저장 못 하는 키는 null — 비밀값처럼 보임(바꾸기 전 이름으로) · 255자 넘음 · 비ASCII', () => {
    expect(pluginSettingsKey('p', 'api-key')).toBeNull(); // 바꾼 뒤 `api_2dkey` 는 SettingsStore 검사에 안 걸린다
    expect(pluginSettingsKey('p', 'accessToken')).toBeNull();
    expect(pluginSettingsKey('cookie-helper', 'x')).toBeNull();
    expect(pluginSettingsKey('p', 'maxTokens')).toBe('plugin.p.maxTokens');
    expect(pluginSettingsKey('a'.repeat(64), `${'-'.repeat(70)}`)).toBeNull();
    expect(pluginSettingsKey('p', '키')).toBeNull();
  });

  it('host:settings.get 읽기 — 있으면 값 · 없거나 저장 못 하는 키면 undefined · 깨진 행은 경고 뒤 undefined', async () => {
    const backend = new InMemorySettingsBackend([
      { id: 'b'.repeat(32), configuration_key: 'plugin.p.broken', configuration_value: '{"value":1}', sales_channel_id: null, created_at: 't', updated_at: null },
    ]);
    const store = await SettingsStore.open(backend, { repair: true });
    await store.set('plugin.plugin_2dhello.greeting', 'hi');
    const { log, lines } = collectingLog();
    const reader = createPluginSettingsReader(Promise.resolve(store), log);
    expect(await reader.get('plugin-hello', 'greeting')).toBe('hi');
    expect(await reader.get('plugin-hello', 'missing')).toBeUndefined();
    expect(await reader.get('plugin-hello', 'apiKey')).toBeUndefined();
    expect(await reader.get('p', 'broken')).toBeUndefined();
    expect(lines.map((l) => l.level)).toEqual(['warn']);
  });
});

describe('플러그인 자료 길', () => {
  function fakeData() {
    const calls: unknown[][] = [];
    const data = {
      search: async (...a: unknown[]) => (calls.push(['search', ...a]), { total: null, elements: [], aggregations: {} }),
      get: async (...a: unknown[]) => (calls.push(['get', ...a]), null),
      upsert: async (...a: unknown[]) => (calls.push(['upsert', ...a]), { ids: [] }),
      delete: async (...a: unknown[]) => (calls.push(['delete', ...a]), { ids: [] }),
    };
    return { data: data as never, calls };
  }

  it('system_config 는 읽기 · 쓰기 모두 permissionDenied(이름 꼴이 달라도)', () => {
    const { data, calls } = fakeData();
    const access = createPluginDataAccess(data);
    expect(PLUGIN_BLOCKED_ENTITIES).toContain('system_config');
    for (const entity of ['system_config', 'systemConfig', 'SYSTEM_CONFIG']) {
      for (const run of [() => access.search(entity, {}), () => access.get(entity, 'a'.repeat(32)), () => access.upsert(entity, [{}]), () => access.delete(entity, [])]) {
        try {
          void run();
          throw new Error('expected deny');
        } catch (error) {
          expect(error).toBeInstanceOf(RpcError);
          expect((error as InstanceType<typeof RpcError>).code).toBe(RPC_ERROR.permissionDenied);
        }
      }
    }
    expect(calls).toEqual([]);
  });

  it('criteria 는 보통 객체 · rows 는 보통 객체 배열만 · 맞으면 DataService 로 넘긴다', async () => {
    const { data, calls } = fakeData();
    const access = createPluginDataAccess(data);
    expect(() => access.search('cmh_ai_provider', [])).toThrow(/criteria/);
    expect(() => access.search('cmh_ai_provider', null)).toThrow(/criteria/);
    expect(() => access.upsert('cmh_ai_provider', [new Date()])).toThrow(/plain objects/);
    expect(() => access.upsert('cmh_ai_provider', [[1]])).toThrow(/plain objects/);
    await access.search('cmh_ai_provider', { limit: 1 });
    await access.get('cmh_ai_provider', 'a'.repeat(32));
    await access.upsert('cmh_ai_provider', [{ code: 'x' }, Object.create(null) as object]);
    await access.delete('cmh_ai_provider', ['a'.repeat(32)]);
    expect(calls.map((c) => c[0])).toEqual(['search', 'get', 'upsert', 'delete']);
    expect(calls[0]).toEqual(['search', 'cmh_ai_provider', { limit: 1 }]);
  });
});

describe('설정 열기 · settings.changed', () => {
  it('자료층이 running 이면 system_config 위로 연다', async () => {
    const { core, access } = await coreOver();
    const { log } = collectingLog();
    const s = await openAppSettings(access as never, Promise.resolve(true), log);
    expect(s.source).toBe('data');
    expect(s.failure).toBeNull();
    await s.store.set('app.ui.theme', 'dark');
    const raw = (await core.methods()[DATA_METHOD.search]!({ entity: 'system_config', criteria: {} })) as { elements: Record<string, unknown>[] };
    expect(raw.elements.map((e) => [e['configurationKey'], e['configurationValue']])).toEqual([['app.ui.theme', { _value: 'dark' }]]);
    await core.close();
  });

  it('자료층 실패 → 메모리 + 경고 · 깨진 행으로 open 실패 → 메모리 + 오류', async () => {
    const a = collectingLog();
    const failed = await openAppSettings({ ...h.fakeService, state: 'failed' } as never, Promise.resolve(false), a.log);
    expect(failed).toMatchObject({ source: 'memory', failure: 'data service is failed' });
    await failed.store.set('app.ui.theme', 'dark'); // 메모리여도 쓸 수는 있다
    expect(a.lines.map((l) => l.level)).toEqual(['warn']);

    const { core, access } = await coreOver();
    await core.methods()[DATA_METHOD.upsert]!({ entity: 'system_config', rows: [{ configurationKey: 'app.ui.bad', configurationValue: { nope: 1 }, createdAt: '2026-10-08T00:00:00Z' }] });
    const b = collectingLog();
    const broken = await openAppSettings(access as never, Promise.resolve(true), b.log);
    expect(broken.source).toBe('memory');
    expect(broken.failure).toMatch(/app\.ui\.bad/);
    expect(b.lines.map((l) => l.level)).toEqual(['error']);
    await core.close();
  });

  it('SettingsStore.onChange → EventBus settings.changed — 값은 싣지 않고 키(+ 플러그인 이름 · 설정 키)만', async () => {
    const store = await SettingsStore.open(new InMemorySettingsBackend());
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on(SETTINGS_CHANGED_EVENT, (payload) => void seen.push(payload));
    const sub = bridgeSettingsToBus(store, bus);
    await store.set('app.ui.theme', 'dark');
    await store.set('plugin.plugin_2dhello.greeting', 'hi');
    await store.delete('app.ui.theme');
    sub.dispose();
    await store.set('app.ui.theme', 'light');
    expect(seen).toEqual([
      { key: 'app.ui.theme' },
      { key: 'plugin.plugin_2dhello.greeting', plugin: 'plugin-hello', setting: 'greeting' },
      { key: 'app.ui.theme' },
    ]);
  });
});

describe('startAppServices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmh-services-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('플러그인 폴더를 만들어 빈 목록을 scan · 화면 호스트 · 설정(메모리) · will-quit 내리기 차례', async () => {
    h.userData = dir;
    const { log, lines } = collectingLog();
    const services = startAppServices(log);
    expect(startAppServices(log)).toBe(services); // 두 번 불러도 하나
    expect(services.pluginViews()).toBeNull(); // 창 뒤 startPlugins 전에는 없다
    await services.startPlugins();
    await services.startPlugins(); // 두 번째는 같은 Promise
    expect(existsSync(join(dir, 'plugins'))).toBe(true);
    expect(services.plugins.list()).toEqual([]);
    expect(services.pluginViews()).not.toBeNull();
    expect(h.handled).toHaveLength(1);
    const settings = await services.settings;
    expect(settings.source).toBe('memory');
    expect(lines.some((l) => l.message.includes('plugins scanned: 0 · started: 0'))).toBe(true);
    // will-quit 의 beforeStop — 화면 호스트를 먼저 걷는다(ipcMain.removeHandler)
    await h.startOptions?.beforeStop?.();
    expect(h.removed).toEqual(h.handled);
  });
});
