// R7-c — 앱 서비스 묶기: 자료층(DataService) · 설정(SettingsStore over system_config) · 플러그인(PluginRegistry · 프로세스 런타임 · 화면 호스트) · EventBus.
// main.ts 는 startAppServices() 한 번(app ready 뒤) · 창을 띄운 뒤 startPlugins() 한 번만 부른다. IPC 채널은 아직 없다(나중에 이 객체로 잇는다).
//
// 차례:
//   ①startDataService — 자료 프로세스를 띄운다(기다리지 않는다 · 창을 막지 않는다).
//   ②설정 — 자료층 첫 띄우기가 끝나면 SettingsStore.open(DataSettingsBackend, { repair: false }).
//     【AI 임시 결정】 자료층이 failed(또는 내리는 중 취소)거나 open 이 실패하면(깨진 행 · RPC 오류) 메모리 backend 로 열고 경고를 남긴다 —
//     그때 바꾼 설정은 앱을 끄면 사라진다. 어느 쪽인지는 AppSettings.source · persistent · failure 로 본다(설정 화면이 생기면 알린다).
//     검수 10 🟡1: 메모리에서 바꾼 키마다 처음 한 번 warn · 되살아날 수 있는 까닭이면 자료층이 running 이 될 때 system_config 로 다시 열고
//     메모리에서 바꾼 키를 옮긴 뒤 바꾼다(openAppSettings 주석).
//   ③플러그인 — startPlugins(): 창을 띄운 «뒤» userData/plugins 를 scan → startup → PluginViewHost. 실패는 로그만(앱은 산다).
//   ④설정 바뀜 → EventBus 'settings.changed'(【AI 임시 결정】 이름). 값은 싣지 않고 키만 싣는다(아래 settingsChangePayload).
// 내리기(will-quit · start-data-service.ts 의 beforeStop): 돌던 startPlugins 기다림(상한) → 플러그인 화면 → 플러그인 레지스트리 →
//   설정 쓰기 끝 기다림(SETTINGS_IDLE_TIMEOUT_MS) → (그 뒤) 자료층.
//
// 플러그인 설정 키(【AI 임시 결정】): `plugin.<이름>.<키>` — SettingsStore 마디는 [A-Za-z0-9_]+ 인데 플러그인 이름은 `-` 를,
//   설정 키(CONTRIBUTION_ID_PATTERN)는 `_` `.` `:` `-` 를 가질 수 있다 → 영숫자 밖 글자는 `_` + 소문자 hex 두 자리로 바꾼다
//   (`plugin-hello` → `plugin_2dhello` · `_` 도 `_5f` 로 바꿔 거꾸로 풀 때 겹치지 않는다). 키 255자 상한을 넘거나 이름이 비밀값처럼 보이면
//   그 설정은 저장하지 않는 것으로 친다(읽기는 선언한 default).
// 플러그인 자료 길(【AI 임시 결정】): system_config 는 읽기 · 쓰기 모두 거부 — 매니페스트에 entity:system_config 를 적어도
//   SettingsStore(비밀값 검사 · 캐시)와 contributes.settings 선언 검사를 건너뛰지 못하게.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CriteriaRequestParams } from '@cmh-hub-app/data';
import { app } from 'electron';
import { DATA_RPC_ERROR } from './data/data-protocol.js';
import type { DataService, DataServiceState } from './data/data-service.js';
import { startDataService } from './data/start-data-service.js';
import { ElectronProcessLauncher } from './plugin/electron-process-launcher.js';
import { EventBus, type Disposable } from './plugin/event-bus.js';
import type { PermissionDeniedInfo, PluginDataAccess, PluginSettingsReader } from './plugin/plugin-host-api.js';
import { createProcessRuntimeFactory } from './plugin/plugin-process.js';
import { PluginRegistry } from './plugin/plugin-registry.js';
import { RPC_ERROR, RpcError } from './plugin/plugin-rpc.js';
import { PluginViewHost } from './plugin/plugin-view-host.js';
import { DataSettingsBackend, SYSTEM_CONFIG_ENTITY, type SettingsDataAccess } from './settings/data-settings-backend.js';
import {
  InMemorySettingsBackend,
  SettingsStore,
  assertSettingsKey,
  looksLikeSecretKey,
  looksLikeSecretName,
  type SettingsChangeEvent,
} from './settings/settings-store.js';

export type AppLogLevel = 'info' | 'warn' | 'error';
export type AppLog = (level: AppLogLevel, message: string, detail?: unknown) => void;

const TAG = '[services]';

function consoleLog(level: AppLogLevel, message: string, detail?: unknown): void {
  const line = `${TAG} ${message}`;
  const args = detail === undefined ? [line] : [line, detail];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.info(...args);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- 설정

/** 【AI 임시 결정】 설정이 바뀔 때 EventBus 에 내는 이벤트 이름 */
export const SETTINGS_CHANGED_EVENT = 'settings.changed';

export interface AppSettings {
  /**
   * 지금 쓰는 저장소. memory 로 열었다가 자료층이 다시 running 이 되면 data 로 한 번 바뀐다 —
   * 붙잡아 두지 말고 쓸 때마다 이 속성을 읽는다(onStoreChange).
   */
  readonly store: SettingsStore;
  /** data = system_config(앱 SQLite) · memory = 앱을 끄면 사라진다 */
  readonly source: 'data' | 'memory';
  /** source 가 data 면 true — false 면 set · delete 는 이번 실행에만 남는다(설정 화면이 이것을 보고 알린다) */
  readonly persistent: boolean;
  /** memory 로 연 까닭(data 면 null) */
  readonly failure: string | null;
  /** 차례 줄에 선 쓰기 · memory → data 옮기기가 모두 끝나면 풀린다(거부하지 않는다) — will-quit 에서 자료층을 내리기 전에 기다린다 */
  whenIdle(): Promise<void>;
  /** store 가 바뀔 때(memory → data). changedKeys = 바뀌면서 읽히는 값이 달라진 키(system_config 에 이미 있던 키) */
  onStoreChange(listener: (store: SettingsStore, changedKeys: readonly string[]) => void): Disposable;
  /** 다시 열기(retry)를 멈춘다 — will-quit 에서 부른다 */
  close(): void;
}

/** 자료층 상태 바뀜을 듣는 길(start-data-service.ts onStateChange 를 app-services 가 나눠 준다) */
export type DataStateWatch = (listener: (state: DataServiceState) => void) => Disposable;

export interface OpenAppSettingsOptions {
  /** 주면 memory 로 열었을 때 자료층이 다시 running 이 되는 것을 듣고 system_config 로 다시 연다(되살아날 수 있는 까닭일 때만) */
  readonly watchState?: DataStateWatch;
}

/** 자료층이 이 상태면 앱을 다시 켜기 전에는 running 으로 못 간다(data-service.ts 머리 주석 «상태» · start 는 idle 에서만) */
const TERMINAL_DATA_STATES: readonly DataServiceState[] = ['failed', 'stopping', 'stopped'];

/** 이 RPC 오류로 open 이 실패했으면 자료층이 다시 running 이 될 때 다시 열어 본다(깨진 행 · 같은 키 두 줄은 다시 열어도 같다) */
const RETRYABLE_OPEN_CODES: readonly number[] = [
  DATA_RPC_ERROR.timeout,
  DATA_RPC_ERROR.processExited,
  DATA_RPC_ERROR.unavailable,
  DATA_RPC_ERROR.notOpen,
];

type OpenAttempt = { readonly store: SettingsStore } | { readonly failure: string; readonly retryable: boolean };

async function openDataSettings(data: SettingsDataAccess): Promise<OpenAttempt> {
  try {
    return { store: await SettingsStore.open(new DataSettingsBackend(data), { repair: false }) };
  } catch (error) {
    return {
      failure: `settings could not be opened from ${SYSTEM_CONFIG_ENTITY}: ${errorText(error)}`,
      retryable: error instanceof RpcError && RETRYABLE_OPEN_CODES.includes(error.code),
    };
  }
}

/**
 * AppSettings 구현. memory 모드:
 *   · set · delete 는 된다(앱은 쓸 수 있어야 한다) — 키마다 처음 한 번 warn 로그(앱을 끄면 사라진다)
 *   · 되살아날 수 있는 까닭이면 자료층이 running 이 될 때 system_config 로 다시 열고, memory 에서 바꾼 키를 그대로 옮겨 쓴 뒤 data 로 바꾼다
 *     (바꾼 뒤 memory 저장소에 늦게 끝난 쓰기도 옮긴다 — 붙잡아 둔 옛 store 로 부른 쓰기가 사라지지 않게)
 */
class AppSettingsHandle implements AppSettings {
  private current: SettingsStore;
  private sourceValue: 'data' | 'memory';
  private failureValue: string | null;
  private readonly memory: SettingsStore | null;
  /** memory 에서 바뀐 키(옮기기 전) */
  private readonly touched = new Set<string>();
  private readonly warned = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly storeListeners = new Set<(store: SettingsStore, changedKeys: readonly string[]) => void>();
  private watch: Disposable | null = null;
  private attempting = false;
  private closed = false;

  constructor(
    store: SettingsStore,
    source: 'data' | 'memory',
    failure: string | null,
    private readonly log: AppLog,
  ) {
    this.current = store;
    this.sourceValue = source;
    this.failureValue = failure;
    this.memory = source === 'memory' ? store : null;
    this.memory?.onChange((event) => this.onMemoryChange(event.key));
  }

  get store(): SettingsStore {
    return this.current;
  }

  get source(): 'data' | 'memory' {
    return this.sourceValue;
  }

  get persistent(): boolean {
    return this.sourceValue === 'data';
  }

  get failure(): string | null {
    return this.failureValue;
  }

  async whenIdle(): Promise<void> {
    do {
      await Promise.all([this.current.whenIdle(), this.memory?.whenIdle(), ...this.pending]);
    } while (this.pending.size > 0);
  }

  onStoreChange(listener: (store: SettingsStore, changedKeys: readonly string[]) => void): Disposable {
    this.storeListeners.add(listener);
    return { dispose: () => void this.storeListeners.delete(listener) };
  }

  close(): void {
    this.closed = true;
    this.watch?.dispose();
    this.watch = null;
  }

  /** memory 로 열었을 때만 — 자료층이 running 이 되면 다시 연다 · 끝 상태(failed · stopping · stopped)면 듣기를 멈춘다 */
  retryWhenRunning(data: SettingsDataAccess & Pick<DataService, 'state'>, watchState: DataStateWatch): void {
    const onState = (state: DataServiceState): void => {
      if (this.closed || this.sourceValue === 'data') return;
      if (state === 'running') {
        this.attempt(data);
      } else if (TERMINAL_DATA_STATES.includes(state)) {
        this.log('info', `settings stay in memory — data service is ${state} (restart the app to retry)`);
        this.close();
      }
    };
    this.watch = watchState(onState);
    // 듣기 전에 이미 running 이 됐을 수 있다(memory 를 여는 사이) — 한 번 본다
    if (data.state === 'running') this.attempt(data);
  }

  private attempt(data: SettingsDataAccess): void {
    if (this.attempting) return;
    this.attempting = true;
    this.track(
      (async () => {
        try {
          const opened = await openDataSettings(data);
          if (this.closed) return;
          if ('store' in opened) {
            await this.switchTo(opened.store);
            return;
          }
          this.failureValue = opened.failure;
          this.log('error', `${opened.failure} — settings stay in memory${opened.retryable ? ' (will retry when the data service is running again)' : ''}`);
          if (!opened.retryable) this.close();
        } finally {
          this.attempting = false;
        }
      })(),
    );
  }

  private async switchTo(dataStore: SettingsStore): Promise<void> {
    const memory = this.memory;
    if (memory === null) return;
    let copied = 0;
    // memory 에서 바꾼 키를 옮긴다 — 옮기는 사이 또 바뀐 키가 없을 때까지(마지막 확인과 바꾸기 사이에 await 이 없다)
    for (;;) {
      await memory.whenIdle();
      const keys = [...this.touched];
      this.touched.clear();
      if (keys.length === 0) break;
      for (const key of keys) {
        if (await copySetting(memory, dataStore, key, this.log)) copied += 1;
      }
    }
    if (this.closed) {
      this.log('warn', `settings: system_config came back while quitting — ${copied} change(s) copied, staying in memory`);
      return;
    }
    // memory 에 없던 키(system_config 에 원래 있던 값)는 읽히는 값이 바뀐다 → 알린다
    const changedKeys = dataStore.keys().filter((key) => !memory.has(key));
    this.current = dataStore;
    this.sourceValue = 'data';
    this.failureValue = null;
    this.close();
    this.log('info', `settings moved to ${SYSTEM_CONFIG_ENTITY} (${dataStore.keys().length} key(s) · ${copied} change(s) made in memory copied)`);
    for (const listener of [...this.storeListeners]) {
      try {
        listener(dataStore, changedKeys);
      } catch (error) {
        this.log('warn', 'settings store change listener failed', error);
      }
    }
  }

  private onMemoryChange(key: string): void {
    if (this.sourceValue === 'data') {
      // 바꾼 뒤 늦게 끝난 memory 쓰기 → system_config 로 옮긴다
      const memory = this.memory;
      if (memory !== null) this.track(copySetting(memory, this.current, key, this.log).then(() => undefined));
      return;
    }
    this.touched.add(key);
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log('warn', `setting "${key}" was changed in memory only — it is lost on quit unless ${SYSTEM_CONFIG_ENTITY} comes back (${this.failureValue ?? 'unknown'})`);
  }

  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => this.log('error', 'settings: background work failed', error))
      .finally(() => void this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}

/** from 의 key 를 to 에 그대로(있으면 set · 없으면 delete). 실패는 warn 로그 뒤 false */
async function copySetting(from: SettingsStore, to: SettingsStore, key: string, log: AppLog): Promise<boolean> {
  try {
    if (from.has(key)) await to.set(key, from.get(key, (raw) => raw));
    else await to.delete(key);
    return true;
  } catch (error) {
    log('warn', `setting "${key}" could not be copied from memory to ${SYSTEM_CONFIG_ENTITY}: ${errorText(error)}`);
    return false;
  }
}

/**
 * 자료층 첫 띄우기를 기다린 뒤 SettingsStore 를 연다. 거부하지 않는다 — 실패하면 메모리로 연다(머리 주석 ②).
 * started: start-data-service.ts 의 StartedDataService.started(running 이면 true).
 * 【AI 임시 결정】(검수 10 🟡1) 메모리여도 set · delete 는 된다 · persistent false 와 failure 로 알린다 · 키마다 처음 한 번 warn.
 *   다시 열기: 까닭이 되살아날 수 있을 때만(자료층이 restarting · open 이 timeout · processExited · unavailable · notOpen 로 실패) —
 *   failed · stopping · stopped 는 앱을 다시 켜기 전에는 running 이 안 되고(data-service.ts start 는 idle 에서만) · 깨진 행은 다시 열어도 같다.
 */
export async function openAppSettings(
  data: SettingsDataAccess & Pick<DataService, 'state'>,
  started: Promise<boolean>,
  log: AppLog = consoleLog,
  options: OpenAppSettingsOptions = {},
): Promise<AppSettings> {
  let failure: string;
  let retryable: boolean;
  const ok = await started.catch(() => false);
  if (ok && data.state === 'running') {
    const opened = await openDataSettings(data);
    if ('store' in opened) {
      log('info', `settings opened from ${SYSTEM_CONFIG_ENTITY} (${opened.store.keys().length} key(s))`);
      return new AppSettingsHandle(opened.store, 'data', null, log);
    }
    failure = opened.failure;
    retryable = opened.retryable;
    log('error', `${failure} — using in-memory settings (changes are lost on quit)`);
  } else {
    failure = `data service is ${data.state}`;
    retryable = !TERMINAL_DATA_STATES.includes(data.state);
    log('warn', `${failure} — using in-memory settings (changes are lost on quit)`);
  }
  const handle = new AppSettingsHandle(await SettingsStore.open(new InMemorySettingsBackend()), 'memory', failure, log);
  if (retryable && options.watchState) handle.retryWhenRunning(data, options.watchState);
  return handle;
}

/** 'settings.changed' 짐 — 키만(값은 플러그인이 host:settings.get 으로 읽는다 · 선언한 자기 키만 읽히도록) */
export interface SettingsChangedPayload {
  readonly key: string;
  /** 플러그인 설정 키면 그 플러그인 이름과 설정 키(풀 수 있을 때만) */
  readonly plugin?: string;
  readonly setting?: string;
}

/**
 * 【AI 임시 결정】 값(oldValue · newValue)은 싣지 않는다 — contributes.subscribers 로 이 이벤트를 받는 플러그인은 누구나 받으므로,
 * 값을 실으면 남의 설정 · 앱 설정 값이 host:settings.get 의 선언 검사를 건너뛰어 샌다.
 */
export function settingsChangePayload(event: SettingsChangeEvent): SettingsChangedPayload {
  const parsed = parsePluginSettingsKey(event.key);
  return parsed ? { key: event.key, plugin: parsed.plugin, setting: parsed.setting } : { key: event.key };
}

/** SettingsStore.onChange → EventBus. 핸들러를 기다리지 않는다(set 이 플러그인 쪽 일에 묶이지 않게 · EventBus 는 실패를 스스로 알린다) */
export function bridgeSettingsToBus(store: SettingsStore, bus: EventBus): Disposable {
  return store.onChange((event) => {
    void bus.emit(SETTINGS_CHANGED_EVENT, settingsChangePayload(event));
  });
}

/**
 * AppSettings → EventBus. store 가 memory → data 로 바뀌면 새 store 로 다시 잇고(옛 store 는 끊는다 — memory 의 늦은 쓰기는 data 로 옮겨져 거기서 알린다),
 * 바뀌면서 읽히는 값이 달라진 키도 알린다(값은 싣지 않는다).
 */
export function bridgeAppSettingsToBus(settings: AppSettings, bus: EventBus): Disposable {
  let current = bridgeSettingsToBus(settings.store, bus);
  const sub = settings.onStoreChange((store, changedKeys) => {
    current.dispose();
    current = bridgeSettingsToBus(store, bus);
    for (const key of changedKeys) void bus.emit(SETTINGS_CHANGED_EVENT, settingsChangePayload({ key, oldValue: null, newValue: null }));
  });
  return {
    dispose: () => {
      sub.dispose();
      current.dispose();
    },
  };
}

// ---------------------------------------------------------------- 플러그인 설정 키

/** 플러그인 설정 키의 첫 마디 */
export const PLUGIN_SETTINGS_DOMAIN = 'plugin';

const SAFE_CHAR = /^[A-Za-z0-9]$/;
const ESCAPED_SEGMENT = /^(?:[A-Za-z0-9]|_[0-9a-f]{2})+$/;

/** 영숫자 밖 ASCII 글자 → `_` + 소문자 hex 두 자리. 비ASCII · 빈 글이면 예외 */
export function encodeSettingsSegment(raw: string): string {
  if (raw.length === 0) throw new Error('settings segment must not be empty');
  let out = '';
  for (const ch of raw) {
    if (SAFE_CHAR.test(ch)) {
      out += ch;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f) throw new Error(`settings segment must be ASCII: ${JSON.stringify(raw)}`);
    out += `_${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** encodeSettingsSegment 를 거꾸로. 꼴이 아니면 null */
export function decodeSettingsSegment(encoded: string): string | null {
  if (!ESCAPED_SEGMENT.test(encoded)) return null;
  return encoded.replace(/_([0-9a-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * 플러그인 설정의 SettingsStore 키. 저장할 수 없는 설정이면 null:
 * 키가 SettingsStore 규칙(길이 255 · 마디 꼴)을 못 지키거나 · 플러그인 이름 · 설정 키가 비밀값처럼 보일 때
 * (`api-key` 는 바꾼 뒤 `api_2dkey` 라 SettingsStore 검사에 안 걸리므로 바꾸기 전 이름으로 본다).
 * 검수 10 🟢9 — 바꾼 키도 본다(`a:pikey` → `a_3apikey` 는 바꾼 뒤에만 `apikey` 가 든다): SettingsStore.set 은 바꾼 키로 거부하므로
 *   여기서도 null 로 쳐야 읽기(선언한 default) · 쓰기(저장 안 함)가 같다.
 */
export function pluginSettingsKey(pluginName: string, key: string): string | null {
  if (looksLikeSecretName(pluginName) || looksLikeSecretName(key)) return null;
  try {
    const storageKey = `${PLUGIN_SETTINGS_DOMAIN}.${encodeSettingsSegment(pluginName)}.${encodeSettingsSegment(key)}`;
    assertSettingsKey(storageKey);
    if (looksLikeSecretKey(storageKey)) return null;
    return storageKey;
  } catch {
    return null;
  }
}

/** pluginSettingsKey 를 거꾸로(플러그인 설정 키가 아니면 null) */
export function parsePluginSettingsKey(storageKey: string): { plugin: string; setting: string } | null {
  const parts = storageKey.split('.');
  if (parts.length !== 3 || parts[0] !== PLUGIN_SETTINGS_DOMAIN) return null;
  const plugin = decodeSettingsSegment(parts[1] ?? '');
  const setting = decodeSettingsSegment(parts[2] ?? '');
  return plugin === null || setting === null ? null : { plugin, setting };
}

/** host:settings.get 이 읽는 곳 — 설정이 열릴 때까지 기다린다 · 없음 · 저장 못 하는 키 · 깨진 행은 undefined(선언한 default 로) */
export function createPluginSettingsReader(settings: Promise<Pick<SettingsStore, 'get'>>, log: AppLog = consoleLog): PluginSettingsReader {
  return {
    async get(pluginName: string, key: string): Promise<unknown> {
      const storageKey = pluginSettingsKey(pluginName, key);
      if (storageKey === null) return undefined;
      const store = await settings;
      try {
        const value = store.get(storageKey, (raw) => raw);
        return value === null ? undefined : value;
      } catch (error) {
        log('warn', `plugin "${pluginName}" setting "${key}" is unreadable — using its default: ${errorText(error)}`);
        return undefined;
      }
    },
  };
}

// ---------------------------------------------------------------- 플러그인 자료

/** 【AI 임시 결정】 플러그인이 읽지도 쓰지도 못하는 엔티티(이름을 소문자 · `_` 뺀 꼴로 견준다) */
export const PLUGIN_BLOCKED_ENTITIES: readonly string[] = Object.freeze([SYSTEM_CONFIG_ENTITY]);

function compactEntityName(name: string): string {
  return name.toLowerCase().replace(/_/g, '');
}

const BLOCKED_COMPACT = PLUGIN_BLOCKED_ENTITIES.map(compactEntityName);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidParams(message: string): RpcError {
  return new RpcError(RPC_ERROR.invalidParams, message);
}

/**
 * PluginDataAccess → DataService(읽기는 늘 scope 'api' · 승인 엔티티 쓰기는 자료 프로세스가 거부).
 * ⚠ 권한(매니페스트 entity:<e>:read|crud) 검사는 «부르는 쪽 plugin-host-api.ts 에만» 기댄다 — 이 어댑터는 얇게 두고
 *   criteria 안(associations · 점 경로 필터)을 다시 보지 않는다. 루트 엔티티만 보던 구멍(검수 8)은 plugin-host-api.ts 쪽에서 고친다.
 *   여기서 하는 것은 꼴 검사(criteria · rows 가 보통 객체)와 PLUGIN_BLOCKED_ENTITIES(루트 이름)뿐이다.
 */
export function createPluginDataAccess(data: Pick<DataService, 'search' | 'get' | 'upsert' | 'delete'>): PluginDataAccess {
  const guard = (entity: string): void => {
    if (BLOCKED_COMPACT.includes(compactEntityName(entity))) {
      throw new RpcError(RPC_ERROR.permissionDenied, `permission denied: plugins cannot access "${entity}" (use host:settings.get)`);
    }
  };
  return {
    search(entity, criteria) {
      guard(entity);
      if (!isPlainRecord(criteria)) throw invalidParams('params.criteria must be a Criteria JSON object (criteria.parse())');
      return data.search(entity, criteria as CriteriaRequestParams);
    },
    get(entity, id) {
      guard(entity);
      return data.get(entity, id);
    },
    upsert(entity, rows) {
      guard(entity);
      if (!rows.every(isPlainRecord)) throw invalidParams('params.rows must be an array of plain objects');
      return data.upsert(entity, rows as readonly Record<string, unknown>[]);
    },
    delete(entity, ids) {
      guard(entity);
      return data.delete(entity, ids);
    },
  };
}

// ---------------------------------------------------------------- 묶기(electron)

/** 【AI 임시 결정】 내릴 때 플러그인 쪽(화면 · 레지스트리)을 기다리는 상한 — 넘으면 자료층 내리기로 넘어간다 */
export const PLUGIN_DISPOSE_TIMEOUT_MS = 10_000;
/** 【AI 임시 결정】(검수 10 🟡3) 내릴 때 돌고 있는 startPlugins(scan · startup)를 기다리는 상한 — 넘으면 그대로 dispose 한다 */
export const PLUGIN_START_WAIT_MS = 5_000;
/** 【AI 임시 결정】(검수 10 🟡2) 내릴 때 안 끝난 설정 쓰기를 기다리는 상한 — 넘으면 자료층 내리기로 넘어간다(그 쓰기는 사라질 수 있다 · 로그) */
export const SETTINGS_IDLE_TIMEOUT_MS = 3_000;

function waitAtMost(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms);
    timer.unref?.();
    p.then(
      () => {
        clearTimeout(timer);
        resolveWait(true);
      },
      () => {
        clearTimeout(timer);
        resolveWait(true);
      },
    );
  });
}

// ---------------------------------------------------------------- 플러그인 띄우기 · 내리기(electron 없이 시험)

/** createPluginLifecycle 이 부르는 레지스트리 메서드(PluginRegistry 가 그대로 맞는다 · 시험은 가짜) */
export interface PluginLifecycleRegistry {
  scan(): Promise<readonly unknown[]>;
  startup(): Promise<readonly unknown[]>;
  dispose(): Promise<void>;
}

export interface PluginLifecycleOptions<V extends { dispose(): void }> {
  readonly registry: PluginLifecycleRegistry;
  /** scan 전 한 번(플러그인 폴더 만들기) */
  readonly prepare: () => Promise<void>;
  /** startup 뒤 한 번(PluginViewHost) */
  readonly createViews: () => V;
  readonly log: AppLog;
  readonly startWaitMs?: number;
  readonly disposeTimeoutMs?: number;
}

export interface PluginLifecycle<V> {
  /** 한 번만 돈다(두 번째는 같은 Promise) · 거부하지 않는다 · dispose 가 먼저 시작됐으면 아무것도 안 한다 */
  start(): Promise<void>;
  /** 한 번만 돈다 · 거부하지 않는다 */
  dispose(): Promise<void>;
  views(): V | null;
}

/**
 * startPlugins · 플러그인 내리기. 검수 10 🟡3(scan → dispose → startup 이면 dispose 뒤에 런타임이 뜬다) — 레지스트리를 고치지 않고 앱 쪽에서 막는다:
 *   ①start 는 scan 앞 · scan 과 startup 사이 · startup 뒤에 disposing 을 본다
 *   ②dispose 는 disposing 을 먼저 세우고, 돌고 있는 start 를 startWaitMs 까지 기다린 뒤 화면 → 레지스트리를 내린다
 *   ⚠ 남은 길: startup 이 startWaitMs 를 넘기면 dispose 가 startup 과 겹친다 · 레지스트리의 install · activate 를 dispose 뒤에 부르는 길(지금 부르는 곳 0)은
 *     레지스트리 쪽 disposed 표시가 있어야 막힌다(plugin-registry.ts — 이 파일 밖).
 */
export function createPluginLifecycle<V extends { dispose(): void }>(options: PluginLifecycleOptions<V>): PluginLifecycle<V> {
  const { registry, log } = options;
  const startWaitMs = options.startWaitMs ?? PLUGIN_START_WAIT_MS;
  const disposeTimeoutMs = options.disposeTimeoutMs ?? PLUGIN_DISPOSE_TIMEOUT_MS;
  let views: V | null = null;
  let disposing = false;
  let started: Promise<void> | null = null;
  let disposed: Promise<void> | null = null;

  const start = (): Promise<void> => {
    started ??= (async () => {
      if (disposing) return;
      try {
        await options.prepare();
        const found = await registry.scan();
        if (disposing) {
          log('info', `plugins scanned: ${found.length} · startup skipped (app is quitting)`);
          return;
        }
        const running = await registry.startup();
        log('info', `plugins scanned: ${found.length} · started: ${running.length}`);
      } catch (error) {
        log('error', 'plugin scan/startup failed — app continues without plugins', error);
      }
      if (disposing) return;
      try {
        views = options.createViews();
      } catch (error) {
        log('error', 'plugin view host failed to start — plugin screens are unavailable', error);
      }
    })();
    return started;
  };

  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      disposing = true;
      if (started !== null && !(await waitAtMost(started, startWaitMs))) {
        log('warn', `plugin startup did not finish in ${startWaitMs}ms — disposing plugins anyway`);
      }
      try {
        views?.dispose();
      } catch (error) {
        log('warn', 'plugin view host dispose failed', error);
      }
      const done = await waitAtMost(
        registry.dispose().catch((error: unknown) => log('warn', 'plugin registry dispose failed', error)),
        disposeTimeoutMs,
      );
      if (!done) log('warn', `plugin registry dispose did not finish in ${disposeTimeoutMs}ms — stopping data service anyway`);
    })();
    return disposed;
  };

  return { start, dispose, views: () => views };
}

// ---------------------------------------------------------------- 묶기(electron)

export interface AppServices {
  readonly data: DataService;
  /** 늘 풀린다(실패하면 source 'memory') */
  readonly settings: Promise<AppSettings>;
  readonly bus: EventBus;
  readonly plugins: PluginRegistry;
  /** startPlugins 가 만든 화면 호스트(그 전 · 실패면 null) */
  pluginViews(): PluginViewHost | null;
  /** 창을 띄운 뒤 한 번 — scan · startup · 화면 호스트. 거부하지 않는다(실패는 로그) */
  startPlugins(): Promise<void>;
}

let services: AppServices | null = null;

export function getAppServices(): AppServices | null {
  return services;
}

/** app ready 뒤 한 번. 두 번 부르면 처음 것을 돌려준다 */
export function startAppServices(log: AppLog = consoleLog): AppServices {
  if (services) return services;

  const bus = new EventBus({ onError: (error, event, owner) => log('warn', `event handler failed (${event}${owner ? ` · ${owner}` : ''})`, error) });
  // 아래에서 만든다 — beforeStop 이 그 전에 불릴 수는 없다(will-quit 은 이 함수가 끝난 뒤의 일)
  let lifecycleRef: PluginLifecycle<PluginViewHost> | null = null;
  let openedSettings: AppSettings | null = null;
  const stateListeners = new Set<(state: DataServiceState) => void>();

  // will-quit: 플러그인(화면 → 레지스트리) → 설정 쓰기 끝(상한) → (start-data-service 가) 자료층 stop
  const beforeStop = async (): Promise<void> => {
    await lifecycleRef?.dispose();
    const s = openedSettings;
    // 설정이 아직 안 열렸으면(자료층이 띄우는 중) 기다릴 쓰기가 없다
    if (s === null) return;
    s.close();
    if (!(await waitAtMost(s.whenIdle(), SETTINGS_IDLE_TIMEOUT_MS))) {
      log('warn', `settings writes did not finish in ${SETTINGS_IDLE_TIMEOUT_MS}ms — stopping data service anyway (pending writes may be lost)`);
    }
  };

  const { service: data, started } = startDataService({
    beforeStop,
    onStateChange: (state) => {
      for (const listener of [...stateListeners]) listener(state);
    },
  });
  const watchState: DataStateWatch = (listener) => {
    stateListeners.add(listener);
    return { dispose: () => void stateListeners.delete(listener) };
  };

  const settings = openAppSettings(data, started, log, { watchState });
  void settings.then((s) => {
    openedSettings = s;
    bridgeAppSettingsToBus(s, bus);
  });

  const pluginLog = (plugin: string, level: string, message: string): void => {
    const lvl: AppLogLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    log(lvl, `[plugin:${plugin}] ${message}`);
  };
  const onPermissionDenied = (info: PermissionDeniedInfo): void => {
    log('warn', `[plugin:${info.plugin}] permission denied · ${info.method}${info.entity ? ` · ${info.entity}` : ''} · ${info.reason}`);
  };
  const pluginData = createPluginDataAccess(data);
  // store 는 memory → data 로 바뀔 수 있다 — 붙잡지 않고 부를 때마다 settings.store 를 읽는다
  const pluginSettings = createPluginSettingsReader(
    settings.then((s) => ({ get: <T>(key: string, parse: (raw: unknown) => T): T | null => s.store.get(key, parse) })),
    log,
  );

  const closeViews = (name: string): void => {
    lifecycleRef?.views()?.closeViews(name);
  };
  const pluginRoot = join(app.getPath('userData'), 'plugins');
  const registry = new PluginRegistry({
    root: pluginRoot,
    appVersion: app.getVersion(),
    runtimeFactory: createProcessRuntimeFactory({
      launcher: new ElectronProcessLauncher(),
      data: pluginData,
      settings: pluginSettings,
      bus,
      onLog: pluginLog,
      onPermissionDenied,
    }),
    bus,
    // 플러그인 화면은 내릴 때 · 판 올릴 때 · 지울 때 닫는다(plugin-view-host.ts closeViews 주석)
    hooks: {
      deactivate: ({ manifest }) => closeViews(manifest.name),
      update: ({ manifest }) => closeViews(manifest.name),
      uninstall: ({ manifest }) => closeViews(manifest.name),
    },
    onError: (name, message) => log('error', `[plugin:${name}] ${message}`),
  });

  const lifecycle = createPluginLifecycle<PluginViewHost>({
    registry,
    // 【AI 임시 결정】 폴더가 없으면 만든다(사람이 플러그인을 넣을 자리 · scan 은 없어도 빈 목록으로 돈다)
    prepare: async () => {
      await mkdir(pluginRoot, { recursive: true });
    },
    createViews: () =>
      new PluginViewHost({
        preloadPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'preload', 'plugin-ui-preload.cjs'),
        resolvePlugin: (name) => {
          const d = registry.describe(name);
          return d?.state === 'active' && d.manifest ? { manifest: d.manifest, pluginDir: d.pluginDir } : null;
        },
        data: pluginData,
        settings: pluginSettings,
        devTools: !app.isPackaged,
        onLog: pluginLog,
        onPermissionDenied,
      }),
    log,
  });
  lifecycleRef = lifecycle;

  services = {
    data,
    settings,
    bus,
    plugins: registry,
    pluginViews: () => lifecycle.views(),
    startPlugins: lifecycle.start,
  };
  return services;
}
