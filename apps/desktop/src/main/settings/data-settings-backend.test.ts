// R7-c — DataSettingsBackend: SettingsStore ↔ 자료층(DataWorkerCore 를 이 프로세스 안에서 바로 부른다 · 전송 없음 · 임시 파일 DB).
// DataService 와 같은 길(repo.search · repo.upsert · repo.delete · 읽기는 scope 'api')을 지나므로 행 꼴 바꾸기를 진짜 드라이버로 본다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entity, EntitySearchResult, WriteResult } from '@cmh-hub-app/data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_METHOD } from '../data/data-protocol.js';
import type { CriteriaArg } from '../data/data-service.js';
import { DataWorkerCore } from '../data/data-worker-core.js';
import { DataSettingsBackend, toDataRow, toSettingsRow, toSystemConfigRow, type SettingsDataAccess } from './data-settings-backend.js';
import { SettingsStore } from './settings-store.js';

const asAny = (raw: unknown): unknown => raw;

function toJson(criteria: CriteriaArg | undefined): unknown {
  if (criteria === undefined) return {};
  const c = criteria as { parse?: () => unknown };
  return typeof c.parse === 'function' ? c.parse() : criteria;
}

/** DataService 의 search · upsert · delete 와 같은 RPC 메서드를 바로 부르는 가짜 */
function accessOver(core: DataWorkerCore, calls: string[] = []): SettingsDataAccess {
  const m = core.methods();
  return {
    search: (async (entity: string, criteria?: CriteriaArg) => {
      calls.push(`search ${JSON.stringify(toJson(criteria))}`);
      return m[DATA_METHOD.search]!({ entity, criteria: toJson(criteria) });
    }) as SettingsDataAccess['search'],
    upsert: async (entity, rows) => {
      calls.push('upsert');
      return (await m[DATA_METHOD.upsert]!({ entity, rows })) as WriteResult;
    },
    delete: async (entity, ids) => {
      calls.push('delete');
      return (await m[DATA_METHOD.delete]!({ entity, ids })) as WriteResult;
    },
  };
}

describe('DataSettingsBackend (R7-c · system_config 위 SettingsStore)', () => {
  let dir: string;
  let filename: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmh-settings-'));
    filename = join(dir, 'cmh-hub.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function openCore(): Promise<DataWorkerCore> {
    const core = new DataWorkerCore();
    await core.methods()[DATA_METHOD.open]!({ filename });
    return core;
  }

  it('set · get · delete 가 파일 DB 에 남고 다시 연 뒤(앱 두 번째 시작)에도 같다', async () => {
    const first = await openCore();
    const store = await SettingsStore.open(new DataSettingsBackend(accessOver(first)), { repair: false });
    await store.set('app.ui.theme', { mode: 'dark', sizes: [1, 2.5], on: true, none: null });
    await store.set('plugin.hello.greeting', '안녕');
    await store.set('app.ui.zoom', 1);
    await store.set('app.ui.zoom', 2); // 같은 id 로 UPDATE
    await store.delete('plugin.hello.greeting');
    await first.close();

    const second = await openCore();
    const reopened = await SettingsStore.open(new DataSettingsBackend(accessOver(second)), { repair: false });
    expect(reopened.keys().sort()).toEqual(['app.ui.theme', 'app.ui.zoom']);
    expect(reopened.get('app.ui.theme', asAny)).toEqual({ mode: 'dark', sizes: [1, 2.5], on: true, none: null });
    expect(reopened.get('app.ui.zoom', asAny)).toBe(2);
    expect(reopened.get('plugin.hello.greeting', asAny)).toBeNull();
    const raw = (await second.methods()[DATA_METHOD.search]!({ entity: 'system_config', criteria: {} })) as EntitySearchResult;
    const zoom = raw.elements.find((e) => e['configurationKey'] === 'app.ui.zoom');
    expect(zoom).toMatchObject({ configurationValue: { _value: 2 }, salesChannelId: null });
    expect(typeof zoom?.['updatedAt']).toBe('string');
    await second.close();
  });

  it('load 는 id 차례로 쪽을 나눠 모두 받는다', async () => {
    const core = await openCore();
    const calls: string[] = [];
    const store = await SettingsStore.open(new DataSettingsBackend(accessOver(core), 2));
    for (const n of [1, 2, 3, 4, 5]) await store.set(`app.page.k${n}`, n);
    calls.length = 0;
    const reopened = await SettingsStore.open(new DataSettingsBackend(accessOver(core, calls), 2));
    expect(reopened.keys().sort()).toEqual(['app.page.k1', 'app.page.k2', 'app.page.k3', 'app.page.k4', 'app.page.k5']);
    expect(calls).toHaveLength(3); // 2 + 2 + 1
    expect(calls[0]).toContain('"sort":[{"field":"id","order":"ASC","naturalSorting":false}]');
    await core.close();
  });

  it('깨진 행(`_value` 없음)은 repair 아니면 open 이 실패 · repair 면 덮어쓰기로 고친다', async () => {
    const core = await openCore();
    await core.methods()[DATA_METHOD.upsert]!({
      entity: 'system_config',
      rows: [{ configurationKey: 'app.ui.broken', configurationValue: { value: 1 }, createdAt: '2026-10-08T00:00:00.000Z' }],
    });
    const backend = new DataSettingsBackend(accessOver(core));
    await expect(SettingsStore.open(backend)).rejects.toThrow(/app\.ui\.broken/);
    const repair = await SettingsStore.open(backend, { repair: true });
    expect(repair.invalidKeys()).toEqual(['app.ui.broken']);
    await repair.set('app.ui.broken', 7);
    expect((await SettingsStore.open(backend)).get('app.ui.broken', asAny)).toBe(7);
    await core.close();
  });

  it('backend 쓰기 실패(같은 키 다른 id · 부분 UNIQUE)는 그 set 만 거부 · 캐시는 그대로', async () => {
    const core = await openCore();
    const access = accessOver(core);
    const a = await SettingsStore.open(new DataSettingsBackend(access));
    const b = await SettingsStore.open(new DataSettingsBackend(access));
    await a.set('app.ui.theme', 'dark');
    await expect(b.set('app.ui.theme', 'light')).rejects.toThrow(/system_config/);
    expect(b.has('app.ui.theme')).toBe(false);
    await core.close();
  });

  it('행 꼴 바꾸기 — 판매채널 행 · 꼴이 틀린 행은 예외(조용히 버리지 않는다)', () => {
    const ok: Entity = { id: 'a'.repeat(32), configurationKey: 'a.b.c', configurationValue: { _value: 1 }, salesChannelId: null, createdAt: 't', updatedAt: null };
    expect(toSystemConfigRow(ok)).toEqual({
      id: 'a'.repeat(32),
      configuration_key: 'a.b.c',
      configuration_value: '{"_value":1}',
      sales_channel_id: null,
      created_at: 't',
      updated_at: null,
    });
    expect(() => toSystemConfigRow({ ...ok, salesChannelId: 'b'.repeat(32) })).toThrow(/salesChannelId/);
    expect(() => toSystemConfigRow({ ...ok, configurationValue: null })).toThrow(/configurationValue/);
    expect(() => toSystemConfigRow({ ...ok, configurationKey: 3 })).toThrow(/configurationKey/);
    expect(() => toDataRow({ ...toSystemConfigRow(ok), configuration_value: 'not json' })).toThrow(/not JSON/);
    expect(() => toDataRow({ ...toSystemConfigRow(ok), configuration_value: '[1]' })).toThrow(/JSON object/);
  });
  it('검수 10 🟡1: 못 바꾸는 행(판매채널 행 · 값 null · createdAt 없음)은 load 가 던지지 않고 깨진 행으로 — repair 로 열어 보고 delete 로 지운다', async () => {
    const core = await openCore();
    const sc = 'b'.repeat(32);
    await core.methods()[DATA_METHOD.upsert]!({
      entity: 'system_config',
      rows: [
        { configurationKey: 'app.ui.shared', configurationValue: { _value: 1 }, createdAt: '2026-10-08T00:00:00.000Z' },
        { configurationKey: 'app.ui.shared', configurationValue: { _value: 2 }, salesChannelId: sc, createdAt: '2026-10-08T00:00:00.000Z' },
        { configurationKey: 'app.ui.nullValue', configurationValue: { _value: 3 }, createdAt: '2026-10-08T00:00:00.000Z' },
        { configurationKey: 'app.ui.noCreated', configurationValue: { _value: 4 }, createdAt: '2026-10-08T00:00:00.000Z' },
      ],
    });
    const rawRows = async () =>
      ((await core.methods()[DATA_METHOD.search]!({ entity: 'system_config', criteria: {} })) as EntitySearchResult).elements.map((e) => ({
        key: e['configurationKey'],
        channel: e['salesChannelId'],
        createdAt: e['createdAt'],
      }));
    const scId = ((await core.methods()[DATA_METHOD.search]!({
      entity: 'system_config',
      criteria: { filter: [{ type: 'equals', field: 'salesChannelId', value: sc }] },
    })) as EntitySearchResult).elements[0]?.id;
    expect(typeof scId).toBe('string');

    // 자료층이 돌려주는 꼴이 깨진 행(값 null · createdAt 없음)은 진짜 DB 에 넣을 수 없어(required 칸) 읽는 쪽에서 바꾼다
    const plain = accessOver(core);
    const mangling: SettingsDataAccess = {
      ...plain,
      search: (async (entity: string, criteria?: CriteriaArg) => {
        const result = await plain.search(entity, criteria);
        return {
          ...result,
          elements: result.elements.map((e): Entity => {
            if (e['configurationKey'] === 'app.ui.nullValue') return { ...e, configurationValue: null };
            if (e['configurationKey'] === 'app.ui.noCreated') {
              const { createdAt: _drop, ...rest } = e;
              return rest as Entity;
            }
            return e;
          }),
        };
      }) as SettingsDataAccess['search'],
    };
    const backend = new DataSettingsBackend(mangling);
    await expect(SettingsStore.open(backend)).rejects.toThrow(/3 invalid row/);
    const repair = await SettingsStore.open(backend, { repair: true });
    expect(repair.invalidKeys().sort()).toEqual(['app.ui.noCreated', 'app.ui.nullValue', `system_config:${scId}`]);
    expect(repair.get('app.ui.shared', asAny)).toBe(1);

    // 로컬 키 지우기는 같은 키의 판매채널 행을 남긴다
    await repair.delete('app.ui.shared');
    expect((await rawRows()).filter((r) => r.key === 'app.ui.shared')).toEqual([{ key: 'app.ui.shared', channel: sc, createdAt: '2026-10-08T00:00:00.000Z' }]);
    // 판매채널 행은 지은 키로 지운다(그 id 한 줄)
    await repair.delete(`system_config:${scId}`);
    await repair.delete('app.ui.nullValue');
    await repair.set('app.ui.noCreated', 5); // 덮어쓰기 — createdAt 은 그때 시각
    expect(repair.invalidKeys()).toEqual([]);
    const after = await rawRows();
    expect(after.map((r) => r.key)).toEqual(['app.ui.noCreated']);
    expect(typeof after[0]?.createdAt).toBe('string');
    const reopened = await SettingsStore.open(new DataSettingsBackend(plain));
    expect(reopened.get('app.ui.noCreated', asAny)).toBe(5);
    await core.close();
  });

  it('toSettingsRow — 못 바꾸는 행의 캐시 키 · 까닭(id 없는 행만 예외)', () => {
    const ok: Entity = { id: 'a'.repeat(32), configurationKey: 'a.b.c', configurationValue: { _value: 1 }, salesChannelId: null, createdAt: 't', updatedAt: null };
    expect(toSettingsRow(ok)).toEqual(toSystemConfigRow(ok));
    expect(toSettingsRow({ ...ok, salesChannelId: 'b'.repeat(32) })).toMatchObject({
      unmapped: true,
      configuration_key: `system_config:${'a'.repeat(32)}`,
      problem: expect.stringMatching(/salesChannelId/),
    });
    expect(toSettingsRow({ ...ok, configurationKey: 3 })).toMatchObject({ configuration_key: `system_config:${'a'.repeat(32)}` });
    expect(toSettingsRow({ ...ok, createdAt: undefined })).toMatchObject({ configuration_key: 'a.b.c', created_at: null, problem: expect.stringMatching(/createdAt/) });
    expect(() => toSettingsRow({ ...ok, id: undefined as unknown as string })).toThrow(/without id/);
    // 검수 11 🟢7 — 진짜 키가 `system_config:` 로 시작하면 자기 id 의 지은 키(꼴이 맞는 행이어도)
    expect(toSettingsRow({ ...ok, configurationKey: `system_config:${'c'.repeat(32)}` })).toMatchObject({
      unmapped: true,
      configuration_key: `system_config:${'a'.repeat(32)}`,
      problem: expect.stringMatching(/reserved prefix/),
    });
  });

  it('검수 11 🟢7: 진짜 키가 다른 행의 지은 키(`system_config:<판매채널 행 id>`)와 같아도 repair 로 열리고 둘 다 지운다', async () => {
    const core = await openCore();
    const sc = 'b'.repeat(32);
    await core.methods()[DATA_METHOD.upsert]!({
      entity: 'system_config',
      rows: [{ configurationKey: 'x.y.z', configurationValue: { _value: 2 }, salesChannelId: sc, createdAt: '2026-10-08T00:00:00.000Z' }],
    });
    const all = async () => ((await core.methods()[DATA_METHOD.search]!({ entity: 'system_config', criteria: {} })) as EntitySearchResult).elements;
    const channelId = (await all())[0]!.id;
    // SettingsStore 밖에서(DataService.upsert 를 바로) 지은 키 꼴의 진짜 키를 쓴 행
    await core.methods()[DATA_METHOD.upsert]!({
      entity: 'system_config',
      rows: [{ configurationKey: `system_config:${channelId}`, configurationValue: { _value: 3 }, createdAt: '2026-10-08T00:00:00.000Z' }],
    });
    const reservedId = (await all()).find((e) => e.id !== channelId)!.id;
    const backend = new DataSettingsBackend(accessOver(core));
    await expect(SettingsStore.open(backend)).rejects.toThrow(/2 invalid row/); // duplicate 가 아니다
    const repair = await SettingsStore.open(backend, { repair: true });
    expect(repair.invalidKeys().sort()).toEqual([`system_config:${channelId}`, `system_config:${reservedId}`].sort());
    await repair.delete(`system_config:${reservedId}`);
    expect((await all()).map((e) => e.id)).toEqual([channelId]);
    await repair.delete(`system_config:${channelId}`);
    expect(await all()).toEqual([]);
    await core.close();
  });
});
