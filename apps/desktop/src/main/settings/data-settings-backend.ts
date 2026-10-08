// R7-c — SettingsStore 의 저장 자리(SettingsBackend)를 R1 자료층(DataService RPC · 엔티티 `system_config`) 위에 올린다.
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다). DataService 는 타입만 본다 — 공개 메서드 search · upsert · delete(안에서 call() 의 repo.*)만 쓴다.
// 행 꼴 바꾸기: 자료층 응답은 camelCase 속성 · configuration_value 는 json 칸이라 객체로 온다 → SettingsStore 의 SystemConfigRow
//   (snake_case · `{"_value": …}` JSON 글)로 바꾼다. 쓸 때는 거꾸로(JSON 글 → 객체 · 저장 이름 snake_case 로 보낸다).
// 비밀값은 여기 오지 않는다 — SettingsStore.set 이 비밀처럼 보이는 키 · 값 칸을 먼저 거부한다(settings-store.ts 머리 주석).
// 이 backend 밖에서 system_config 를 바꾸면(DataService.upsert 를 직접 부르는 길) SettingsStore 캐시와 어긋난다 — 쓰기는 SettingsStore 하나로만.

import type { Entity } from '@cmh-hub-app/data';
import type { DataService } from '../data/data-service.js';
import type { SettingsBackend, SystemConfigRow } from './settings-store.js';

/** 설정 행 엔티티 이름(packages/data definition/entities/system-config.ts) */
export const SYSTEM_CONFIG_ENTITY = 'system_config';

/** 【AI 임시 결정】 load 한 쪽 줄 수 — 한 번에 전부 받지 않고 id 차례로 나눠 받는다(RPC 글 한 통이 커지지 않게) */
export const SETTINGS_LOAD_PAGE_SIZE = 500;

/** DataService 중 이 backend 가 쓰는 메서드(시험은 가짜를 넣는다) */
export type SettingsDataAccess = Pick<DataService, 'search' | 'upsert' | 'delete'>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 자료층 응답 한 줄 → SystemConfigRow. 꼴이 틀리면 예외(조용히 버리지 않는다 — SettingsStore.open 이 실패로 받는다) */
export function toSystemConfigRow(entity: Entity): SystemConfigRow {
  const key = entity['configurationKey'];
  const value = entity['configurationValue'];
  const channel = entity['salesChannelId'];
  const createdAt = entity['createdAt'];
  const updatedAt = entity['updatedAt'];
  const at = `system_config ${typeof key === 'string' ? JSON.stringify(key) : entity.id}`;
  if (typeof entity.id !== 'string') throw new Error(`settings backend: row without id`);
  if (typeof key !== 'string') throw new Error(`settings backend: ${at} has no configurationKey`);
  if (value === undefined || value === null) throw new Error(`settings backend: ${at} has no configurationValue`);
  if (channel !== null && channel !== undefined) {
    throw new Error(`settings backend: ${at} has salesChannelId — local settings must be null`);
  }
  if (typeof createdAt !== 'string') throw new Error(`settings backend: ${at} has no createdAt`);
  if (updatedAt !== null && updatedAt !== undefined && typeof updatedAt !== 'string') throw new Error(`settings backend: ${at} updatedAt is not a string`);
  return {
    id: entity.id,
    configuration_key: key,
    // json 칸은 객체로 온다 — SettingsStore 는 JSON 글을 본다(`{"_value": …}` 검사는 SettingsStore.open 의 rowProblem 이 한다)
    configuration_value: JSON.stringify(value),
    sales_channel_id: null,
    created_at: createdAt,
    updated_at: typeof updatedAt === 'string' ? updatedAt : null,
  };
}

/** SystemConfigRow → 자료층 쓰기 줄(저장 이름 · json 칸은 객체로) */
export function toDataRow(row: SystemConfigRow): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(row.configuration_value);
  } catch (error) {
    throw new Error(`settings backend: configuration_value of "${row.configuration_key}" is not JSON`, { cause: error });
  }
  if (!isPlainObject(value)) throw new Error(`settings backend: configuration_value of "${row.configuration_key}" must be a JSON object`);
  return {
    id: row.id,
    configuration_key: row.configuration_key,
    configuration_value: value,
    sales_channel_id: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class DataSettingsBackend implements SettingsBackend {
  constructor(
    private readonly data: SettingsDataAccess,
    private readonly pageSize: number = SETTINGS_LOAD_PAGE_SIZE,
  ) {
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('settings backend: pageSize must be a positive integer');
  }

  /** 모든 행 — id 차례로 쪽을 나눠 받는다(쪽이 pageSize 보다 짧으면 끝) */
  async load(): Promise<readonly SystemConfigRow[]> {
    const rows: SystemConfigRow[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.data.search(SYSTEM_CONFIG_ENTITY, {
        page,
        limit: this.pageSize,
        sort: [{ field: 'id', order: 'ASC', naturalSorting: false }],
      });
      for (const entity of result.elements) rows.push(toSystemConfigRow(entity));
      if (result.elements.length < this.pageSize) return rows;
    }
  }

  async upsert(row: SystemConfigRow): Promise<void> {
    await this.data.upsert(SYSTEM_CONFIG_ENTITY, [toDataRow(row)]);
  }

  /** 키로 지운다 — 로컬은 판매채널이 늘 null 이라 키 하나에 한 줄(부분 UNIQUE 색인) · 없으면 아무것도 안 한다 */
  async delete(configurationKey: string): Promise<void> {
    const found = await this.data.search(SYSTEM_CONFIG_ENTITY, {
      filter: [{ type: 'equals', field: 'configurationKey', value: configurationKey }],
    });
    const ids = found.elements.map((e) => e.id);
    if (ids.length > 0) await this.data.delete(SYSTEM_CONFIG_ENTITY, ids);
  }
}
