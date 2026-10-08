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
  startOptions: null as null | { beforeStop?: () => Promise<void>; onStateChange?: (state: string, detail: string | null) => void },
  started: Promise.resolve(false),
  fakeService: { state: 'failed', search: async () => ({ total: null, elements: [], aggregations: {} }), get: async () => null, upsert: async () => ({ ids: [] }), delete: async () => ({ ids: [] }) } as Record<string, unknown>,
  appOn: [] as string[],
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, getVersion: () => '0.1.0', on: (event: string) => void h.appOn.push(event), exit: () => undefined },
  ipcMain: { handle: (channel: string) => void h.handled.push(channel), removeHandler: (channel: string) => void h.removed.push(channel) },
  session: { fromPartition: () => ({}) },
  WebContentsView: class {},
  utilityProcess: { fork: () => { throw new Error('not in tests'); } },
}));

vi.mock('./data/start-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./data/start-data-service.js')>()),
  startDataService: (options: NonNullable<typeof h.startOptions>) => {
    h.startOptions = options;
    return { service: h.fakeService, started: h.started };
  },
}));

const {
  PLUGIN_BLOCKED_ENTITIES,
  SETTINGS_CHANGED_EVENT,
  bridgeAppSettingsToBus,
  bridgeSettingsToBus,
  createPluginDataAccess,
  createPluginLifecycle,
  createPluginSettingsReader,
  decodeSettingsSegment,
  encodeSettingsSegment,
  openAppSettings,
  parsePluginSettingsKey,
  pluginSettingsKey,
  startAppServices,
} = await import('./app-services.js');
const { DATA_METHOD, DATA_RPC_ERROR } = await import('./data/data-protocol.js');
const startDataServiceModule = await vi.importActual<typeof import('./data/start-data-service.js')>('./data/start-data-service.js');
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
    // 검수 10 🟢9 — 바꾼 뒤에만 비밀값처럼 보이는 키(`a:pikey` → `a_3apikey`)도 null: SettingsStore.set 이 거부하는 키와 같게
    expect(pluginSettingsKey('p', 'a:pikey')).toBeNull();
    expect(pluginSettingsKey('p', 'secre-t')).toBeNull();
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
    const watchState = vi.fn(() => ({ dispose: () => undefined }));
    const failed = await openAppSettings({ ...h.fakeService, state: 'failed' } as never, Promise.resolve(false), a.log, { watchState });
    expect(failed).toMatchObject({ source: 'memory', persistent: false, failure: 'data service is failed' });
    await failed.store.set('app.ui.theme', 'dark'); // 메모리여도 쓸 수는 있다
    await failed.store.set('app.ui.theme', 'light'); // 같은 키 경고는 한 번
    expect(a.lines.map((l) => l.level)).toEqual(['warn', 'warn']);
    expect(a.lines[1]?.message).toMatch(/"app\.ui\.theme" was changed in memory only/);
    expect(watchState).not.toHaveBeenCalled(); // failed 는 앱을 다시 켜기 전에는 running 이 안 된다 — 다시 열기 없음

    const { core, access } = await coreOver();
    await core.methods()[DATA_METHOD.upsert]!({ entity: 'system_config', rows: [{ configurationKey: 'app.ui.bad', configurationValue: { nope: 1 }, createdAt: '2026-10-08T00:00:00Z' }] });
    const b = collectingLog();
    const broken = await openAppSettings(access as never, Promise.resolve(true), b.log);
    expect(broken.source).toBe('memory');
    expect(broken.failure).toMatch(/app\.ui\.bad/);
    expect(b.lines.map((l) => l.level)).toEqual(['error']);
    await core.close();
  });

  function stateWatch() {
    const listeners = new Set<(state: string) => void>();
    return {
      watchState: (listener: (state: string) => void) => (listeners.add(listener), { dispose: () => void listeners.delete(listener) }),
      fire: (state: string) => [...listeners].forEach((l) => l(state)),
      size: () => listeners.size,
    };
  }

  it('검수 10 🟡1 · 검수 11 🟡2: memory(자료층 restarting) → running 이면 system_config 로 바꾼다 · DB 에 없던 키만 옮긴다(DB 가 이긴다) · 늦은 메모리 쓰기도 옮긴다', async () => {
    const { core, access } = await coreOver();
    const store0 = await SettingsStore.open(new (await import('./settings/data-settings-backend.js')).DataSettingsBackend(access));
    await store0.set('app.ui.existing', 'old');
    await store0.set('app.ui.edited', 'db');
    await store0.set('app.ui.list', ['a', 'b']);
    const data = { ...access, state: 'restarting' as string };
    const w = stateWatch();
    const { log, lines } = collectingLog();
    const s = await openAppSettings(data as never, Promise.resolve(true), log, { watchState: w.watchState as never });
    expect(s).toMatchObject({ source: 'memory', persistent: false, failure: 'data service is restarting' });
    expect(w.size()).toBe(1);
    const bus = new EventBus();
    const seen: { key: string }[] = [];
    bus.on(SETTINGS_CHANGED_EVENT, (payload) => void seen.push(payload as { key: string }));
    bridgeAppSettingsToBus(s, bus);
    const memory = s.store;
    await memory.set('app.ui.edited', 'mem'); // DB 에 있던 키 — 버린다
    await memory.set('app.ui.list', ['x']); // 빈 memory 의 default 위에서 고친 목록 — DB 의 [a, b] 를 덮지 않는다
    await memory.delete('app.ui.list'); // DB 에 있던 키를 memory 에서 지움 — 버린다(DB 값이 남는다)
    await memory.set('app.ui.new', 1);
    await memory.set('app.ui.new', 2);
    await memory.set('app.ui.same', 'v'); // DB 에 없던 키 · 옮긴다
    expect(lines.filter((l) => l.message.includes('changed in memory only'))).toHaveLength(4); // 키마다 한 번
    const memoryEvents = seen.length;

    data.state = 'running';
    w.fire('running');
    await s.whenIdle();
    expect(s).toMatchObject({ source: 'data', persistent: true, failure: null });
    expect(s.store).not.toBe(memory);
    expect(w.size()).toBe(0); // 바꾼 뒤 듣기를 멈춘다
    expect(s.store.get('app.ui.edited', (v) => v)).toBe('db');
    expect(s.store.get('app.ui.list', (v) => v)).toEqual(['a', 'b']);
    expect(s.store.get('app.ui.new', (v) => v)).toBe(2);
    expect(s.store.get('app.ui.existing', (v) => v)).toBe('old');
    // 버린 키마다 warn(키 이름만 · 값은 안 적는다)
    const discards = lines.filter((l) => l.level === 'warn' && l.message.includes('memory change is discarded'));
    expect(discards.map((l) => l.message.match(/"([^"]+)"/)?.[1]).sort()).toEqual(['app.ui.edited', 'app.ui.list']);
    expect(discards.some((l) => l.message.includes('"mem"') || l.message.includes('"x"'))).toBe(false); // 값은 안 적는다
    expect(lines.some((l) => l.level === 'info' && l.message.includes('2 change(s) made in memory copied · 2 discarded'))).toBe(true);
    // 바꾸며 읽히는 값이 달라진 키만 알린다: existing(memory 에 없었다) · edited(mem → db) · list(없음 → [a, b]) — new · same 은 같은 값
    expect(seen.slice(memoryEvents).map((p) => p.key).sort()).toEqual(['app.ui.edited', 'app.ui.existing', 'app.ui.list']);

    // 붙잡아 둔 옛 메모리 store 로 늦게 쓴 것도 system_config 로 간다(쓰기 · 지우기 · DB 가 이긴다 검사 없음 — AppSettings.store 주석)
    const afterSwitch = seen.length;
    await memory.set('app.ui.late', true);
    await memory.delete('app.ui.new');
    await s.whenIdle();
    const raw = (await core.methods()[DATA_METHOD.search]!({ entity: 'system_config', criteria: {} })) as { elements: Record<string, unknown>[] };
    expect(Object.fromEntries(raw.elements.map((e) => [e['configurationKey'], e['configurationValue']]))).toEqual({
      'app.ui.existing': { _value: 'old' },
      'app.ui.edited': { _value: 'db' },
      'app.ui.list': { _value: ['a', 'b'] },
      'app.ui.same': { _value: 'v' },
      'app.ui.late': { _value: true },
    });
    // 메모리 쪽 알림은 끊었다(두 번 오지 않는다) — data store 의 알림만
    expect(seen.slice(afterSwitch)).toEqual([{ key: 'app.ui.late' }, { key: 'app.ui.new' }]);
    await core.close();
  });

  it('검수 11 🟡1: 옮기기가 하나라도 실패하면 바꾸지 않는다 — memory 값 그대로 · error 로그(키 이름) · 다음 running 에 다시 해 본다', async () => {
    const { core, access } = await coreOver();
    const store0 = await SettingsStore.open(new (await import('./settings/data-settings-backend.js')).DataSettingsBackend(access));
    await store0.set('app.ui.k', 'db');
    const data = { ...access, state: 'restarting' as string };
    const w = stateWatch();
    const { log, lines } = collectingLog();
    const s = await openAppSettings(data as never, Promise.resolve(true), log, { watchState: w.watchState as never });
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on(SETTINGS_CHANGED_EVENT, (payload) => void seen.push(payload));
    bridgeAppSettingsToBus(s, bus);
    await s.store.set('app.ui.k', 'mem');
    await s.store.set('app.ui.ok', 'first'); // 이것은 옮겨진다(첫 upsert)
    await s.store.set('app.ui.only', 'memonly'); // 이것은 실패한다
    const memoryEvents = seen.length;
    const realUpsert = data.upsert;
    let upserts = 0;
    data.upsert = async (entity, rows) => {
      upserts += 1;
      if (upserts > 1) throw new RpcError(DATA_RPC_ERROR.timeout, 'request timed out');
      return realUpsert(entity, rows);
    };
    data.state = 'running';
    w.fire('running');
    await s.whenIdle();
    // 바꾸지 않았다 — memory 값이 그대로 읽힌다
    expect(s.source).toBe('memory');
    expect(s.store.get('app.ui.k', (v) => v)).toBe('mem');
    expect(s.store.get('app.ui.only', (v) => v)).toBe('memonly');
    expect(s.failure).toMatch(/could not be copied to system_config: "app\.ui\.only"/);
    expect(seen.length).toBe(memoryEvents); // 바꾸지 않았으니 settings.changed 도 없다
    const err = lines.filter((l) => l.level === 'error');
    expect(err).toHaveLength(1);
    expect(err[0]?.message).toMatch(/"app\.ui\.only"/);
    expect(err[0]?.message).not.toMatch(/memonly|"app\.ui\.ok"/); // 값 · 옮겨진 키는 안 적는다
    expect(err[0]?.message).toMatch(/no retry scheduled/); // 지금 running — 자료층이 다시 띄워져야 다시 해 본다(검수 11 🟢3)
    expect(w.size()).toBe(1); // 듣기는 남는다

    // 자료층이 다시 띄워지면(restarting → running) 다시 해 본다 · 앞서 옮긴 ok 는 «DB 에 있던 값»으로 치지 않는다
    data.upsert = realUpsert;
    await s.store.set('app.ui.ok', 'second');
    w.fire('restarting');
    w.fire('running');
    await s.whenIdle();
    expect(s.source).toBe('data');
    expect(s.store.get('app.ui.k', (v) => v)).toBe('db'); // DB 가 이긴다(검수 11 🟡2)
    expect(s.store.get('app.ui.only', (v) => v)).toBe('memonly');
    expect(s.store.get('app.ui.ok', (v) => v)).toBe('second');
    expect(lines.filter((l) => l.message.includes('memory change is discarded')).map((l) => l.message.match(/"([^"]+)"/)?.[1])).toEqual(['app.ui.k']);
    expect(w.size()).toBe(0);
    await core.close();
  });

  it('검수 10 🟡1: open 이 RPC unavailable 로 실패(되살아날 수 있음)면 다시 열기 · 끝 상태가 오면 듣기를 멈춘다', async () => {
    const { core, access } = await coreOver();
    let fail = 1;
    const flaky = {
      ...access,
      search: (async (...args: unknown[]) => {
        if (fail > 0) {
          fail -= 1;
          throw new RpcError(DATA_RPC_ERROR.unavailable, 'data service is still restarting after 10000ms');
        }
        return (access.search as (...a: unknown[]) => unknown)(...args);
      }) as never,
    };
    const w = stateWatch();
    const { log, lines } = collectingLog();
    const s = await openAppSettings(flaky as never, Promise.resolve(true), log, { watchState: w.watchState as never });
    expect(lines[0]).toMatchObject({ level: 'error' });
    await s.whenIdle(); // 듣기 시작할 때 이미 running — 한 번 바로 다시 연다
    expect(s.source).toBe('data');
    await core.close();

    // restarting 으로 memory → failed 가 오면 멈춘다(그 뒤 running 이 와도 다시 열지 않는다)
    const w2 = stateWatch();
    const b = collectingLog();
    const data2 = { ...access, state: 'restarting' as string };
    const s2 = await openAppSettings(data2 as never, Promise.resolve(true), b.log, { watchState: w2.watchState as never });
    w2.fire('failed');
    expect(w2.size()).toBe(0);
    expect(b.lines.at(-1)?.message).toMatch(/stay in memory — data service is failed/);
    expect(s2.source).toBe('memory');
  });

  it('검수 11 🟢3: open 이 timeout 이고 자료층이 그대로 running 이면 «will retry» 라고 적지 않는다 · restarting 이면 적는다', async () => {
    const { core, access } = await coreOver();
    let searches = 0;
    const data = {
      ...access,
      state: 'running' as string,
      search: (async () => {
        searches += 1;
        throw new RpcError(DATA_RPC_ERROR.timeout, 'request timed out');
      }) as never,
    };
    const w = stateWatch();
    const { log, lines } = collectingLog();
    const s = await openAppSettings(data as never, Promise.resolve(true), log, { watchState: w.watchState as never });
    await s.whenIdle(); // 듣기 시작할 때 running — 한 번 바로 다시 열어 본다(또 timeout)
    expect(searches).toBe(2);
    expect(s.source).toBe('memory');
    const last = lines.at(-1)?.message ?? '';
    expect(last).toMatch(/no retry scheduled/);
    expect(last).not.toMatch(/will retry/);
    expect(w.size()).toBe(1);
    // 자료층이 다시 띄워지는 중에 실패하면 «will retry»
    w.fire('restarting');
    data.state = 'restarting';
    w.fire('running'); // 듣는 쪽은 running 을 받았지만 open 이 실패한 때 상태는 restarting
    await s.whenIdle();
    expect(searches).toBe(3);
    expect(lines.at(-1)?.message).toMatch(/will retry when the data service is running again/);
    await core.close();
  });

  it('검수 11 🟢6: 앱 종료 중(stopping · stopped) open 실패는 info · 듣기를 남기지 않는다', async () => {
    const { core, access } = await coreOver();
    // 처음 열 때: open 하는 사이 자료층이 stopping 이 되고 unavailable
    const data = {
      ...access,
      state: 'running' as string,
      search: (async () => {
        data.state = 'stopping';
        throw new RpcError(DATA_RPC_ERROR.unavailable, 'data service is stopped');
      }) as never,
    };
    const w = stateWatch();
    const a = collectingLog();
    const s = await openAppSettings(data as never, Promise.resolve(true), a.log, { watchState: w.watchState as never });
    expect(s.source).toBe('memory');
    expect(a.lines.map((l) => l.level)).toEqual(['info']);
    expect(w.size()).toBe(0);

    // 다시 열기 중: restarting → running 을 받고 여는 사이 stopping
    const data2 = { ...access, state: 'restarting' as string, search: data.search };
    const w2 = stateWatch();
    const b = collectingLog();
    const s2 = await openAppSettings(data2 as never, Promise.resolve(true), b.log, { watchState: w2.watchState as never });
    data2.search = (async () => {
      data2.state = 'stopping';
      throw new RpcError(DATA_RPC_ERROR.unavailable, 'data service is stopped');
    }) as never;
    w2.fire('running');
    await s2.whenIdle();
    expect(s2.source).toBe('memory');
    expect(b.lines.at(-1)).toMatchObject({ level: 'info' });
    expect(b.lines.at(-1)?.message).toMatch(/data service is stopping/);
    expect(b.lines.some((l) => l.level === 'error')).toBe(false);
    expect(w2.size()).toBe(0);

    // 첫 띄우기가 내리는 중 취소(started false · stopped)도 info
    const c = collectingLog();
    await openAppSettings({ ...access, state: 'stopped' } as never, Promise.resolve(false), c.log, { watchState: w.watchState as never });
    expect(c.lines.map((l) => l.level)).toEqual(['info']);
    expect(w.size()).toBe(0);
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

describe('플러그인 띄우기 · 내리기(검수 10 🟡3)', () => {
  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  function fakeRegistry(scanGate: Promise<void>, startupGate: Promise<void> = Promise.resolve()) {
    const events: string[] = [];
    const registry = {
      scan: async () => (events.push('scan'), await scanGate, events.push('scan:end'), ['alpha']),
      startup: async () => (events.push('startup'), await startupGate, events.push('startup:end'), ['alpha']),
      dispose: async () => void events.push('registry.dispose'),
    };
    return { registry, events };
  }
  const views = (events: string[]) => () => (events.push('views'), { dispose: () => void events.push('views.dispose') });

  it('검수 10 🟡3 재현 차례 scan → dispose → (scan 끝): startup 을 부르지 않고 · dispose 는 scan 이 끝난 뒤 레지스트리를 내린다', async () => {
    const scan = deferred();
    const { registry, events } = fakeRegistry(scan.promise);
    const { log, lines } = collectingLog();
    const life = createPluginLifecycle({ registry, prepare: async () => undefined, createViews: views(events), log });
    const starting = life.start();
    await vi.waitFor(() => expect(events).toEqual(['scan']));
    const disposing = life.dispose();
    await Promise.resolve();
    expect(events).toEqual(['scan']); // 돌던 start 를 기다린다
    scan.resolve();
    await Promise.all([starting, disposing]);
    expect(events).toEqual(['scan', 'scan:end', 'registry.dispose']);
    expect(life.views()).toBeNull();
    expect(lines.some((l) => l.message.includes('startup skipped (app is quitting)'))).toBe(true);
    await life.start(); // dispose 뒤 다시 불러도 아무것도 안 한다
    expect(events).toEqual(['scan', 'scan:end', 'registry.dispose']);
  });

  it('startup 중 dispose → startup 이 끝난 뒤 내린다(화면 호스트는 안 만든다) · 상한을 넘으면 경고 뒤 그대로 내린다', async () => {
    const startup = deferred();
    const a = fakeRegistry(Promise.resolve(), startup.promise);
    const life = createPluginLifecycle({ registry: a.registry, prepare: async () => undefined, createViews: views(a.events), log: collectingLog().log });
    const starting = life.start();
    await vi.waitFor(() => expect(a.events).toContain('startup'));
    const disposing = life.dispose();
    startup.resolve();
    await Promise.all([starting, disposing]);
    expect(a.events).toEqual(['scan', 'scan:end', 'startup', 'startup:end', 'registry.dispose']);

    const never = fakeRegistry(Promise.resolve(), new Promise<void>(() => undefined));
    const { log, lines } = collectingLog();
    const stuck = createPluginLifecycle({ registry: never.registry, prepare: async () => undefined, createViews: views(never.events), log, startWaitMs: 20 });
    void stuck.start();
    await vi.waitFor(() => expect(never.events).toContain('startup'));
    await stuck.dispose();
    expect(never.events.at(-1)).toBe('registry.dispose');
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('did not finish in 20ms'))).toBe(true);
  });

  it('보통 차례: start 가 끝난 뒤 dispose — 화면 → 레지스트리', async () => {
    const { registry, events } = fakeRegistry(Promise.resolve());
    const life = createPluginLifecycle({ registry, prepare: async () => undefined, createViews: views(events), log: collectingLog().log });
    await life.start();
    expect(life.views()).not.toBeNull();
    await life.dispose();
    await life.dispose(); // 두 번째는 같은 일
    expect(events).toEqual(['scan', 'scan:end', 'startup', 'startup:end', 'views', 'views.dispose', 'registry.dispose']);
  });
});

describe('will-quit 리스너 · startDataService 두 번째 부름', () => {
  it('검수 10 🟢1: will-quit 이 두 번 와도 exit 은 한 번 · 둘 다 preventDefault', async () => {
    const order: string[] = [];
    const exit = vi.fn(() => void order.push('exit'));
    const handler = startDataServiceModule.createWillQuitHandler({ beforeStop: async () => void order.push('before'), stop: async () => void order.push('stop'), exit });
    const event = { preventDefault: vi.fn() };
    handler(event);
    handler(event);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['before', 'stop', 'exit']);
    handler(event); // 내린 뒤에는 막지 않는다
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });

  it('beforeStop 이 거부돼도 stop 은 하고 exit 한다', async () => {
    const order: string[] = [];
    const logged: string[] = [];
    const handler = startDataServiceModule.createWillQuitHandler({
      beforeStop: async () => {
        throw new Error('boom');
      },
      stop: async () => void order.push('stop'),
      exit: () => void order.push('exit'),
      logError: (message) => void logged.push(message),
    });
    handler({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(order).toEqual(['stop', 'exit']));
    expect(logged).toEqual(['beforeStop failed — stopping data service anyway']);
  });

  it('검수 11: stop 이 거부돼도 exit 은 한 번 — will-quit 이 두 번 와도', async () => {
    const exit = vi.fn();
    const logged: string[] = [];
    const handler = startDataServiceModule.createWillQuitHandler({
      stop: async () => {
        throw new Error('stop boom');
      },
      exit,
      logError: (message) => void logged.push(message),
    });
    const event = { preventDefault: vi.fn() };
    handler(event);
    handler(event);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logged).toEqual(['data service stop failed — exiting anyway']);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    handler(event); // 내린 뒤에는 막지 않는다
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });

  it('【AI 임시 결정】 🟢6: 두 번째 startDataService — 옵션 없으면 처음 것 · beforeStop 을 주면 예외(조용히 버리지 않는다)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const first = startDataServiceModule.startDataService({ beforeStop: async () => undefined });
      expect(h.appOn).toEqual(['will-quit']);
      expect(startDataServiceModule.startDataService().service).toBe(first.service);
      expect(() => startDataServiceModule.startDataService({ beforeStop: async () => undefined })).toThrow(/already started/);
      expect(await first.started).toBe(false); // 시험에는 utilityProcess 가 없다 — 띄우기 실패(거부하지 않는다)
    } finally {
      errors.mockRestore();
      info.mockRestore();
    }
  });
});

describe('startAppServices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmh-services-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('플러그인 폴더를 만들어 빈 목록을 scan · 화면 호스트 · 설정(data) · will-quit: 플러그인 화면 → 레지스트리 → 안 끝난 설정 쓰기 → 자료층 stop', async () => {
    h.userData = dir;
    const order: string[] = [];
    let releaseUpsert: (() => void) | null = null;
    h.fakeService = {
      state: 'running',
      search: async () => ({ total: null, elements: [], aggregations: {} }),
      get: async () => null,
      upsert: () =>
        new Promise((resolve) => {
          releaseUpsert = () => {
            order.push('settings.upsert');
            resolve({ ids: [] });
          };
        }),
      delete: async () => ({ ids: [] }),
    };
    h.started = Promise.resolve(true);
    const { log, lines } = collectingLog();
    const services = startAppServices(log);
    expect(startAppServices(log)).toBe(services); // 두 번 불러도 하나
    expect(services.pluginViews()).toBeNull(); // 창 뒤 startPlugins 전에는 없다
    await services.startPlugins();
    await services.startPlugins(); // 두 번째는 같은 Promise
    expect(existsSync(join(dir, 'plugins'))).toBe(true);
    expect(services.plugins.list()).toEqual([]);
    const views = services.pluginViews();
    expect(views).not.toBeNull();
    expect(h.handled).toHaveLength(1);
    const settings = await services.settings;
    expect(settings).toMatchObject({ source: 'data', persistent: true, failure: null });
    expect(lines.some((l) => l.message.includes('plugins scanned: 0 · started: 0'))).toBe(true);
    expect(typeof h.startOptions?.onStateChange).toBe('function');

    // 안 끝난 설정 쓰기 하나(upsert 가 풀리지 않았다)
    const pending = settings.store.set('app.ui.theme', 'dark');
    await vi.waitFor(() => expect(releaseUpsert).not.toBeNull());

    const viewsDispose = views!.dispose.bind(views);
    vi.spyOn(views!, 'dispose').mockImplementation(() => (order.push('views.dispose'), viewsDispose()));
    const registryDispose = services.plugins.dispose.bind(services.plugins);
    vi.spyOn(services.plugins, 'dispose').mockImplementation(async () => (order.push('registry.dispose'), registryDispose()));
    // will-quit 리스너(진짜 createWillQuitHandler) + app-services 가 넘긴 beforeStop
    const handler = startDataServiceModule.createWillQuitHandler({
      beforeStop: h.startOptions!.beforeStop!,
      stop: async () => void order.push('data.stop'),
      exit: () => void order.push('exit'),
    });
    handler({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(order).toEqual(['views.dispose', 'registry.dispose']));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['views.dispose', 'registry.dispose']); // 설정 쓰기가 안 끝나 자료층을 내리지 않는다
    releaseUpsert!();
    await pending;
    await vi.waitFor(() => expect(order).toEqual(['views.dispose', 'registry.dispose', 'settings.upsert', 'data.stop', 'exit']));
    expect(h.removed).toEqual(h.handled); // 화면 호스트가 ipcMain 핸들러를 걷었다
  });

  it('검수 11: 끝나지 않는 설정 쓰기 — SETTINGS_IDLE_TIMEOUT_MS(3초) 뒤 warn 하고 자료층 stop → exit', async () => {
    // startAppServices 는 한 번만 만든다(모듈 변수) — 새 모듈로 다시 부른다(vi.mock 은 그대로)
    vi.resetModules();
    const fresh = await import('./app-services.js');
    const freshStart = await vi.importActual<typeof import('./data/start-data-service.js')>('./data/start-data-service.js');
    h.userData = dir;
    h.fakeService = {
      state: 'running',
      search: async () => ({ total: null, elements: [], aggregations: {} }),
      get: async () => null,
      upsert: () => new Promise(() => undefined), // 끝나지 않는다
      delete: async () => ({ ids: [] }),
    };
    h.started = Promise.resolve(true);
    const { log, lines } = collectingLog();
    const services = fresh.startAppServices(log);
    expect(services).not.toBe(startAppServices(log));
    await services.startPlugins();
    const settings = await services.settings;
    expect(settings.source).toBe('data');
    void settings.store.set('app.ui.theme', 'dark');
    const order: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const handler = freshStart.createWillQuitHandler({
        beforeStop: h.startOptions!.beforeStop!,
        stop: async () => void order.push('data.stop'),
        exit: () => void order.push('exit'),
      });
      handler({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(fresh.SETTINGS_IDLE_TIMEOUT_MS - 1);
      expect(order).toEqual([]); // 상한 전에는 자료층을 내리지 않는다
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(order).toEqual(['data.stop', 'exit']));
    } finally {
      vi.useRealTimers();
    }
    expect(fresh.SETTINGS_IDLE_TIMEOUT_MS).toBe(3_000);
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('settings writes did not finish in 3000ms'))).toBe(true);
  });
});
