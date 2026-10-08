// R2-b — 플러그인이 부르는 앱 메서드(`host:*`) 표 하나. 플러그인 프로세스(utilityProcess RPC)와 플러그인 화면(WebContentsView IPC)이 «같은 표 · 같은 검사» 를 쓴다.
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 원칙 8(촘촘한 제어): deny by default — 표에 없는 `host:*` 는 permissionDenied · 표에 있어도 매니페스트 선언과 대조한 뒤에만 부른다.
//   플러그인 쪽 검사는 믿지 않는다. 자료 · 설정은 주입 인터페이스로만 닿는다(DataService · SettingsStore 를 직접 import 하지 않는다 — 다른 담당이 짓는 중).
//
// 메서드(정본 이름):
//   host:log            { level: 'info'|'warn'|'error', message }      선언 없이 허용(자기 이름으로 앱 로그에 한 줄 · 초당 상한) 【AI 임시 결정】
//   host:settings.get   { key }                                         contributes.settings 에 선언한 자기 키만 · 값이 없거나 타입이 다르면 선언한 default(없으면 null)
//   host:data.search    { entity, criteria? }   entity:<e>:read 필요 · criteria 의 연관(associations) · 점 경로(`messages.content`)는
//                                               schema 로 대상 엔티티를 풀어 대상마다 read 선언이 있을 때만(schema 가 없으면 늘 거부 · 검수 8 🔴1)
//   host:data.get       { entity, id }          entity:<e>:read 필요
//   host:data.upsert    { entity, rows[] }      entity:<e>:crud 필요 · 승인 엔티티 쓰기는 늘 거부(합의안 5) · rows 안(중첩 포함)에 승인 연관 키가 있으면 거부
//   host:data.delete    { entity, ids[] }       entity:<e>:crud 필요 · 승인 엔티티 · 지우면 승인 행이 바뀌는 엔티티(APPROVAL_CASCADE_DELETE_ENTITIES)는 늘 거부
//   예약 엔티티(plugin-permissions.ts PLUGIN_RESERVED_ENTITIES · system_config)는 위 넷 모두 선언과 상관없이 거부 · 연관 hop 으로 예약 · 승인 엔티티에 가는 것도 거부(검수 10 🟡4)
// 옛 이름(R2-a · examples/plugin-hello 가 쓴다): repository.search|get|upsert|delete · log → 같은 처리기(별칭). 새 플러그인은 host:* 를 쓴다.

import type { EntityDefinition } from '@cmh-hub-app/data';
import { isApprovalAssociationKey } from '../settings/approval-entity.js';
import { SETTING_TYPES, type PluginManifest } from './plugin-manifest.js';
import { checkEntityAccess, isApprovalCascadeDeleteEntity, isBlockedAssociationTarget, type EntityOperation } from './plugin-permissions.js';
import { RPC_ERROR, RpcError, type RpcMethodHandler } from './plugin-rpc.js';

/** 플러그인이 쓰는 자료층(R1 Repository 를 엔티티 이름으로 감싼 것). 앱 쪽 연결은 main.ts(DataService) 몫 */
export interface PluginDataAccess {
  search(entity: string, criteria: unknown): Promise<unknown>;
  get(entity: string, id: string): Promise<unknown>;
  upsert(entity: string, rows: readonly unknown[]): Promise<unknown>;
  delete(entity: string, ids: readonly string[]): Promise<unknown>;
}

/** 플러그인 설정 읽기(R7 SettingsStore 를 감싼 것). 값이 없으면 undefined. 키 이름 공간은 플러그인마다 따로(pluginName 이 이름 공간) */
export interface PluginSettingsReader {
  get(pluginName: string, key: string): unknown | Promise<unknown>;
}

export interface PermissionDeniedInfo {
  readonly plugin: string;
  readonly method: string;
  /** 엔티티 검사로 거부했을 때만 */
  readonly entity?: string;
  readonly operation?: EntityOperation;
  readonly reason: string;
}

/**
 * 연관 대상 풀이(R1 엔티티 정의를 감싼 것). `host:data.search` 가 criteria 의 연관 · 점 경로를 대상 엔티티마다 read 권한으로 검사할 때 쓴다.
 * 주지 않으면 연관 · 점 경로를 늘 거부한다(대상을 모르면 막는 쪽). 앱 쪽 연결은 main.ts(DataService) 몫 — 정의는 data worker 에 있다.
 */
export interface PluginEntitySchema {
  /** entity 의 연관(propertyName) → 대상 엔티티 이름. 모르는 엔티티 · 연관이면 null */
  associationTarget(entity: string, association: string): string | null;
}

/**
 * 엔티티 정의 목록(plain 값 — worker 에서 IPC 로 받아도 된다) → PluginEntitySchema.
 * `@cmh-hub-app/data` 는 «타입만» import 한다(값을 import 하면 그 index 가 better-sqlite3 를 main 에 싣는다 · data-service.ts 와 같은 까닭).
 */
export function entitySchemaFromDefinitions(definitions: ReadonlyArray<Pick<EntityDefinition, 'entityName' | 'associations'>>): PluginEntitySchema {
  const targets = new Map<string, ReadonlyMap<string, string>>();
  for (const d of definitions) targets.set(d.entityName, new Map(d.associations.map((a) => [a.propertyName, a.reference])));
  return { associationTarget: (entity, association) => targets.get(entity)?.get(association) ?? null };
}

export interface HostApiOptions {
  readonly manifest: PluginManifest;
  readonly data?: PluginDataAccess;
  /** 주면 연관 · 점 경로를 대상 엔티티의 read 선언으로 검사해 허락한다 · 없으면 늘 거부 */
  readonly schema?: PluginEntitySchema;
  readonly settings?: PluginSettingsReader;
  readonly onLog?: (plugin: string, level: string, message: string) => void;
  readonly onPermissionDenied?: (info: PermissionDeniedInfo) => void;
  /** 시험용 시계 */
  readonly now?: () => number;
}

export const HOST_METHOD_PREFIX = 'host:';
export const HOST_METHODS = ['host:log', 'host:settings.get', 'host:data.search', 'host:data.get', 'host:data.upsert', 'host:data.delete'] as const;
export type HostMethod = (typeof HOST_METHODS)[number];
/**
 * 플러그인 프로세스가 알림(id 없음)으로 보내도 되는 메서드 — 이것만(검수 8 🟢8). 알림은 RpcEndpoint 동시 상한에 세지 않으므로
 * host:data.* · host:settings.get 같은 무거운 메서드를 알림으로 무더기로 보내 상한을 비껴가지 못하게 요청(id)으로만 받는다.
 * log 는 동기 · 초당 상한(LogRateLimiter)이 있어 알림으로 둔다(examples · SDK 가 알림으로 보낸다).
 */
export const HOST_NOTIFICATION_METHODS: ReadonlySet<string> = new Set(['host:log', 'log']);

const MAX_LOG_LENGTH = 4_000;
/** log 초당 상한(플러그인 하나 · 출처 하나마다) */
export const PLUGIN_LOG_PER_SECOND = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): RpcError {
  return new RpcError(RPC_ERROR.invalidParams, message);
}

function readEntity(params: unknown): { entity: string; params: Record<string, unknown> } {
  if (!isObject(params) || typeof params['entity'] !== 'string' || params['entity'].length === 0) {
    throw invalidParams('params.entity must be a non-empty string');
  }
  return { entity: params['entity'], params };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ───────────── criteria 검사(검수 8 🔴1) ─────────────
// 자료층(packages/data criteria-normalizer.ts)이 받는 키 · filter · aggregation 꼴을 «허락 목록» 으로 다시 적는다 — 자료층이 기능을 늘려도
// 플러그인 길은 여기서 따로 열 때까지 막힌다(deny by default). 칸 이름이 들어가는 자리는 전부 경로 검사(checkPath)를 지난다.

/** 플러그인이 쓸 수 있는 criteria 키 */
export const PLUGIN_CRITERIA_KEYS: ReadonlySet<string> = new Set(['page', 'limit', 'ids', 'filter', 'post-filter', 'sort', 'aggregations', 'associations', 'total-count-mode']);
/**
 * 받되 비어 있어야 하는 키 【AI 임시 결정】 — 자료층도 아직 못 하는 기능(criteria-normalizer.ts UNSUPPORTED_KEYS)이고,
 * term · query 는 서버 검색 순위 칸(연관 칸 포함)을 훑을 수 있어 대상 엔티티를 가려낼 수 없다 → 값이 있으면 거부.
 */
export const PLUGIN_CRITERIA_EMPTY_KEYS: readonly string[] = Object.freeze(['term', 'query', 'groupFields', 'grouping', 'fields', 'includes']);
const LEAF_FILTER_TYPES: ReadonlySet<string> = new Set(['equals', 'equalsAny', 'contains', 'prefix', 'suffix', 'range']);
const COMPOSITE_FILTER_TYPES: ReadonlySet<string> = new Set(['not', 'multi']);
const AGGREGATION_TYPES: ReadonlySet<string> = new Set(['count', 'sum', 'avg', 'min', 'max', 'terms']);
/** criteria 안 연관을 몇 단까지 따라가나 — 넘으면 거부(재귀 상한) */
const MAX_CRITERIA_DEPTH = 8;
/** rows 안을 훑는 마디 수 상한 — 넘으면 거부(글 한 통 1MB 상한 안에서도 얕게) */
const MAX_ROW_NODES = 100_000;

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v === '';
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return false;
}

/** rows(중첩 객체 · 배열 포함) 안에 승인 엔티티로 가는 연관 키가 있으면 그 키 · 없으면 null. 재귀 대신 스택(깊은 JSON 으로 스택이 넘치지 않게) */
export function findApprovalAssociationKey(rows: unknown): string | null {
  const stack: unknown[] = [rows];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (++visited > MAX_ROW_NODES) return '(too many nested values)';
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (isObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (isApprovalAssociationKey(key)) return key;
        stack.push(value);
      }
    }
  }
  return null;
}

/** log 빈도 상한 — 1초 창마다 PLUGIN_LOG_PER_SECOND 개 · 넘친 개수는 다음 창 첫 줄에 한 번(R2-a plugin-process.ts 에서 옮김) */
export class LogRateLimiter {
  private windowStart = 0;
  private count = 0;
  private dropped = 0;

  constructor(private readonly perSecond: number, private readonly now: () => number = Date.now) {}

  /** 받아들이면 true. 새 창이 열리며 버린 것이 있었으면 onDropped(개수) */
  accept(onDropped: (dropped: number) => void): boolean {
    const now = this.now();
    if (now - this.windowStart >= 1_000) {
      if (this.dropped > 0) onDropped(this.dropped);
      this.windowStart = now;
      this.count = 0;
      this.dropped = 0;
    }
    if (this.count >= this.perSecond) {
      this.dropped += 1;
      return false;
    }
    this.count += 1;
    return true;
  }
}

/** 표에 없는 이름 — `host:*` 는 거부(deny by default) · 그 밖은 Method not found(RpcEndpoint 기본) */
export function unknownHostMethod(method: string): RpcError | null {
  if (!method.startsWith(HOST_METHOD_PREFIX)) return null;
  return new RpcError(RPC_ERROR.permissionDenied, `permission denied: host method "${method.slice(0, 128)}" is not available to plugins`);
}

/**
 * 플러그인 하나의 host 메서드 표. 같은 manifest 로 두 번 만들면(프로세스 · 화면) log 상한은 따로 센다.
 * 처리기는 던질 수 있다(RpcError) — RpcEndpoint · PluginUiBridge 가 오류 답으로 바꾼다.
 */
export function createHostMethods(options: HostApiOptions): Record<string, RpcMethodHandler> {
  const { manifest } = options;
  const plugin = manifest.name;
  const limiter = new LogRateLimiter(PLUGIN_LOG_PER_SECOND, options.now ?? Date.now);

  const deny = (info: Omit<PermissionDeniedInfo, 'plugin'>): never => {
    options.onPermissionDenied?.({ plugin, ...info });
    throw new RpcError(RPC_ERROR.permissionDenied, `permission denied: ${info.reason}`);
  };
  const guard = (method: string, entity: string, operation: EntityOperation): void => {
    const decision = checkEntityAccess(manifest.permissions, entity, operation);
    if (!decision.allowed) deny({ method, entity, operation, reason: decision.reason });
  };
  const data = (): PluginDataAccess => {
    if (!options.data) throw new RpcError(RPC_ERROR.internal, 'no data source attached');
    return options.data;
  };

  /**
   * 칸 경로 하나. 맨 앞 `<entity>.` 는 한 번만 뗀다(자기 칸) · 남은 경로의 마지막 마디 앞은 전부 연관 → schema 로 대상을 풀어 read 검사.
   * 자료층(field-resolver.ts resolveFieldPath)보다 좁게 본다 — 자료층이 «접두로 떼는» 마디도 여기서는 연관으로 보고 풀지 못하면 거부(모르면 막는 쪽).
   */
  const checkPath = (method: string, entity: string, path: unknown, at: string): void => {
    if (typeof path !== 'string') throw invalidParams(`${at}: field must be a string`);
    const rest = path.startsWith(`${entity}.`) ? path.slice(entity.length + 1) : path;
    if (!rest.includes('.')) return;
    const segments = rest.split('.');
    let current = entity;
    for (const segment of segments.slice(0, -1)) {
      current = associationTarget(method, current, segment, `${at} "${path.slice(0, 128)}"`);
    }
  };
  /** 연관 하나 → 대상 엔티티(그 대상에 read 선언이 있어야) */
  const associationTarget = (method: string, entity: string, association: string, at: string): string => {
    if (!options.schema) {
      return deny({ method, entity, operation: 'read', reason: `${at}: associations and dotted field paths are not allowed for plugins` });
    }
    const target = options.schema.associationTarget(entity, association);
    if (target === null) return deny({ method, entity, operation: 'read', reason: `${at}: unknown association "${association.slice(0, 64)}" of ${entity}` });
    // 예약(system_config) · 승인 엔티티로는 연관으로 못 간다 — 선언이 있어도(검수 10 🟡4 · 승인 엔티티는 루트 read 만)
    if (isBlockedAssociationTarget(target)) return deny({ method, entity: target, operation: 'read', reason: `${at}: associations to ${target} are not allowed for plugins` });
    guard(method, target, 'read');
    return target;
  };
  const checkFilters = (method: string, entity: string, list: unknown, at: string, depth: number): void => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) throw invalidParams(`${at}: must be an array`);
    list.forEach((raw, i) => checkFilter(method, entity, raw, `${at}[${i}]`, depth));
  };
  const checkFilter = (method: string, entity: string, raw: unknown, at: string, depth: number): void => {
    if (depth > MAX_CRITERIA_DEPTH) deny({ method, entity, operation: 'read', reason: `${at}: filters nested deeper than ${MAX_CRITERIA_DEPTH}` });
    if (!isObject(raw)) throw invalidParams(`${at}: filter must be an object`);
    const type = raw['type'];
    if (typeof type === 'string' && COMPOSITE_FILTER_TYPES.has(type)) {
      checkFilters(method, entity, raw['queries'], `${at}.queries`, depth + 1);
      return;
    }
    if (typeof type !== 'string' || !LEAF_FILTER_TYPES.has(type)) {
      deny({ method, entity, operation: 'read', reason: `${at}: filter type "${String(type).slice(0, 32)}" is not allowed for plugins` });
    }
    checkPath(method, entity, raw['field'], at);
  };
  const checkSort = (method: string, entity: string, raw: unknown, at: string): void => {
    if (!isObject(raw)) throw invalidParams(`${at}: sort must be an object`);
    checkPath(method, entity, raw['field'], at);
  };
  const checkCriteria = (method: string, entity: string, criteria: unknown, at: string, depth: number): void => {
    if (criteria === undefined || criteria === null) return;
    if (!isObject(criteria)) throw invalidParams(`${at}: criteria must be an object`);
    if (depth > MAX_CRITERIA_DEPTH) deny({ method, entity, operation: 'read', reason: `${at}: associations nested deeper than ${MAX_CRITERIA_DEPTH}` });
    for (const [key, value] of Object.entries(criteria)) {
      if (PLUGIN_CRITERIA_KEYS.has(key)) continue;
      if (PLUGIN_CRITERIA_EMPTY_KEYS.includes(key) && isEmptyValue(value)) continue;
      deny({ method, entity, operation: 'read', reason: `${at}: criteria key "${key.slice(0, 64)}" is not allowed for plugins` });
    }
    checkFilters(method, entity, criteria['filter'], `${at}.filter`, 0);
    checkFilters(method, entity, criteria['post-filter'], `${at}.post-filter`, 0);
    const sort = criteria['sort'];
    if (sort !== undefined && sort !== null) {
      if (!Array.isArray(sort)) throw invalidParams(`${at}.sort: must be an array`);
      sort.forEach((s, i) => checkSort(method, entity, s, `${at}.sort[${i}]`));
    }
    const aggregations = criteria['aggregations'];
    if (aggregations !== undefined && aggregations !== null) {
      if (!Array.isArray(aggregations)) throw invalidParams(`${at}.aggregations: must be an array`);
      aggregations.forEach((raw, i) => {
        const aat = `${at}.aggregations[${i}]`;
        if (!isObject(raw)) throw invalidParams(`${aat}: aggregation must be an object`);
        const type = raw['type'];
        if (typeof type !== 'string' || !AGGREGATION_TYPES.has(type)) {
          deny({ method, entity, operation: 'read', reason: `${aat}: aggregation type "${String(type).slice(0, 32)}" is not allowed for plugins` });
        }
        if (!isEmptyValue(raw['aggregation'])) deny({ method, entity, operation: 'read', reason: `${aat}: nested aggregations are not allowed for plugins` });
        checkPath(method, entity, raw['field'], aat);
        if (raw['sort'] !== undefined && raw['sort'] !== null) checkSort(method, entity, raw['sort'], `${aat}.sort`);
      });
    }
    const associations = criteria['associations'];
    if (associations !== undefined && associations !== null) {
      if (!isObject(associations)) throw invalidParams(`${at}.associations: must be an object`);
      for (const [name, nested] of Object.entries(associations)) {
        const target = associationTarget(method, entity, name, `${at}.associations`);
        // 자료층과 같이 객체가 아니면 빈 criteria 로 본다(criteria-normalizer.ts normalizeCriteria)
        checkCriteria(method, target, isObject(nested) ? nested : {}, `${at}.associations.${name.slice(0, 64)}`, depth + 1);
      }
    }
  };

  const search = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    guard(method, entity, 'read');
    const criteria = p['criteria'] ?? {};
    checkCriteria(method, entity, criteria, 'criteria', 0);
    return data().search(entity, criteria);
  };
  const get = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    if (typeof p['id'] !== 'string') throw invalidParams('params.id must be a string');
    guard(method, entity, 'read');
    return data().get(entity, p['id']);
  };
  const upsert = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    if (!Array.isArray(p['rows'])) throw invalidParams('params.rows must be an array');
    guard(method, entity, 'write');
    // 연관 쓰기로 승인 행을 만들거나 바꾸는 길(검수 8 🟡3) — 지금은 드라이버도 연관 쓰기를 거부하지만 플러그인 층에서 따로 막는다
    const key = findApprovalAssociationKey(p['rows']);
    if (key !== null) deny({ method, entity, operation: 'write', reason: `rows contain "${key.slice(0, 64)}" — writes to approvals are only allowed from the app UI` });
    return data().upsert(entity, p['rows']);
  };
  const remove = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    if (!isStringArray(p['ids'])) throw invalidParams('params.ids must be an array of strings');
    guard(method, entity, 'write');
    // 지우면 승인 행이 같이 지워지거나(CASCADE) 칸이 비는(SET NULL) 엔티티(검수 8 🟡3)
    if (isApprovalCascadeDeleteEntity(entity)) {
      deny({ method, entity, operation: 'write', reason: `deleting ${entity} changes approval rows — only allowed from the app UI` });
    }
    return data().delete(entity, p['ids']);
  };
  const log: RpcMethodHandler = (params) => {
    if (!isObject(params)) return null;
    if (!limiter.accept((dropped) => options.onLog?.(plugin, 'warn', `log rate limited: ${dropped} message(s) dropped`))) return null;
    const level = params['level'] === 'warn' || params['level'] === 'error' ? params['level'] : 'info';
    const message = typeof params['message'] === 'string' ? params['message'].slice(0, MAX_LOG_LENGTH) : '';
    options.onLog?.(plugin, level, message);
    return null;
  };
  const settingsGet: RpcMethodHandler = async (params) => {
    if (!isObject(params) || typeof params['key'] !== 'string' || params['key'].length === 0) throw invalidParams('params.key must be a non-empty string');
    const key = params['key'];
    const declared = manifest.contributes.settings.find((s) => s.key === key);
    if (!declared) return deny({ method: 'host:settings.get', reason: `setting "${key.slice(0, 128)}" is not declared in contributes.settings` });
    const fallback = declared.default ?? null;
    if (!options.settings) return fallback;
    const value = await options.settings.get(plugin, key);
    // 저장값이 선언한 타입과 다르면(사람이 손으로 고친 설정 파일 등) 선언한 default 로
    if (value === undefined || value === null || !(SETTING_TYPES as readonly string[]).includes(typeof value) || typeof value !== declared.type) return fallback;
    return value;
  };

  return {
    'host:log': log,
    'host:settings.get': settingsGet,
    'host:data.search': search('host:data.search'),
    'host:data.get': get('host:data.get'),
    'host:data.upsert': upsert('host:data.upsert'),
    'host:data.delete': remove('host:data.delete'),
    // R2-a 옛 이름 — 같은 처리기 · 같은 검사(거부 기록의 method 는 옛 이름 그대로)
    'repository.search': search('repository.search'),
    'repository.get': get('repository.get'),
    'repository.upsert': upsert('repository.upsert'),
    'repository.delete': remove('repository.delete'),
    log,
  };
}
