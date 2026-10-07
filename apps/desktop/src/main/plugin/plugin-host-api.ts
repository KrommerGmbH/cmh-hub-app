// R2-b — 플러그인이 부르는 앱 메서드(`host:*`) 표 하나. 플러그인 프로세스(utilityProcess RPC)와 플러그인 화면(WebContentsView IPC)이 «같은 표 · 같은 검사» 를 쓴다.
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 원칙 8(촘촘한 제어): deny by default — 표에 없는 `host:*` 는 permissionDenied · 표에 있어도 매니페스트 선언과 대조한 뒤에만 부른다.
//   플러그인 쪽 검사는 믿지 않는다. 자료 · 설정은 주입 인터페이스로만 닿는다(DataService · SettingsStore 를 직접 import 하지 않는다 — 다른 담당이 짓는 중).
//
// 메서드(정본 이름):
//   host:log            { level: 'info'|'warn'|'error', message }      선언 없이 허용(자기 이름으로 앱 로그에 한 줄 · 초당 상한) 【AI 임시 결정】
//   host:settings.get   { key }                                         contributes.settings 에 선언한 자기 키만 · 값이 없거나 타입이 다르면 선언한 default(없으면 null)
//   host:data.search    { entity, criteria? }   entity:<e>:read 필요
//   host:data.get       { entity, id }          entity:<e>:read 필요
//   host:data.upsert    { entity, rows[] }      entity:<e>:crud 필요 · 승인 엔티티 쓰기는 늘 거부(합의안 5)
//   host:data.delete    { entity, ids[] }       entity:<e>:crud 필요 · 승인 엔티티 쓰기는 늘 거부
// 옛 이름(R2-a · examples/plugin-hello 가 쓴다): repository.search|get|upsert|delete · log → 같은 처리기(별칭). 새 플러그인은 host:* 를 쓴다.

import { SETTING_TYPES, type PluginManifest } from './plugin-manifest.js';
import { checkEntityAccess, type EntityOperation } from './plugin-permissions.js';
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

export interface HostApiOptions {
  readonly manifest: PluginManifest;
  readonly data?: PluginDataAccess;
  readonly settings?: PluginSettingsReader;
  readonly onLog?: (plugin: string, level: string, message: string) => void;
  readonly onPermissionDenied?: (info: PermissionDeniedInfo) => void;
  /** 시험용 시계 */
  readonly now?: () => number;
}

export const HOST_METHOD_PREFIX = 'host:';
export const HOST_METHODS = ['host:log', 'host:settings.get', 'host:data.search', 'host:data.get', 'host:data.upsert', 'host:data.delete'] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

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

  const search = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    guard(method, entity, 'read');
    return data().search(entity, p['criteria'] ?? {});
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
    return data().upsert(entity, p['rows']);
  };
  const remove = (method: string): RpcMethodHandler => (params) => {
    const { entity, params: p } = readEntity(params);
    if (!isStringArray(p['ids'])) throw invalidParams('params.ids must be an array of strings');
    guard(method, entity, 'write');
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
