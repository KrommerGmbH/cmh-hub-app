// R7-c — 앱 서비스 묶기: 자료층(DataService) · 설정(SettingsStore over system_config) · 플러그인(PluginRegistry · 프로세스 런타임 · 화면 호스트) · EventBus.
// main.ts 는 startAppServices() 한 번(app ready 뒤) · 창을 띄운 뒤 startPlugins() 한 번만 부른다. IPC 채널은 아직 없다(나중에 이 객체로 잇는다).
//
// 차례:
//   ①startDataService — 자료 프로세스를 띄운다(기다리지 않는다 · 창을 막지 않는다).
//   ②설정 — 자료층 첫 띄우기가 끝나면 SettingsStore.open(DataSettingsBackend, { repair: false }).
//     【AI 임시 결정】 자료층이 failed(또는 내리는 중 취소)거나 open 이 실패하면(깨진 행 · RPC 오류) 메모리 backend 로 열고 경고를 남긴다 —
//     그때 바꾼 설정은 앱을 끄면 사라진다. 어느 쪽인지는 AppSettings.source · failure 로 본다(설정 화면이 생기면 알린다).
//   ③플러그인 — startPlugins(): 창을 띄운 «뒤» userData/plugins 를 scan → startup → PluginViewHost. 실패는 로그만(앱은 산다).
//   ④설정 바뀜 → EventBus 'settings.changed'(【AI 임시 결정】 이름). 값은 싣지 않고 키만 싣는다(아래 settingsChangePayload).
// 내리기(will-quit · start-data-service.ts 의 beforeStop): 플러그인 화면 → 플러그인 레지스트리 → (그 뒤) 자료층.
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
import type { DataService } from './data/data-service.js';
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
  readonly store: SettingsStore;
  /** data = system_config(앱 SQLite) · memory = 앱을 끄면 사라진다 */
  readonly source: 'data' | 'memory';
  /** memory 로 연 까닭(data 면 null) */
  readonly failure: string | null;
}

/**
 * 자료층 첫 띄우기를 기다린 뒤 SettingsStore 를 연다. 거부하지 않는다 — 실패하면 메모리로 연다(머리 주석 ②).
 * started: start-data-service.ts 의 StartedDataService.started(running 이면 true).
 */
export async function openAppSettings(
  data: SettingsDataAccess & Pick<DataService, 'state'>,
  started: Promise<boolean>,
  log: AppLog = consoleLog,
): Promise<AppSettings> {
  let failure: string;
  const ok = await started.catch(() => false);
  if (ok && data.state === 'running') {
    try {
      const store = await SettingsStore.open(new DataSettingsBackend(data), { repair: false });
      log('info', `settings opened from ${SYSTEM_CONFIG_ENTITY} (${store.keys().length} key(s))`);
      return { store, source: 'data', failure: null };
    } catch (error) {
      failure = `settings could not be opened from ${SYSTEM_CONFIG_ENTITY}: ${errorText(error)}`;
      log('error', `${failure} — using in-memory settings (changes are lost on quit)`);
    }
  } else {
    failure = `data service is ${data.state}`;
    log('warn', `${failure} — using in-memory settings (changes are lost on quit)`);
  }
  return { store: await SettingsStore.open(new InMemorySettingsBackend()), source: 'memory', failure };
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
 */
export function pluginSettingsKey(pluginName: string, key: string): string | null {
  if (looksLikeSecretName(pluginName) || looksLikeSecretName(key)) return null;
  try {
    const storageKey = `${PLUGIN_SETTINGS_DOMAIN}.${encodeSettingsSegment(pluginName)}.${encodeSettingsSegment(key)}`;
    assertSettingsKey(storageKey);
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

/** app ready 뒤 한 번. 두 번 부르면 처음 것을 돌려준다 */
export function startAppServices(log: AppLog = consoleLog): AppServices {
  if (services) return services;

  const bus = new EventBus({ onError: (error, event, owner) => log('warn', `event handler failed (${event}${owner ? ` · ${owner}` : ''})`, error) });
  let pluginViews: PluginViewHost | null = null;
  let disposing = false;
  // registry 는 아래에서 만든다 — beforeStop 이 그 전에 불릴 수는 없다(will-quit 은 이 함수가 끝난 뒤의 일)
  let registryRef: PluginRegistry | null = null;

  const disposePlugins = async (): Promise<void> => {
    disposing = true;
    try {
      pluginViews?.dispose();
    } catch (error) {
      log('warn', 'plugin view host dispose failed', error);
    }
    const registry = registryRef;
    if (!registry) return;
    const done = await waitAtMost(
      registry.dispose().catch((error: unknown) => log('warn', 'plugin registry dispose failed', error)),
      PLUGIN_DISPOSE_TIMEOUT_MS,
    );
    if (!done) log('warn', `plugin registry dispose did not finish in ${PLUGIN_DISPOSE_TIMEOUT_MS}ms — stopping data service anyway`);
  };

  const { service: data, started } = startDataService({ beforeStop: disposePlugins });

  const settings = openAppSettings(data, started, log);
  void settings.then((s) => bridgeSettingsToBus(s.store, bus));

  const pluginLog = (plugin: string, level: string, message: string): void => {
    const lvl: AppLogLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    log(lvl, `[plugin:${plugin}] ${message}`);
  };
  const onPermissionDenied = (info: PermissionDeniedInfo): void => {
    log('warn', `[plugin:${info.plugin}] permission denied · ${info.method}${info.entity ? ` · ${info.entity}` : ''} · ${info.reason}`);
  };
  const pluginData = createPluginDataAccess(data);
  const pluginSettings = createPluginSettingsReader(settings.then((s) => s.store), log);

  const closeViews = (name: string): void => {
    pluginViews?.closeViews(name);
  };
  const registry = new PluginRegistry({
    root: join(app.getPath('userData'), 'plugins'),
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
  registryRef = registry;

  let pluginsStarted: Promise<void> | null = null;
  const startPlugins = (): Promise<void> => {
    pluginsStarted ??= (async () => {
      if (disposing) return;
      const root = join(app.getPath('userData'), 'plugins');
      try {
        // 【AI 임시 결정】 폴더가 없으면 만든다(사람이 플러그인을 넣을 자리 · scan 은 없어도 빈 목록으로 돈다)
        await mkdir(root, { recursive: true });
        const found = await registry.scan();
        const started = await registry.startup();
        log('info', `plugins scanned: ${found.length} · started: ${started.length}`);
      } catch (error) {
        log('error', 'plugin scan/startup failed — app continues without plugins', error);
      }
      if (disposing) return;
      try {
        pluginViews = new PluginViewHost({
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
        });
      } catch (error) {
        log('error', 'plugin view host failed to start — plugin screens are unavailable', error);
      }
    })();
    return pluginsStarted;
  };

  services = {
    data,
    settings,
    bus,
    plugins: registry,
    pluginViews: () => pluginViews,
    startPlugins,
  };
  return services;
}
