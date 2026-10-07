// R1 앱 연결 — 자료 프로세스 안쪽 일(자식 전용). DataSource 를 열고 RPC 메서드를 Repository 에 잇는다.
// 전송(Electron parentPort · Node process.send)은 data-worker.ts 가 맡는다 — 이 파일은 전송을 모른다.
// 권한 규칙은 data-protocol.ts 머리 주석. scope 는 늘 'api'(READ_SCOPE) · system 범위는 secrets.read 안에서 비밀칸 하나만.
// open 전에 registry 를 훑는다(검수 6 S1): 쓰기 보호 엔티티(cmh_ai_approval)에 ON DELETE CASCADE · SET NULL FK 가 있으면 열지 않는다 —
//   denyProtectedWrite 는 루트 엔티티 이름만 보므로, 그런 FK 가 있으면 다른 엔티티 repo.delete 가 승인 줄을 지우거나 바꾼다.

import {
  CorruptDatabaseError,
  CriteriaError,
  DataSourceFactory,
  DataWriteError,
  EntityDefinitionError,
  MigrationError,
  ValueError,
  createDefaultRegistry,
  isId,
  snakeToCamel,
  type CriteriaRequestParams,
  type DataSource,
  type DataSourceOptions,
  type EntityDefinition,
  type EntityRegistry,
  type RawRow,
  type ReadOptions,
} from '@cmh-hub-app/data';
import { RpcError, type RpcMethodHandler } from '../plugin/plugin-rpc.js';
import { isWriteProtectedEntity } from '../settings/approval-entity.js';
import { DATA_METHOD, DATA_RPC_ERROR, type DataOpenErrorData, type HealthResult, type OpenResult, type SecretReadResult } from './data-protocol.js';

/** 렌더러 · 플러그인 · 에이전트로 가는 읽기는 전부 이 범위 — 바꾸는 길을 두지 않는다 */
const READ_SCOPE: ReadOptions = Object.freeze({ scope: 'api' });
const SYSTEM_SCOPE: ReadOptions = Object.freeze({ scope: 'system' });

export type DataSourceCreate = (options: DataSourceOptions) => Promise<DataSource>;

export interface DataWorkerCoreOptions {
  /** 시험에서 바꿔 끼운다 · 기본 DataSourceFactory.create */
  readonly create?: DataSourceCreate;
  /** open 실패 뒤 자식을 끝내는 일(data-worker.ts 가 process.exit 를 넘긴다) */
  readonly onOpenFailed?: () => void;
  /** 시험에서 바꿔 끼운다(가짜 정의를 넣은 registry) · 기본 createDefaultRegistry */
  readonly createRegistry?: () => EntityRegistry;
}

/** 쓰기 보호 엔티티의 FK 중 대상이 지워질 때 그 줄을 지우거나(cascade) 바꾸는(set null) 것 하나 */
export interface ProtectedCascade {
  readonly entity: string;
  readonly field: string;
  readonly reference: string;
  readonly onDelete: 'cascade' | 'set null';
}

/**
 * 쓰기 보호 엔티티(기본 isWriteProtectedEntity)의 fk 칸 중 onDelete 가 cascade · set null 인 것.
 * restrict · 없음(SQLite NO ACTION)은 대상 delete 를 막을 뿐 보호 줄을 바꾸지 않으므로 뺀다.
 * ⚠ 보는 것은 registry 정의뿐 — 중간 테이블(manyToMany mappingTable) · 마이그레이션이 박아 둔 DDL 은 안 본다.
 */
export function findProtectedCascades(
  definitions: readonly Pick<EntityDefinition, 'entityName' | 'fields'>[],
  isProtected: (entityName: string) => boolean = isWriteProtectedEntity,
): ProtectedCascade[] {
  const found: ProtectedCascade[] = [];
  for (const def of definitions) {
    if (!isProtected(def.entityName)) continue;
    for (const field of def.fields) {
      if (field.type !== 'fk' || !field.reference) continue;
      if (field.onDelete === 'cascade' || field.onDelete === 'set null') {
        found.push({ entity: def.entityName, field: field.name, reference: field.reference, onDelete: field.onDelete });
      }
    }
  }
  return found;
}

function openErrorData(name: string, reason: DataOpenErrorData['reason'], backupPath: string | null, sqliteCode?: string): DataOpenErrorData {
  return sqliteCode === undefined ? { name, reason, backupPath } : { name, reason, backupPath, sqliteCode };
}

/** open 실패 → RPC 오류. 메시지에는 전체 경로를 넣지 않는다(자료층 메시지가 이미 파일 이름만 · 전체 경로는 data.backupPath) */
function toOpenRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = `cannot open data source: ${errorMessage(error)}`;
  if (error instanceof CorruptDatabaseError) {
    return new RpcError(DATA_RPC_ERROR.corruptDatabase, message, openErrorData(error.name, 'corruptDatabase', error.backupPath, error.sqliteCode));
  }
  if (error instanceof MigrationError) return new RpcError(DATA_RPC_ERROR.openFailed, message, openErrorData(error.name, 'migrationFailed', error.backupPath));
  return new RpcError(DATA_RPC_ERROR.openFailed, message, openErrorData(errorName(error), 'openFailed', null));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): RpcError {
  return new RpcError(DATA_RPC_ERROR.invalidParams, message);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 자료층 예외 → RPC 오류(번호로 가려 볼 수 있게 · 원래 이름은 data.name) */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const data = { name: errorName(error) };
  if (error instanceof CriteriaError || error instanceof EntityDefinitionError) return new RpcError(DATA_RPC_ERROR.invalidParams, errorMessage(error), data);
  if (error instanceof DataWriteError || error instanceof ValueError) return new RpcError(DATA_RPC_ERROR.writeFailed, errorMessage(error), data);
  if (error instanceof MigrationError) return new RpcError(DATA_RPC_ERROR.openFailed, errorMessage(error), data);
  return new RpcError(DATA_RPC_ERROR.internal, errorMessage(error), data);
}

interface EntityParams {
  readonly entity: string;
  readonly p: Record<string, unknown>;
}

function readEntityParams(params: unknown): EntityParams {
  if (!isObject(params) || typeof params['entity'] !== 'string' || params['entity'].length === 0) {
    throw invalidParams('params.entity must be a non-empty string');
  }
  // scope 는 받지 않는다 — 늘 api. 칸이 있으면 조용히 버리지 않고 거부(부르는 쪽 실수를 드러낸다)
  if (Object.prototype.hasOwnProperty.call(params, 'scope')) throw invalidParams('params.scope is not accepted (reads are always scope "api")');
  const options = params['options'];
  if (options !== undefined) {
    if (!isObject(options)) throw invalidParams('params.options must be an object');
    const keys = Object.keys(options);
    if (keys.includes('scope')) throw invalidParams('params.options.scope is not accepted (reads are always scope "api")');
    if (keys.length > 0) throw invalidParams(`params.options has unknown keys: ${keys.join(', ')}`);
  }
  return { entity: params['entity'], p: params };
}

/** Criteria.parse() JSON 만 받는다(Criteria 객체는 RPC 를 못 건넌다) · 없으면 빈 Criteria */
function readCriteria(p: Record<string, unknown>, key = 'criteria'): CriteriaRequestParams {
  const value = p[key];
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw invalidParams(`params.${key} must be a Criteria JSON object (criteria.parse())`);
  return value as CriteriaRequestParams;
}

function denyProtectedWrite(method: string, entity: string): void {
  if (isWriteProtectedEntity(entity)) {
    throw new RpcError(DATA_RPC_ERROR.permissionDenied, `permission denied: ${method} on "${entity}" — approval state is written only by the main UI IPC`);
  }
}

export class DataWorkerCore {
  private dataSource: DataSource | null = null;
  private filename: string | null = null;
  private opening = false;
  private readonly openedAt = Date.now();
  private readonly create: DataSourceCreate;
  private readonly createRegistry: () => EntityRegistry;

  constructor(private readonly options: DataWorkerCoreOptions = {}) {
    this.create = options.create ?? ((o) => DataSourceFactory.create(o));
    this.createRegistry = options.createRegistry ?? createDefaultRegistry;
  }

  get isOpen(): boolean {
    return this.dataSource !== null;
  }

  async open(params: unknown): Promise<OpenResult> {
    if (!isObject(params) || typeof params['filename'] !== 'string' || params['filename'].length === 0) {
      throw invalidParams('params.filename must be a non-empty string');
    }
    if (this.dataSource || this.opening) throw new RpcError(DATA_RPC_ERROR.invalidRequest, 'data source is already open');
    const filename = params['filename'];
    this.opening = true;
    try {
      const registry = this.createRegistry();
      // 파일을 열기(마이그레이션) 전에 막는다 — 정의만 보면 되므로 DB 를 건드리지 않는다
      const cascades = findProtectedCascades(registry.all());
      if (cascades.length > 0) {
        const list = cascades.map((c) => `${c.entity}.${c.field} → ${c.reference} ON DELETE ${c.onDelete.toUpperCase()}`).join(', ');
        throw new RpcError(
          DATA_RPC_ERROR.openFailed,
          `cannot open data source: write-protected entity has a foreign key that deletes or changes its rows when the referenced row is deleted (${list})`,
          openErrorData('ProtectedEntityCascadeError', 'protectedEntityCascade', null),
        );
      }
      // ⏸ ⑫ 결정 뒤 server — 무료/서버 전환(R9)은 아직 안 한다. 지금은 늘 로컬 SQLite 파일 하나.
      const ds = await this.create({ dataSource: 'local', filename, registry });
      this.dataSource = ds;
      this.filename = filename;
      const migration = ds.migration;
      return { filename, updated: migration?.updated ?? [], destructive: migration?.destructive ?? [] };
    } catch (error) {
      // 깨진 파일 → corruptDatabase(-32014) · 마이그레이션 실패 · FK 검사 실패 · 그 밖 → openFailed(-32010) — 까닭은 data.reason
      const rpcError = toOpenRpcError(error);
      this.options.onOpenFailed?.();
      throw rpcError;
    } finally {
      this.opening = false;
    }
  }

  /** DB 를 닫는다 · 두 번 불러도 된다 */
  async close(): Promise<void> {
    const ds = this.dataSource;
    this.dataSource = null;
    if (ds) await ds.close();
  }

  private ds(): DataSource {
    if (!this.dataSource) throw new RpcError(DATA_RPC_ERROR.notOpen, 'data source is not open');
    return this.dataSource;
  }

  /** 자료층 예외를 RPC 오류로 바꿔 던지는 감싸개 */
  private static guarded(handler: (params: unknown) => Promise<unknown> | unknown): RpcMethodHandler {
    return async (params) => {
      try {
        return await handler(params);
      } catch (error) {
        throw toRpcError(error);
      }
    };
  }

  methods(): Record<string, RpcMethodHandler> {
    const g = DataWorkerCore.guarded;
    return {
      [DATA_METHOD.open]: (params) => this.open(params),
      [DATA_METHOD.shutdown]: async () => {
        await this.close();
        return null;
      },
      [DATA_METHOD.health]: (): HealthResult => {
        const ds = this.ds();
        return { ok: true, pid: process.pid, filename: this.filename ?? '', uptimeMs: Date.now() - this.openedAt, entities: ds.registry.all().length };
      },
      [DATA_METHOD.search]: g((params) => {
        const { entity, p } = readEntityParams(params);
        return this.ds().repository(entity).search(readCriteria(p), READ_SCOPE);
      }),
      [DATA_METHOD.searchIds]: g((params) => {
        const { entity, p } = readEntityParams(params);
        return this.ds().repository(entity).searchIds(readCriteria(p), READ_SCOPE);
      }),
      [DATA_METHOD.get]: g((params) => {
        const { entity, p } = readEntityParams(params);
        if (typeof p['id'] !== 'string') throw invalidParams('params.id must be a string');
        return this.ds().repository(entity).get(p['id'], readCriteria(p), READ_SCOPE);
      }),
      [DATA_METHOD.aggregate]: g((params) => {
        const { entity, p } = readEntityParams(params);
        return this.ds().repository(entity).aggregate(readCriteria(p), READ_SCOPE);
      }),
      [DATA_METHOD.upsert]: g((params) => {
        const { entity, p } = readEntityParams(params);
        denyProtectedWrite(DATA_METHOD.upsert, entity);
        const rows = p['rows'];
        if (!Array.isArray(rows)) throw invalidParams('params.rows must be an array');
        return this.ds().repository(entity).upsert(rows as RawRow[]);
      }),
      [DATA_METHOD.delete]: g((params) => {
        const { entity, p } = readEntityParams(params);
        denyProtectedWrite(DATA_METHOD.delete, entity);
        const ids = p['ids'];
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw invalidParams('params.ids must be an array of strings');
        return this.ds().repository(entity).delete(ids as string[]);
      }),
      [DATA_METHOD.readSecret]: g(async (params): Promise<SecretReadResult> => {
        if (!isObject(params)) throw invalidParams('params must be an object');
        const { entity, id, field } = params;
        if (typeof entity !== 'string' || typeof id !== 'string' || typeof field !== 'string') {
          throw invalidParams('params.entity · params.id · params.field must be strings');
        }
        const ds = this.ds();
        const definition = ds.registry.get(entity);
        const fieldDef = definition.field(field);
        // 비밀칸만 — 이 길이 «system 범위 일반 읽기»가 되지 않게
        if (!fieldDef || fieldDef.apiAware !== false) {
          throw new RpcError(DATA_RPC_ERROR.permissionDenied, `permission denied: ${entity}.${field} is not a secret field`);
        }
        if (!isId(id)) throw invalidParams(`params.id '${id}' is not a 32-char hex id`);
        const row = await ds.driver.get(entity, id, undefined, SYSTEM_SCOPE);
        if (!row) return { value: null };
        const value = (row as Record<string, unknown>)[snakeToCamel(fieldDef.name)];
        return { value: value ?? null };
      }),
    };
  }
}
