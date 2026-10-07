// R7-b — 설정 저장소 `SettingsStore`. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 행 꼴은 Shopware 테이블 `system_config` 와 같다(PLAN R7 §2): `id` · `configuration_key` · `configuration_value`(JSON) ·
// `sales_channel_id`(로컬은 늘 null) · `created_at` · `updated_at`. 서버 모드로 바꿔도 칸 뜻이 같다(원칙 6).
// `configuration_value` 는 Shopware 처럼 `{"_value": <값>}` 으로 싼 JSON 글이다
// (본보기: CmhCore `src/Service/Installer/CmhCoreSeedInstaller.php:358` — `json_encode(['_value' => …])`).
//
// 저장 자리는 `SettingsBackend` 로 주입한다 — 지금은 메모리(`InMemorySettingsBackend`) · 나중에 R1 데이터 계층 위에서 돈다.
// 읽기(get)는 open 때 읽어 둔 캐시에서 바로 · 쓰기(set · delete)는 차례 줄(한 번에 하나)로 backend 에 쓴 뒤 캐시를 바꾸고,
// 줄을 빠져나온 뒤 onChange listener 를 부른다(set · delete 의 Promise 는 listener 가 끝난 뒤 풀린다).
// backend 쓰기가 실패하면 캐시는 그대로 · 이벤트 없음 · 그 호출만 거부된다.
//
// 【AI 임시 결정】 비밀값(API 키 · 비밀번호 · 토큰 · 시크릿)은 여기 넣지 않는다 — PLAN R7 §9 «저장은 safeStorage».
//   키 마지막 마디가 비밀처럼 보이면(SECRET_KEY_SUFFIXES 로 끝남 · 대소문자 · `_` `-` 무시) set 이 예외를 던진다.
//   `maxTokens` 처럼 «tokens» 로 끝나는 보통 설정은 막지 않으려고 «포함»이 아니라 «끝남»으로 본다.

import { randomUUID } from 'node:crypto';
import type { Disposable } from '../plugin/event-bus.js';

/** Shopware `system_config` 한 행. 로컬은 판매채널이 없어 `sales_channel_id` 가 늘 null */
export interface SystemConfigRow {
  readonly id: string;
  readonly configuration_key: string;
  /** `{"_value": <값>}` JSON 글 */
  readonly configuration_value: string;
  readonly sales_channel_id: null;
  /** ISO 8601(`Date#toISOString`) — R1 드라이버와 같은 꼴 */
  readonly created_at: string;
  readonly updated_at: string | null;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * 저장 자리. R1 데이터 계층(비동기)도 넣을 수 있게 반환은 MaybePromise 다.
 * 【AI 임시 결정】 sync 만 받으면 R1 위로 옮길 때 이 인터페이스를 다시 바꿔야 해서 처음부터 Promise 도 받는다.
 */
export interface SettingsBackend {
  load(): MaybePromise<readonly SystemConfigRow[]>;
  upsert(row: SystemConfigRow): MaybePromise<void>;
  delete(configurationKey: string): MaybePromise<void>;
}

/** 시험 · 첫 실행용 메모리 backend */
export class InMemorySettingsBackend implements SettingsBackend {
  private readonly rows = new Map<string, SystemConfigRow>();

  constructor(initial: readonly SystemConfigRow[] = []) {
    for (const row of initial) this.rows.set(row.configuration_key, row);
  }

  load(): readonly SystemConfigRow[] {
    return [...this.rows.values()];
  }

  upsert(row: SystemConfigRow): void {
    this.rows.set(row.configuration_key, row);
  }

  delete(configurationKey: string): void {
    this.rows.delete(configurationKey);
  }
}

/** 설정 변경 이벤트(PLAN R7 §7) — 플러그인 subscriber 가 듣는다. 지우면 newValue 가 null · 새로 만들면 oldValue 가 null */
export interface SettingsChangeEvent {
  readonly key: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export type SettingsChangeListener = (event: SettingsChangeEvent) => unknown;

export interface SettingsStoreOptions {
  /** 시험용 — 기본 `new Date().toISOString()` */
  readonly now?: () => string;
  /** 시험용 — 기본 하이픈 없는 32자 hex(Shopware id 꼴) */
  readonly newId?: () => string;
  /** listener 예외 · 거부된 Promise 를 받는다. 주지 않으면 console.error(조용히 버리지 않는다 — EventBus 와 같은 꼴) */
  readonly onListenerError?: (error: unknown, event: SettingsChangeEvent) => void;
}

// ---------------------------------------------------------------- 키 규칙

/** 【AI 임시 결정】 키 전체 길이 상한(Shopware 칸 길이는 이 저장소에서 확인하지 못했다 — 넉넉히 255) */
export const SETTINGS_KEY_MAX = 255;
/** 【AI 임시 결정】 마디 수 — Shopware 꼴 `<domain>.<group>.<name>` 이 최소 셋 · 위로는 8 */
export const SETTINGS_KEY_MIN_SEGMENTS = 3;
export const SETTINGS_KEY_MAX_SEGMENTS = 8;
/** 마디 한 개 — ASCII 글자 · 숫자 · `_` 만(공백 · 비ASCII · 빈 마디 금지) */
const KEY_SEGMENT = /^[A-Za-z0-9_]+$/;
/** 【AI 임시 결정】 비밀값으로 보는 마지막 마디 끝(소문자 · `_` `-` 를 뗀 꼴로 견준다) */
export const SECRET_KEY_SUFFIXES: readonly string[] = Object.freeze(['apikey', 'password', 'token', 'secret']);

/** 키 마지막 마디가 비밀값처럼 보이나(`naver.login.password` · `ai.openai.apiKey` · `x.y.accessToken`) */
export function looksLikeSecretKey(key: string): boolean {
  const last = key.split('.').pop() ?? '';
  const compact = last.toLowerCase().replace(/[_-]/g, '');
  return SECRET_KEY_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

/** 키 모양 검사. 틀리면 예외 — 고칠 사람은 프로그래머다 */
export function assertSettingsKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new Error('settings: key must be a non-empty string');
  if (key.length > SETTINGS_KEY_MAX) throw new Error(`settings: key longer than ${SETTINGS_KEY_MAX}`);
  const segments = key.split('.');
  if (segments.length < SETTINGS_KEY_MIN_SEGMENTS || segments.length > SETTINGS_KEY_MAX_SEGMENTS) {
    throw new Error(`settings: key "${key}" must have ${SETTINGS_KEY_MIN_SEGMENTS}..${SETTINGS_KEY_MAX_SEGMENTS} dot-separated segments (<domain>.<group>.<name>)`);
  }
  if (!segments.every((s) => KEY_SEGMENT.test(s))) {
    throw new Error(`settings: key "${key}" segments must match ${KEY_SEGMENT.source}`);
  }
}

// ---------------------------------------------------------------- 값 규칙

/** 【AI 임시 결정】 값 중첩 깊이 상한 — 순환 참조도 여기서 걸린다 */
const VALUE_MAX_DEPTH = 32;

/**
 * JSON 으로 그대로 오가는 값만 받는다: null · boolean · 유한한 number · string · 배열 · 보통 객체.
 * JSON.stringify 가 조용히 바꾸는 것(undefined 칸이 빠짐 · NaN → null · Date → 글 · Map → {})은 예외로 막는다 —
 * 저장한 값과 읽은 값이 달라지면 안 된다.
 */
function assertJsonValue(value: unknown, path: string, depth: number): void {
  if (depth > VALUE_MAX_DEPTH) throw new Error(`settings: value nested deeper than ${VALUE_MAX_DEPTH} at ${path} (cycle?)`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`settings: non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(`settings: only plain objects are allowed at ${path}`);
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`, depth + 1);
    return;
  }
  throw new Error(`settings: ${typeof value} is not a JSON value at ${path}`);
}

function encodeValue(value: unknown): string {
  assertJsonValue(value, '$', 0);
  return JSON.stringify({ _value: value });
}

/** `{"_value": …}` 를 푼다. 깨진 글이면 예외(backend 자료가 망가졌다 — 조용히 null 로 바꾸지 않는다) */
function decodeValue(row: SystemConfigRow): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.configuration_value);
  } catch (error) {
    throw new Error(`settings: configuration_value of "${row.configuration_key}" is not JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.hasOwn(parsed, '_value')) {
    throw new Error(`settings: configuration_value of "${row.configuration_key}" must be {"_value": …}`);
  }
  return (parsed as { _value: unknown })._value;
}

function defaultNewId(): string {
  return randomUUID().replace(/-/g, '');
}

// ---------------------------------------------------------------- 저장소

export class SettingsStore {
  private readonly rows = new Map<string, SystemConfigRow>();
  private readonly listeners = new Set<SettingsChangeListener>();
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly onListenerError: (error: unknown, event: SettingsChangeEvent) => void;
  /** 쓰기 차례 줄 — 같은 키 set 두 번이 겹쳐 backend 와 캐시 차례가 엇갈리는 race condition 을 막는다 */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly backend: SettingsBackend,
    options: SettingsStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultNewId;
    this.onListenerError = options.onListenerError ?? ((error, event) => console.error(`[settings] change listener failed (${event.key})`, error));
  }

  /** backend 에서 모든 행을 읽어 캐시를 채운다. sales_channel_id 가 null 이 아닌 행 · 같은 키 두 줄은 예외 */
  static async open(backend: SettingsBackend, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    const store = new SettingsStore(backend, options);
    for (const row of await backend.load()) {
      if (row.sales_channel_id !== null) {
        throw new Error(`settings: row "${row.configuration_key}" has sales_channel_id — local settings must be null`);
      }
      if (store.rows.has(row.configuration_key)) throw new Error(`settings: duplicate key "${row.configuration_key}" in backend`);
      store.rows.set(row.configuration_key, row);
    }
    return store;
  }

  /** 값이 없으면 null. parse 는 `_value` 를 받아 검증한 값을 돌려준다(틀리면 parse 가 던진다) */
  get<T>(key: string, parse: (raw: unknown) => T): T | null {
    assertSettingsKey(key);
    const row = this.rows.get(key);
    return row === undefined ? null : parse(decodeValue(row));
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  /** 들어 있는 키(차례 없음) — 설정 화면 목록용 */
  keys(): string[] {
    return [...this.rows.keys()];
  }

  /** 값을 넣는다. undefined 는 지우기로 오해되지 않게 거부(지우려면 delete) · 비밀값 키는 거부(safeStorage 로) */
  async set(key: string, value: unknown): Promise<void> {
    assertSettingsKey(key);
    if (looksLikeSecretKey(key)) {
      throw new Error(`settings: "${key}" looks like a secret — store secrets with safeStorage (CredentialStore), not in system_config`);
    }
    if (value === undefined) throw new Error(`settings: value for "${key}" is undefined — use delete()`);
    const encoded = encodeValue(value);
    const event = await this.enqueue(async (): Promise<SettingsChangeEvent | null> => {
      const previous = this.rows.get(key);
      const oldValue = previous === undefined ? null : decodeValue(previous);
      // 【AI 임시 결정】 같은 값(같은 JSON 글) — 쓰지도 알리지도 않는다
      if (previous !== undefined && previous.configuration_value === encoded) return null;
      const at = this.now();
      const row: SystemConfigRow = {
        id: previous?.id ?? this.newId(),
        configuration_key: key,
        configuration_value: encoded,
        sales_channel_id: null,
        created_at: previous?.created_at ?? at,
        updated_at: previous === undefined ? null : at,
      };
      await this.backend.upsert(row);
      this.rows.set(key, row);
      return { key, oldValue, newValue: decodeValue(row) };
    });
    if (event !== null) await this.notify(event);
  }

  /** 지운다. 없던 키면 아무것도 안 하고 알리지도 않는다 */
  async delete(key: string): Promise<void> {
    assertSettingsKey(key);
    const event = await this.enqueue(async (): Promise<SettingsChangeEvent | null> => {
      const previous = this.rows.get(key);
      if (previous === undefined) return null;
      await this.backend.delete(key);
      this.rows.delete(key);
      return { key, oldValue: decodeValue(previous), newValue: null };
    });
    if (event !== null) await this.notify(event);
  }

  /** 설정 변경 이벤트 구독. dispose 로 푼다 */
  onChange(listener: SettingsChangeListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /**
   * 쓰기 한 건을 차례 줄에 세운다. listener 는 줄 «밖»에서 부른다(set · delete 가 notify 를 줄이 끝난 뒤 부름) —
   * listener 가 안에서 다시 set 을 부르고 그것을 기다려도 줄이 서로를 기다리는 deadlock 이 나지 않게.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    // 한 번 실패해도 뒤 작업은 돈다 — 실패는 그 호출의 Promise 로만 알린다
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** listener 예외는 set 을 실패시키지 않는다(값은 이미 저장됐다) · onListenerError 로 알린다 */
  private async notify(event: SettingsChangeEvent): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result instanceof Promise) pending.push(result.then(() => undefined, (error: unknown) => this.onListenerError(error, event)));
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
    await Promise.all(pending);
  }
}
