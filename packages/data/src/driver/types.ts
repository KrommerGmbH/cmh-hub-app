// R1 — 두 driver(로컬 SQLite · 원격 Admin API)가 같이 지키는 꼴
import type { Criteria, CriteriaRequestParams } from '../criteria.js';
import type { Entity } from '../definition/types.js';

/** Shopware `EntitySearchResult` 와 같은 칸 이름 · total 은 total-count-mode 0 이면 null */
export interface EntitySearchResult<E extends Entity = Entity> {
  total: number | null;
  elements: E[];
  aggregations: Record<string, unknown>;
}

export interface IdSearchResult {
  total: number | null;
  ids: string[];
}

export interface WriteResult {
  /** 쓰거나 지운 id(upsert 는 새로 만든 id 포함) */
  ids: string[];
}

/** Criteria 객체 또는 그 parse() JSON(IPC 로 넘어온 것) */
export type CriteriaInput = Criteria | CriteriaRequestParams;

/**
 * 읽기 범위 — Shopware Context scope 꼴.
 * api(기본) = 비밀칸(apiAware false) 을 응답에서 빼고 그 칸으로 거르기 · 정렬도 막는다(렌더러로 가는 길 · 서버 API 와 같은 결과)
 * system = main 안쪽(R4 가 api_key_enc 를 풀 때)만. 원격 driver 는 서버가 비밀칸을 안 주므로 system 이어도 없다.
 */
export interface ReadOptions {
  readonly scope?: 'api' | 'system';
}

export type RawRow = Record<string, unknown>;

export interface EntityDriver {
  search(entityName: string, criteria: CriteriaInput, options?: ReadOptions): Promise<EntitySearchResult>;
  searchIds(entityName: string, criteria: CriteriaInput, options?: ReadOptions): Promise<IdSearchResult>;
  get(entityName: string, id: string, criteria?: CriteriaInput, options?: ReadOptions): Promise<Entity | null>;
  aggregate(entityName: string, criteria: CriteriaInput, options?: ReadOptions): Promise<Record<string, unknown>>;
  /** 없는 id(또는 id 없음)는 새로 만든다 · 있는 id 는 준 칸만 바꾼다 */
  upsert(entityName: string, rows: readonly RawRow[]): Promise<WriteResult>;
  delete(entityName: string, ids: readonly string[]): Promise<WriteResult>;
}

export class CriteriaError extends Error {
  override readonly name = 'CriteriaError';
}

export class DataWriteError extends Error {
  override readonly name = 'DataWriteError';
}
