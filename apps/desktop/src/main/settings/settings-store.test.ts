import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySettingsBackend,
  SettingsStore,
  assertSettingsKey,
  looksLikeSecretKey,
  type SettingsBackend,
  type SettingsChangeEvent,
  type SystemConfigRow,
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

  it('open 은 backend 행을 읽는다 · 깨진 configuration_value 는 get 에서 예외', async () => {
    const rows: SystemConfigRow[] = [
      { id: 'x', configuration_key: 'a.b.ok', configuration_value: '{"_value":{"k":[1,2]}}', sales_channel_id: null, created_at: 't', updated_at: null },
      { id: 'y', configuration_key: 'a.b.broken', configuration_value: '{"value":1}', sales_channel_id: null, created_at: 't', updated_at: null },
    ];
    const { store } = await openStore(rows);
    expect(store.get('a.b.ok', (raw) => raw)).toEqual({ k: [1, 2] });
    expect(() => store.get('a.b.broken', (raw) => raw)).toThrow('{"_value": …}');
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
  ])('JSON 으로 그대로 오가지 않는 값(%s)은 거부', async (_label, value) => {
    const { store, backend } = await openStore();
    await expect(store.set('a.b.c', value)).rejects.toThrow();
    expect(backend.load()).toEqual([]);
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
});
