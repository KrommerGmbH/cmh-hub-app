// R1-b — AdminApiDriver: 같은 Criteria 를 서버 Admin API 로. HTTP 를 직접 하지 않고 주입받은 transport 로만 부른다
// (합의안 3 · 앱은 AppSession.call — 서명 헤더 · 어드민 쿠키 토큰 길 그대로 · apps/desktop/src/main/identity/app-session.ts:62).
// 앱 쪽 잇기: `const transport: AdminApiTransport = (path, body) => appSession.call<unknown>(path, body)`
import type { EntityRegistry, ResolvedEntityDefinition } from '../../definition/registry.js';
import type { Entity } from '../../definition/types.js';
import { entityNameToPath, isId, newId, snakeToCamel } from '../../naming.js';
import { criteriaToParams, normalizeCriteria, type NormalizedCriteria } from '../criteria-normalizer.js';
import { validateCriteria } from '../criteria-rules.js';
import {
  CriteriaError,
  DataWriteError,
  type CriteriaInput,
  type EntityDriver,
  type EntitySearchResult,
  type IdSearchResult,
  type RawRow,
  type ReadOptions,
  type WriteResult,
} from '../types.js';
import { fromServer, toStorage } from '../value-codec.js';

/** AppSession.call 과 같은 꼴(그쪽은 appError 칸이 더 있다 — 그대로 넘겨도 맞는다) · null = 로그인 전(토큰 없음) */
export type AdminApiTransport = (path: string, body: unknown) => Promise<{ status: number; data: unknown | null } | null>;

export class AdminApiError extends Error {
  override readonly name = 'AdminApiError';
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

export interface AdminApiDriverOptions {
  readonly transport: AdminApiTransport;
  readonly registry: EntityRegistry;
}

export const ADMIN_API_PATHS = {
  search: (entityName: string) => `/api/search/${entityNameToPath(entityName)}`,
  // search-ids · sync 는 Shopware Admin API 경로 — search-ids 는 이 앱에서 서버 실측 안 함(2026-10-07)
  searchIds: (entityName: string) => `/api/search-ids/${entityNameToPath(entityName)}`,
  sync: '/api/_action/sync',
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 집계 결과에서 서버가 붙이는 apiAlias 를 뺀다(로컬 결과와 같은 꼴로) */
function stripApiAlias(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripApiAlias);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== 'apiAlias') out[k] = stripApiAlias(v);
  return out;
}

export class AdminApiDriver implements EntityDriver {
  private readonly transport: AdminApiTransport;
  private readonly registry: EntityRegistry;

  constructor(options: AdminApiDriverOptions) {
    this.transport = options.transport;
    this.registry = options.registry;
  }

  async search(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<EntitySearchResult> {
    const def = this.registry.get(entityName);
    const { params, normalized } = this.prepare(def, criteria, options);
    const body = await this.call(ADMIN_API_PATHS.search(entityName), params);
    return this.toSearchResult(def, normalized, body);
  }

  async searchIds(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<IdSearchResult> {
    const def = this.registry.get(entityName);
    const { params, normalized } = this.prepare(def, criteria, options);
    const body = await this.call(ADMIN_API_PATHS.searchIds(entityName), params);
    const data = body['data'];
    if (!Array.isArray(data)) throw new AdminApiError(`${entityName}: search-ids 응답에 data 배열이 없다`, null, body);
    return { total: this.total(normalized, body), ids: data.map((x) => String(x)) };
  }

  async get(entityName: string, id: string, criteria?: CriteriaInput, options: ReadOptions = {}): Promise<Entity | null> {
    if (!isId(id)) throw new CriteriaError(`${entityName}: id '${id}' 는 32자 hex 가 아니다`);
    // transport 가 POST 하나뿐이라 GET /api/<entity>/<id> 대신 search + ids
    const params: Record<string, unknown> = { ...criteriaToParams(criteria ?? {}), ids: id, 'total-count-mode': 0 };
    delete params['page'];
    delete params['limit'];
    delete params['aggregations'];
    const r = await this.search(entityName, params, options);
    return r.elements[0] ?? null;
  }

  async aggregate(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<Record<string, unknown>> {
    // 집계만 — search 에 limit 1 · 세지 않음으로 실어 보낸다(/api/aggregate 경로는 이 앱에서 실측 안 함)
    const params = { ...criteriaToParams(criteria), limit: 1, page: 1, 'total-count-mode': 0 };
    const r = await this.search(entityName, params, options);
    return r.aggregations;
  }

  /** Shopware sync — 본문 꼴은 CmhAiAgent/scripts/import-endpoints-to-db.mjs:369 (`[{ action, entity, payload }]` · 속성 camelCase) */
  async upsert(entityName: string, rows: readonly RawRow[]): Promise<WriteResult> {
    const def = this.registry.get(entityName);
    if (!Array.isArray(rows)) throw new DataWriteError(`${entityName}: upsert 는 배열을 받는다`);
    const payload = rows.map((row, i) => this.toPayload(def, row, `${entityName}[${i}]`));
    await this.call(ADMIN_API_PATHS.sync, [{ action: 'upsert', entity: entityName, payload }]);
    return { ids: payload.map((p) => p['id'] as string) };
  }

  /** 꼴 근거 CmhAiAgent/scripts/find-data-rows.mjs:89 (`payload: [{ id }]`) · 서버는 없던 id 를 알려 주지 않는다 → 받은 id 를 그대로 돌려준다 */
  async delete(entityName: string, ids: readonly string[]): Promise<WriteResult> {
    this.registry.get(entityName);
    for (const id of ids) if (!isId(id)) throw new DataWriteError(`${entityName}: id '${id}' 는 32자 hex 가 아니다`);
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { ids: [] };
    await this.call(ADMIN_API_PATHS.sync, [{ action: 'delete', entity: entityName, payload: unique.map((id) => ({ id })) }]);
    return { ids: unique };
  }

  // ───────────── 안쪽 ─────────────

  private prepare(def: ResolvedEntityDefinition, criteria: CriteriaInput, options: ReadOptions): { params: Record<string, unknown>; normalized: NormalizedCriteria } {
    const params = criteriaToParams(criteria);
    const normalized = normalizeCriteria(params);
    // 로컬과 같은 검사 — 서버가 받아 줄 것이라도 로컬이 못 하는 것은 여기서 막는다(dataSource 를 바꿔도 같은 동작)
    validateCriteria(this.registry, def, normalized, options.scope ?? 'api');
    return { params, normalized };
  }

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.transport(path, body);
    if (res === null) throw new AdminApiError(`${path}: 서버 로그인 전이다(토큰 없음)`, null, null);
    if (res.status < 200 || res.status >= 300) {
      const errors = isPlainObject(res.data) ? res.data['errors'] : undefined;
      const first = Array.isArray(errors) && isPlainObject(errors[0]) ? errors[0] : null;
      const detail = first ? String(first['detail'] ?? first['title'] ?? '') : '';
      throw new AdminApiError(`${path}: 서버 응답 ${res.status}${detail ? ` — ${detail}` : ''}`, res.status, res.data);
    }
    // sync 는 본문이 비어 올 수 있다(204 · 확인 못 함)
    return isPlainObject(res.data) ? res.data : {};
  }

  private total(c: NormalizedCriteria, body: Record<string, unknown>): number | null {
    // 0 = 안 셈 → null(서버는 이때 받은 줄 수를 total 로 준다고 알려져 있으나 실측 안 함 · 로컬과 맞춘다)
    if (c.totalCountMode === 0) return null;
    const t = body['total'];
    return typeof t === 'number' ? t : t === undefined || t === null ? null : Number(t);
  }

  private toSearchResult(def: ResolvedEntityDefinition, c: NormalizedCriteria, body: Record<string, unknown>): EntitySearchResult {
    const data = body['data'];
    if (!Array.isArray(data)) throw new AdminApiError(`${def.entityName}: search 응답에 data 배열이 없다`, null, body);
    const elements = data.map((raw, i) => this.project(def, raw, c, `${def.entityName}.data[${i}]`));
    // PHP 빈 배열은 JSON `[]` 로 온다 → 빈 객체로
    const rawAgg = body['aggregations'];
    const aggregations: Record<string, unknown> = {};
    if (isPlainObject(rawAgg)) for (const a of c.aggregations) if (a.name in rawAgg) aggregations[a.name] = stripApiAlias(rawAgg[a.name]);
    return { total: this.total(c, body), elements, aggregations };
  }

  /** 서버 엔티티(JSON) → 로컬 응답과 같은 꼴: 정의 칸만(apiAlias · extensions · translated · _uniqueIdentifier 뺌) + 요청한 연관만 */
  private project(def: ResolvedEntityDefinition, raw: unknown, c: NormalizedCriteria, at: string): Entity {
    if (!isPlainObject(raw)) throw new AdminApiError(`${at}: 엔티티가 객체가 아니다`, null, raw);
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.apiAware === false) continue; // 서버는 비밀칸을 주지 않는다
      const prop = snakeToCamel(f.name);
      out[prop] = fromServer(f, raw[prop]);
    }
    if (typeof out['id'] !== 'string') throw new AdminApiError(`${at}: id 가 없다`, null, raw);
    for (const [name, nested] of c.associations) {
      const a = def.association(name);
      if (!a) throw new CriteriaError(`${def.entityName}: 정의에 없는 연관 '${name}'`);
      const target = this.registry.get(a.reference);
      const v = raw[name];
      if (a.kind === 'manyToOne') {
        out[name] = isPlainObject(v) ? this.project(target, v, nested, `${at}.${name}`) : null;
      } else {
        // 컬렉션이 배열 또는 id → 엔티티 객체로 올 수 있다(서버 꼴 확인 못 함 · 둘 다 받는다)
        const list = Array.isArray(v) ? v : isPlainObject(v) ? Object.values(v) : [];
        out[name] = list.map((x, i) => this.project(target, x, nested, `${at}.${name}[${i}]`));
      }
    }
    return out as Entity;
  }

  private toPayload(def: ResolvedEntityDefinition, row: RawRow, at: string): Record<string, unknown> {
    if (!isPlainObject(row)) throw new DataWriteError(`${at}: 줄이 객체가 아니다`);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue;
      const field = def.field(key);
      if (!field) {
        if (def.association(key)) throw new DataWriteError(`${at}: 연관 '${key}' 을 같이 쓰는 것은 아직 못 한다 — 엔티티마다 따로 upsert`);
        throw new DataWriteError(`${at}: 정의에 없는 칸 '${key}'`);
      }
      const prop = snakeToCamel(field.name);
      if (prop in out) throw new DataWriteError(`${at}: 칸 '${field.name}' 이 두 이름으로 두 번 들어왔다`);
      let stored: string | number | null;
      try {
        stored = toStorage(field, value, `${at}.${key}`); // 로컬과 같은 값 검사
      } catch (e) {
        throw new DataWriteError(e instanceof Error ? e.message : String(e), { cause: e });
      }
      // 서버 JSON 은 bool = true/false · json = 객체 그대로
      out[prop] = field.type === 'bool' ? (stored === null ? null : stored === 1) : field.type === 'json' ? value : stored;
    }
    if (out['id'] === undefined || out['id'] === null) out['id'] = newId();
    return out;
  }
}
