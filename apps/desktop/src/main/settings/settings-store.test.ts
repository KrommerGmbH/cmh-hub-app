import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySettingsBackend,
  SettingsStore,
  assertSettingsKey,
  looksLikeSecretKey,
  type SettingsBackend,
  type SettingsChangeEvent,
  type SystemConfigRow,
  type UnmappedSystemConfigRow,
} from './settings-store.js';

const asNumber = (raw: unknown): number => {
  if (typeof raw !== 'number') throw new Error('not a number');
  return raw;
};
const asString = (raw: unknown): string => {
  if (typeof raw !== 'string') throw new Error('not a string');
  return raw;
};

function clock(): { now: () => string; tick: () => void } {
  let t = Date.UTC(2026, 9, 7, 0, 0, 0);
  return { now: () => new Date(t).toISOString(), tick: () => void (t += 1000) };
}

async function openStore(initial: readonly SystemConfigRow[] = []) {
  const backend = new InMemorySettingsBackend(initial);
  const c = clock();
  let n = 0;
  const store = await SettingsStore.open(backend, { now: c.now, newId: () => `id${(n += 1)}`.padEnd(32, '0') });
  return { backend, store, clock: c };
}

describe('SettingsStore (R7-b · system_config 꼴)', () => {
  it('set → system_config 행 꼴로 backend 에 쓰고 get 은 parse 를 거친다', async () => {
    const { backend, store } = await openStore();
    await store.set('cmh.ai.maxTokens', 4096);
    expect(store.get('cmh.ai.maxTokens', asNumber)).toBe(4096);
    expect(backend.load()).toEqual([
      {
        id: 'id1'.padEnd(32, '0'),
        configuration_key: 'cmh.ai.maxTokens',
        configuration_value: '{"_value":4096}',
        sales_channel_id: null,
        created_at: '2026-10-07T00:00:00.000Z',
        updated_at: null,
      },
    ]);
  });

  it('두 번째 set 은 id · created_at 을 지키고 updated_at 을 채운다', async () => {
    const { backend, store, clock: c } = await openStore();
    await store.set('core.basic.shopName', 'a');
    c.tick();
    await store.set('core.basic.shopName', 'b');
    const [row] = backend.load();
    expect(row?.id).toBe('id1'.padEnd(32, '0'));
    expect(row?.created_at).toBe('2026-10-07T00:00:00.000Z');
    expect(row?.updated_at).toBe('2026-10-07T00:00:01.000Z');
    expect(store.get('core.basic.shopName', asString)).toBe('b');
  });

  it('없는 키는 null · parse 가 던지면 그대로 던진다', async () => {
    const { store } = await openStore();
    expect(store.get('a.b.c', asNumber)).toBeNull();
    await store.set('a.b.c', 'text');
    expect(() => store.get('a.b.c', asNumber)).toThrow('not a number');
  });

  it('open 은 backend 행을 읽는다', async () => {
    const rows: SystemConfigRow[] = [
      { id: 'x', configuration_key: 'a.b.ok', configuration_value: '{"_value":{"k":[1,2]}}', sales_channel_id: null, created_at: 't', updated_at: null },
    ];
    const { store } = await openStore(rows);
    expect(store.get('a.b.ok', (raw) => raw)).toEqual({ k: [1, 2] });
    expect(store.invalidKeys()).toEqual([]);
  });

  const row = (key: string, value: string): SystemConfigRow => ({
    id: key,
    configuration_key: key,
    configuration_value: value,
    sales_channel_id: null,
    created_at: 't',
    updated_at: null,
  });
  const brokenRows: SystemConfigRow[] = [
    row('a.b.ok', '{"_value":1}'),
    row('a.b.c', 'not json'),
    row('a.b.wrapped', '{"value":1}'),
    row('bad key', '{"_value":1}'),
    row('x.y.password', '{"_value":"pw"}'),
    row('ai.openai.config', '{"_value":{"apiKey":"sk-xxx"}}'),
  ];

  it('검수 7 🟡5: open 은 깨진 행(키 모양 · 풀기 · 비밀값 키 · 값 안 비밀값 칸)을 모두 적어 바로 실패한다', async () => {
    const opening = SettingsStore.open(new InMemorySettingsBackend(brokenRows));
    await expect(opening).rejects.toThrow('5 invalid row(s)');
    await expect(SettingsStore.open(new InMemorySettingsBackend(brokenRows))).rejects.toThrow(
      /"a\.b\.c" \(configuration_value is not.*"a\.b\.wrapped".*"bad key" \(bad key shape\).*"x\.y\.password" \(key looks like a secret.*"ai\.openai\.config" \(value field \$\.apiKey looks like a secret/,
    );
  });

  it('검수 7 🟡5: repair 모드 — 깨진 행은 get 이 예외 · set 으로 덮어쓰고 delete 로 지운다(oldValue null)', async () => {
    const backend = new InMemorySettingsBackend(brokenRows);
    const store = await SettingsStore.open(backend, { repair: true });
    expect(store.invalidKeys().sort()).toEqual(['a.b.c', 'a.b.wrapped', 'ai.openai.config', 'bad key', 'x.y.password']);
    const events: SettingsChangeEvent[] = [];
    store.onChange((e) => void events.push(e));
    expect(store.get('a.b.ok', asNumber)).toBe(1);
    expect(() => store.get('a.b.c', (raw) => raw)).toThrow('is invalid');
    expect(() => store.get('x.y.password', (raw) => raw)).toThrow('is invalid'); // 비밀값 행을 읽어 주지 않는다
    await store.set('a.b.c', 2);
    expect(store.get('a.b.c', asNumber)).toBe(2);
    await store.delete('a.b.wrapped');
    await store.delete('bad key'); // 키 모양이 깨진 행도 지운다
    await store.delete('x.y.password');
    await store.delete('ai.openai.config');
    await expect(store.set('x.y.password', 'pw')).rejects.toThrow('safeStorage'); // 비밀값은 다시 못 넣는다
    await expect(store.delete('other key')).rejects.toThrow('dot-separated'); // 없는 키는 모양을 본다(오타)
    expect(store.invalidKeys()).toEqual([]);
    expect(backend.load().map((r) => r.configuration_key).sort()).toEqual(['a.b.c', 'a.b.ok']);
    expect(events).toEqual([
      { key: 'a.b.c', oldValue: null, newValue: 2 },
      { key: 'a.b.wrapped', oldValue: null, newValue: null },
      { key: 'bad key', oldValue: null, newValue: null },
      { key: 'x.y.password', oldValue: null, newValue: null },
      { key: 'ai.openai.config', oldValue: null, newValue: null },
    ]);
    // 다 고친 뒤에는 repair 없이 열린다
    await expect(SettingsStore.open(backend)).resolves.toBeInstanceOf(SettingsStore);
  });

  it('open: sales_channel_id 가 있는 행 · 같은 키 두 줄은 예외', async () => {
    const row = { id: 'x', configuration_key: 'a.b.c', configuration_value: '{"_value":1}', sales_channel_id: null, created_at: 't', updated_at: null } as const;
    const withChannel = { ...row, sales_channel_id: 'abc' } as unknown as SystemConfigRow;
    await expect(SettingsStore.open({ load: () => [withChannel], upsert: () => undefined, delete: () => undefined })).rejects.toThrow('sales_channel_id');
    await expect(SettingsStore.open({ load: () => [row, row], upsert: () => undefined, delete: () => undefined })).rejects.toThrow('duplicate');
  });

  it.each([
    ['', 'non-empty'],
    ['a.b', 'dot-separated'],
    ['a..c', 'segments must match'],
    ['a.b.c d', 'segments must match'],
    ['a.b.한글', 'segments must match'],
    [`a.b.${'x'.repeat(260)}`, 'longer than'],
    ['a.b.c.d.e.f.g.h.i', 'dot-separated'],
  ])('키 %j 는 거부', async (key, message) => {
    expect(() => assertSettingsKey(key)).toThrow(message);
    const { store } = await openStore();
    await expect(store.set(key, 1)).rejects.toThrow(message);
  });

  it.each([
    ['ai.openai.apiKey', true],
    ['ai.openai.api_key', true],
    ['naver.login.PASSWORD', true],
    ['x.y.accessToken', true],
    ['x.y.client_secret', true],
    // 검수 7 🟡4: «포함» 낱말 · 키의 모든 마디
    ['a.b.apiKeyEnc', true],
    ['a.b.password_enc', true],
    ['a.b.credentials', true],
    ['a.b.privateKey', true],
    ['a.b.secretKey', true],
    ['a.b.passwd', true],
    ['a.b.refreshTokens', true],
    ['a.b.cookie', true],
    ['a.b.apiKeys', true],
    ['ai.apiKey.value', true],
    ['cmh.ai.maxTokens', false], // tokens 로 끝나는 보통 설정은 막지 않는다
    ['cmh.ai.tokenLimit', false],
    ['core.basic.shopName', false],
  ])('비밀값 키 %s → %s', async (key, secret) => {
    expect(looksLikeSecretKey(key)).toBe(secret);
    const { store } = await openStore();
    if (secret) await expect(store.set(key, 'v')).rejects.toThrow('safeStorage');
    else await expect(store.set(key, 1)).resolves.toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['함수', () => 1],
    ['bigint', 1n],
    ['안쪽 undefined', { a: undefined }],
    // 검수 7 🟢6
    ['sparse 배열', [1, , 3]],
    ['번호 아닌 칸이 있는 배열', Object.assign([1], { extra: 2 })],
    ['symbol 키', { [Symbol('s')]: 1, k: 1 }],
    ['배열의 symbol 키', Object.assign([1], { [Symbol('s')]: 1 })],
    // 검수 7 🟡4: 값 안 비밀값 칸
    ['값 안 apiKey', { apiKey: 'sk-xxx' }],
    ['깊은 곳 password', { a: { b: [{ password: 'pw' }] } }],
    ['값 안 cookie 배열', { cookie: ['sid=1'] }],
    ['값 안 accessToken null', { accessToken: null }],
  ])('JSON 으로 그대로 오가지 않는 값 · 비밀값 칸(%s)은 거부', async (_label, value) => {
    const { store, backend } = await openStore();
    await expect(store.set('a.b.c', value)).rejects.toThrow();
    expect(backend.load()).toEqual([]);
  });

  it('값 안 비밀값 이름 칸이라도 보통 객체(지도)면 안으로 들어가 본다 · `:` 가 든 지도 키는 보지 않는다', async () => {
    const { store } = await openStore();
    // Guard 정책 꼴 — credentials 는 사이트 → 접근 방식 지도(비밀이 아니다) · tools 키는 글롭
    const policy = { defaultMode: 'guard', tools: { 'mcp:vault:get_secret': 'ask' }, credentials: { naver: 'ask' }, maxTokens: 10 };
    await expect(store.set('cmh.guard.policy', policy)).resolves.toBeUndefined();
    await expect(store.set('cmh.guard.other', { credentials: { naver: { password: 'pw' } } })).rejects.toThrow('$.credentials.naver.password');
  });

  it('순환 참조는 깊이 상한으로 거부', async () => {
    const { store } = await openStore();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    await expect(store.set('a.b.c', cyclic)).rejects.toThrow('deeper than');
  });

  it('onChange: 새로 만들기 · 바꾸기 · 지우기 이벤트 · 같은 값은 알리지 않는다 · dispose', async () => {
    const { store } = await openStore();
    const events: SettingsChangeEvent[] = [];
    const sub = store.onChange((e) => void events.push(e));
    await store.set('a.b.c', 1);
    await store.set('a.b.c', 1);
    await store.set('a.b.c', 2);
    await store.delete('a.b.c');
    await store.delete('a.b.c'); // 없던 키 — 알리지 않는다
    sub.dispose();
    await store.set('a.b.c', 3);
    expect(events).toEqual([
      { key: 'a.b.c', oldValue: null, newValue: 1 },
      { key: 'a.b.c', oldValue: 1, newValue: 2 },
      { key: 'a.b.c', oldValue: 2, newValue: null },
    ]);
  });

  it('listener 가 던져도 set 은 성공 · onListenerError 로 알린다', async () => {
    const onListenerError = vi.fn();
    const store = await SettingsStore.open(new InMemorySettingsBackend(), { onListenerError });
    store.onChange(() => {
      throw new Error('boom');
    });
    store.onChange(async () => Promise.reject(new Error('async boom')));
    await expect(store.set('a.b.c', 1)).resolves.toBeUndefined();
    expect(store.get('a.b.c', asNumber)).toBe(1);
    expect(onListenerError).toHaveBeenCalledTimes(2);
  });

  it('검수 7 🟢5: onListenerError 가 던져도 set 은 성공 · 뒤 listener 도 불린다', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = await SettingsStore.open(new InMemorySettingsBackend(), {
        onListenerError: () => {
          throw new Error('logger down');
        },
      });
      const calls: string[] = [];
      store.onChange(() => {
        calls.push('l1');
        throw new Error('l1');
      });
      store.onChange(async () => {
        calls.push('l2');
        throw new Error('l2');
      });
      store.onChange(() => void calls.push('l3'));
      await expect(store.set('a.b.c', 1)).resolves.toBeUndefined();
      expect(calls).toEqual(['l1', 'l2', 'l3']);
      expect(store.get('a.b.c', asNumber)).toBe(1);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('listener 안에서 다시 set 을 기다려도 deadlock 이 나지 않는다', async () => {
    const { store } = await openStore();
    store.onChange(async (e) => {
      if (e.key === 'a.b.c') await store.set('a.b.mirror', e.newValue);
    });
    await store.set('a.b.c', 5);
    expect(store.get('a.b.mirror', asNumber)).toBe(5);
  });

  it('backend 쓰기 실패 → 그 호출만 거부 · 캐시 그대로 · 이벤트 없음 · 뒤 쓰기는 돈다', async () => {
    const inner = new InMemorySettingsBackend();
    let fail = true;
    const backend: SettingsBackend = {
      load: () => inner.load(),
      upsert: async (row) => {
        if (fail) throw new Error('disk full');
        inner.upsert(row);
      },
      delete: (key) => inner.delete(key),
    };
    const store = await SettingsStore.open(backend);
    const listener = vi.fn();
    store.onChange(listener);
    await expect(store.set('a.b.c', 1)).rejects.toThrow('disk full');
    expect(store.has('a.b.c')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    fail = false;
    await store.set('a.b.c', 2);
    expect(store.get('a.b.c', asNumber)).toBe(2);
  });

  it('겹친 set 은 부른 차례대로 backend 에 쓰인다(race condition 없음)', async () => {
    const order: unknown[] = [];
    const inner = new InMemorySettingsBackend();
    const backend: SettingsBackend = {
      load: () => [],
      upsert: async (row) => {
        // 첫 쓰기가 더 느려도 차례가 뒤집히지 않아야 한다
        await new Promise((r) => setTimeout(r, row.configuration_value.includes('"first"') ? 20 : 0));
        order.push(JSON.parse(row.configuration_value));
        inner.upsert(row);
      },
      delete: () => undefined,
    };
    const store = await SettingsStore.open(backend);
    await Promise.all([store.set('a.b.c', 'first'), store.set('a.b.c', 'second')]);
    expect(order).toEqual([{ _value: 'first' }, { _value: 'second' }]);
    expect(store.get('a.b.c', asString)).toBe('second');
  });

  it('get 이 돌려준 객체를 고쳐도 저장값은 그대로', async () => {
    const { store } = await openStore();
    await store.set('a.b.c', { list: [1] });
    const value = store.get('a.b.c', (raw) => raw as { list: number[] });
    value?.list.push(2);
    expect(store.get('a.b.c', (raw) => raw)).toEqual({ list: [1] });
  });
  it('검수 10 🟡2: whenIdle 은 차례 줄의 쓰기(기다리는 사이 새로 선 것도)가 backend 에 다 쓰인 뒤 풀린다', async () => {
    const written: string[] = [];
    const releases: (() => void)[] = [];
    const backend: SettingsBackend = {
      load: () => [],
      upsert: (row) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            written.push(row.configuration_key);
            resolve();
          });
        }),
      delete: () => undefined,
    };
    const store = await SettingsStore.open(backend);
    void store.set('a.b.one', 1);
    let idle = false;
    const waiting = store.whenIdle().then(() => void (idle = true));
    void store.set('a.b.two', 2); // whenIdle 을 부른 뒤 선 쓰기
    for (let i = 0; i < 2; i += 1) {
      await vi.waitFor(() => expect(releases).toHaveLength(i + 1));
      expect(idle).toBe(false);
      releases[i]?.();
    }
    await waiting;
    expect(written).toEqual(['a.b.one', 'a.b.two']);
    expect(idle).toBe(true);
    await store.whenIdle(); // 빈 줄이면 바로 풀린다
  });

  it('검수 10 🟡1: backend 가 못 바꾼 행(UnmappedSystemConfigRow)은 늘 깨진 행 — repair 로 열어 보고 · 덮어쓰기(created_at 없으면 그때 시각) · 지우기', async () => {
    const unmapped: UnmappedSystemConfigRow[] = [
      { unmapped: true, id: 'u1'.padEnd(32, '0'), configuration_key: 'a.b.nullValue', problem: 'no configurationValue', created_at: '2026-01-01T00:00:00.000Z' },
      { unmapped: true, id: 'u2'.padEnd(32, '0'), configuration_key: 'a.b.noCreated', problem: 'no createdAt', created_at: null },
      { unmapped: true, id: 'u3'.padEnd(32, '0'), configuration_key: 'system_config:u3', problem: 'sales channel row', created_at: 't' },
    ];
    const upserts: SystemConfigRow[] = [];
    const deletes: string[] = [];
    const backend: SettingsBackend = { load: () => unmapped, upsert: (row) => void upserts.push(row), delete: (key) => void deletes.push(key) };
    await expect(SettingsStore.open(backend)).rejects.toThrow(/a\.b\.nullValue.*no configurationValue/);
    const c = clock();
    const store = await SettingsStore.open(backend, { repair: true, now: c.now });
    expect(store.invalidKeys().sort()).toEqual(['a.b.noCreated', 'a.b.nullValue', 'system_config:u3']);
    expect(() => store.get('a.b.nullValue', asNumber)).toThrow(/no configurationValue/);
    await store.set('a.b.nullValue', 1);
    await store.set('a.b.noCreated', 2);
    expect(upserts.map((r) => [r.id, r.created_at])).toEqual([
      ['u1'.padEnd(32, '0'), '2026-01-01T00:00:00.000Z'],
      ['u2'.padEnd(32, '0'), c.now()],
    ]);
    await store.delete('system_config:u3'); // 키 모양이 아니어도 캐시에 있는 깨진 행은 지운다
    expect(deletes).toEqual(['system_config:u3']);
    expect(store.invalidKeys()).toEqual([]);
    expect(store.get('a.b.noCreated', asNumber)).toBe(2);
  });
});
