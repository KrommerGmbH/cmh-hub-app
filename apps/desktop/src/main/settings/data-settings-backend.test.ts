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
import { DataSettingsBackend, toDataRow, toSystemConfigRow, type SettingsDataAccess } from './data-settings-backend.js';
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
});
