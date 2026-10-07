// R2-a — 플러그인 매니페스트(`plugin.json`) 읽기 · 검증. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 엄격하게: 틀린 값은 오류(플러그인을 띄우지 않음) · 모르는 키는 경고(앞으로 키가 늘어도 옛 앱이 죽지 않게 — VS Code `contributes` 와 같은 태도).
// 합의안 5(PLAN «opus 검수 반영»): 승인 엔티티(cmh_ai_approval) 쓰기 권한은 매니페스트에서부터 거부한다.
//   읽기(`entity:cmh_ai_approval:read`)는 받는다 — 화면에 승인 대기 목록을 보이는 플러그인은 있을 수 있다.
//   같은 이유로 이 엔티티를 새로 정의하거나(contributes.entities) 칸을 더하는 것(entityExtensions)도 거부한다.
// Shopware App manifest 의 `<permissions>`(read / create / update / delete · `<crud>`) 꼴을 줄여 read | crud 둘만 둔다.

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 엔티티 이름 — 서버 Shopware 엔티티와 같은 snake_case(예 cmh_ai_prompt) */
export const ENTITY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** 뷰 · 명령 · 서비스 · 이벤트 id — 점 · 콜론 · 하이픈 허용(예 hello.view · entity.written) */
export const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** 도구 이름 — MCP 도구 이름 꼴(예 mcp:cmh-shop-api-mcp:dal_search) */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:*-]{0,127}$/;
/** 호스트 — 소문자 도메인 · 맨 앞 `*.` 하나 허용(하위 도메인 전부) */
export const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
/** semver 간단 검사 — MAJOR.MINOR.PATCH(-pre)(+build) · 앞자리 0 금지 */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 플러그인이 쓰기 권한을 가질 수 없는 엔티티(합의안 5 · S3). 쓰기는 main 의 UI IPC 핸들러(사람 클릭)만. */
export const WRITE_PROTECTED_ENTITIES: readonly string[] = Object.freeze(['cmh_ai_approval']);

export const VIEW_LOCATIONS = ['sidebar', 'pane'] as const;
export type ViewLocation = (typeof VIEW_LOCATIONS)[number];
export const SETTING_TYPES = ['string', 'number', 'boolean'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
/** R8 스니펫 세 언어 — Shopware 어드민 snippet 과 같은 locale 이름 */
export const SNIPPET_LOCALES = ['ko-KR', 'en-GB', 'de-DE'] as const;
export type SnippetLocale = (typeof SNIPPET_LOCALES)[number];
export const ENTITY_ACCESS = ['read', 'crud'] as const;
export type EntityAccess = (typeof ENTITY_ACCESS)[number];

export type ActivationEvent =
  | { readonly kind: 'onStartup'; readonly raw: 'onStartup' }
  | { readonly kind: 'onView' | 'onCommand' | 'onEntity'; readonly target: string; readonly raw: string };

export type PluginPermission =
  | { readonly kind: 'entity'; readonly entity: string; readonly access: EntityAccess; readonly raw: string }
  | { readonly kind: 'host'; readonly host: string; readonly raw: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly raw: string };

export interface FieldDeclaration { readonly name: string; readonly type: string }
export interface EntityContribution { readonly name: string; readonly fields: readonly FieldDeclaration[] }
export interface EntityExtensionContribution { readonly entity: string; readonly fields: readonly FieldDeclaration[] }
export interface ServiceContribution { readonly id: string; readonly decorates?: string }
export interface SubscriberContribution { readonly event: string }
export interface ViewContribution { readonly id: string; readonly title: string; readonly where: ViewLocation }
export interface CommandContribution { readonly id: string; readonly title: string }
export interface MenuContribution { readonly command: string; readonly location: string }
export interface SettingContribution { readonly key: string; readonly type: SettingType; readonly title?: string; readonly default?: string | number | boolean }
export interface SnippetContribution { readonly locale: SnippetLocale; readonly path: string }

export interface PluginContributes {
  readonly entities: readonly EntityContribution[];
  readonly entityExtensions: readonly EntityExtensionContribution[];
  readonly services: readonly ServiceContribution[];
  readonly subscribers: readonly SubscriberContribution[];
  readonly views: readonly ViewContribution[];
  readonly commands: readonly CommandContribution[];
  readonly menus: readonly MenuContribution[];
  readonly settings: readonly SettingContribution[];
  readonly snippets: readonly SnippetContribution[];
}

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly minAppVersion: string;
  /** 플러그인 폴더 기준 상대경로 · 별도 프로세스에서 돈다 */
  readonly main: string;
  /** 플러그인 화면(다음 차례 · Shopware App 꼴 iframe) · 플러그인 폴더 기준 상대경로 */
  readonly ui?: string;
  readonly description?: string;
  readonly activationEvents: readonly ActivationEvent[];
  readonly contributes: PluginContributes;
  readonly permissions: readonly PluginPermission[];
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: PluginManifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] };

export class ManifestError extends Error {
  constructor(readonly errors: readonly string[], readonly warnings: readonly string[] = []) {
    super(`plugin.json invalid: ${errors.join('; ')}`);
    this.name = 'ManifestError';
  }
}

export interface ManifestParseOptions {
  /** 주면 minAppVersion > appVersion 일 때 오류 */
  readonly appVersion?: string;
}

const TOP_KEYS = new Set(['name', 'version', 'minAppVersion', 'main', 'ui', 'description', 'activationEvents', 'contributes', 'permissions']);
const CONTRIBUTES_KEYS = ['entities', 'entityExtensions', 'services', 'subscribers', 'views', 'commands', 'menus', 'settings', 'snippets'] as const;

// ───────────── 작은 도우미 ─────────────

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

class Collector {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  error(message: string): void { this.errors.push(message); }
  warn(message: string): void { this.warnings.push(message); }
  unknownKeys(obj: Obj, allowed: ReadonlySet<string> | readonly string[], where: string): void {
    const set = allowed instanceof Set ? allowed : new Set(allowed as readonly string[]);
    for (const key of Object.keys(obj)) {
      if (!set.has(key)) this.warn(`${where}: unknown key "${key}" ignored`);
    }
  }
}

function requireString(c: Collector, obj: Obj, key: string, where: string, pattern?: RegExp): string | null {
  const value = own(obj, key);
  if (typeof value !== 'string' || value.length === 0) {
    c.error(`${where}.${key}: required non-empty string`);
    return null;
  }
  if (pattern && !pattern.test(value)) {
    c.error(`${where}.${key}: "${value}" does not match ${pattern.source}`);
    return null;
  }
  return value;
}

// ───────────── 공개 도우미 ─────────────

export function isValidSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/** semver 비교(앞 셋 숫자 + pre-release 는 문자열 비교로 간단히). a<b 음수 · 같으면 0 · a>b 양수 */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_PATTERN.exec(a);
  const pb = SEMVER_PATTERN.exec(b);
  if (!pa || !pb) throw new Error(`not semver: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  const preA = pa[4];
  const preB = pb[4];
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1; // 1.0.0 > 1.0.0-beta
  if (preB === undefined) return -1;
  return preA < preB ? -1 : preA > preB ? 1 : 0;
}

/**
 * 플러그인 폴더 안을 가리키는 상대경로인가. 거부: 빈 값 · 절대경로(`/x` · `C:\x` · `\\srv`) · `..` 마디 · NUL · 역슬래시 섞인 탈출.
 * 경로는 `/` 로 쓰기를 권하지만 Windows 사용자가 `\` 로 써도 마디는 같이 나눠 본다.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false; // file:// · https:// 같은 URL
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment !== '..') && segments.some((segment) => segment !== '' && segment !== '.');
}

export function parseActivationEvent(raw: string): ActivationEvent | null {
  if (raw === 'onStartup') return { kind: 'onStartup', raw };
  const match = /^(onView|onCommand|onEntity):(.+)$/.exec(raw);
  if (!match) return null;
  const kind = match[1] as 'onView' | 'onCommand' | 'onEntity';
  const target = match[2] ?? '';
  const pattern = kind === 'onEntity' ? ENTITY_NAME_PATTERN : CONTRIBUTION_ID_PATTERN;
  if (!pattern.test(target)) return null;
  return { kind, target, raw };
}

export function parsePermission(raw: string): PluginPermission | null {
  const entity = /^entity:([^:]+):([^:]+)$/.exec(raw);
  if (entity) {
    const name = entity[1] ?? '';
    const access = entity[2] ?? '';
    if (!ENTITY_NAME_PATTERN.test(name) || !(ENTITY_ACCESS as readonly string[]).includes(access)) return null;
    return { kind: 'entity', entity: name, access: access as EntityAccess, raw };
  }
  const host = /^host:(.+)$/.exec(raw);
  if (host) {
    const name = host[1] ?? '';
    return HOST_PATTERN.test(name) ? { kind: 'host', host: name, raw } : null;
  }
  const tool = /^tool:(.+)$/.exec(raw);
  if (tool) {
    const name = tool[1] ?? '';
    return TOOL_NAME_PATTERN.test(name) ? { kind: 'tool', tool: name, raw } : null;
  }
  return null;
}

// ───────────── contributes 항목 읽기 ─────────────

function readArray(c: Collector, contributes: Obj, key: string): Obj[] {
  const value = own(contributes, key);
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    c.error(`contributes.${key}: must be an array`);
    return [];
  }
  const items: Obj[] = [];
  value.forEach((item, index) => {
    if (isObject(item)) items.push(item);
    else c.error(`contributes.${key}[${index}]: must be an object`);
  });
  return items;
}

function readFields(c: Collector, item: Obj, where: string): FieldDeclaration[] {
  const value = own(item, 'fields');
  if (!Array.isArray(value) || value.length === 0) {
    c.error(`${where}.fields: required non-empty array`);
    return [];
  }
  const fields: FieldDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((field, index) => {
    const at = `${where}.fields[${index}]`;
    if (!isObject(field)) {
      c.error(`${at}: must be an object`);
      return;
    }
    c.unknownKeys(field, ['name', 'type'], at);
    const name = requireString(c, field, 'name', at, ENTITY_NAME_PATTERN);
    const type = requireString(c, field, 'type', at, /^[a-z][a-z0-9_]{0,31}$/);
    if (name === null || type === null) return;
    if (seen.has(name)) c.error(`${at}.name: duplicate "${name}"`);
    seen.add(name);
    fields.push({ name, type });
  });
  return fields;
}

function uniqueIds(c: Collector, ids: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) c.error(`${where}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function readContributes(c: Collector, value: unknown): PluginContributes {
  const contributes: Obj = value === undefined ? {} : isObject(value) ? value : (c.error('contributes: must be an object'), {});
  c.unknownKeys(contributes, CONTRIBUTES_KEYS, 'contributes');

  const entities: EntityContribution[] = [];
  readArray(c, contributes, 'entities').forEach((item, index) => {
    const at = `contributes.entities[${index}]`;
    c.unknownKeys(item, ['name', 'fields'], at);
    const name = requireString(c, item, 'name', at, ENTITY_NAME_PATTERN);
    const fields = readFields(c, item, at);
    if (name === null) return;
    if (WRITE_PROTECTED_ENTITIES.includes(name)) {
      c.error(`${at}.name: "${name}" is a protected entity and cannot be (re)defined by a plugin`);
      return;
    }
    entities.push({ name, fields });
  });

  const entityExtensions: EntityExtensionContribution[] = [];
  readArray(c, contributes, 'entityExtensions').forEach((item, index) => {
    const at = `contributes.entityExtensions[${index}]`;
    c.unknownKeys(item, ['entity', 'fields'], at);
    const entity = requireString(c, item, 'entity', at, ENTITY_NAME_PATTERN);
    const fields = readFields(c, item, at);
    if (entity === null) return;
    if (WRITE_PROTECTED_ENTITIES.includes(entity)) {
      c.error(`${at}.entity: "${entity}" is a protected entity and cannot be extended by a plugin`);
      return;
    }
    entityExtensions.push({ entity, fields });
  });

  const services: ServiceContribution[] = [];
  readArray(c, contributes, 'services').forEach((item, index) => {
    const at = `contributes.services[${index}]`;
    c.unknownKeys(item, ['id', 'decorates'], at);
    const id = requireString(c, item, 'id', at, CONTRIBUTION_ID_PATTERN);
    if (id === null) return;
    if (own(item, 'decorates') === undefined) {
      services.push({ id });
      return;
    }
    const decorates = requireString(c, item, 'decorates', at, CONTRIBUTION_ID_PATTERN);
    if (decorates !== null) services.push({ id, decorates });
  });
  uniqueIds(c, services.map((s) => s.id), 'contributes.services');

  const subscribers: SubscriberContribution[] = [];
  readArray(c, contributes, 'subscribers').forEach((item, index) => {
    const at = `contributes.subscribers[${index}]`;
    c.unknownKeys(item, ['event'], at);
    const event = requireString(c, item, 'event', at, CONTRIBUTION_ID_PATTERN);
    if (event !== null) subscribers.push({ event });
  });

  const views: ViewContribution[] = [];
  readArray(c, contributes, 'views').forEach((item, index) => {
    const at = `contributes.views[${index}]`;
    c.unknownKeys(item, ['id', 'title', 'where'], at);
    const id = requireString(c, item, 'id', at, CONTRIBUTION_ID_PATTERN);
    const title = requireString(c, item, 'title', at);
    const where = requireString(c, item, 'where', at);
    if (where !== null && !(VIEW_LOCATIONS as readonly string[]).includes(where)) {
      c.error(`${at}.where: must be one of ${VIEW_LOCATIONS.join(', ')}`);
      return;
    }
    if (id !== null && title !== null && where !== null) views.push({ id, title, where: where as ViewLocation });
  });
  uniqueIds(c, views.map((v) => v.id), 'contributes.views');

  const commands: CommandContribution[] = [];
  readArray(c, contributes, 'commands').forEach((item, index) => {
    const at = `contributes.commands[${index}]`;
    c.unknownKeys(item, ['id', 'title'], at);
    const id = requireString(c, item, 'id', at, CONTRIBUTION_ID_PATTERN);
    const title = requireString(c, item, 'title', at);
    if (id !== null && title !== null) commands.push({ id, title });
  });
  uniqueIds(c, commands.map((cmd) => cmd.id), 'contributes.commands');

  const commandIds = new Set(commands.map((cmd) => cmd.id));
  const menus: MenuContribution[] = [];
  readArray(c, contributes, 'menus').forEach((item, index) => {
    const at = `contributes.menus[${index}]`;
    c.unknownKeys(item, ['command', 'location'], at);
    const command = requireString(c, item, 'command', at, CONTRIBUTION_ID_PATTERN);
    const location = requireString(c, item, 'location', at, CONTRIBUTION_ID_PATTERN);
    if (command === null || location === null) return;
    if (!commandIds.has(command)) {
      c.error(`${at}.command: "${command}" is not declared in contributes.commands`);
      return;
    }
    menus.push({ command, location });
  });

  const settings: SettingContribution[] = [];
  readArray(c, contributes, 'settings').forEach((item, index) => {
    const at = `contributes.settings[${index}]`;
    c.unknownKeys(item, ['key', 'type', 'title', 'default'], at);
    const key = requireString(c, item, 'key', at, CONTRIBUTION_ID_PATTERN);
    const type = requireString(c, item, 'type', at);
    if (key === null || type === null) return;
    if (!(SETTING_TYPES as readonly string[]).includes(type)) {
      c.error(`${at}.type: must be one of ${SETTING_TYPES.join(', ')}`);
      return;
    }
    const titleValue = own(item, 'title');
    if (titleValue !== undefined && typeof titleValue !== 'string') c.error(`${at}.title: must be a string`);
    const defaultValue = own(item, 'default');
    if (defaultValue !== undefined && typeof defaultValue !== type) {
      c.error(`${at}.default: must be a ${type}`);
      return;
    }
    settings.push({
      key,
      type: type as SettingType,
      ...(typeof titleValue === 'string' ? { title: titleValue } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue as string | number | boolean } : {}),
    });
  });
  uniqueIds(c, settings.map((s) => s.key), 'contributes.settings');

  const snippets: SnippetContribution[] = [];
  readArray(c, contributes, 'snippets').forEach((item, index) => {
    const at = `contributes.snippets[${index}]`;
    c.unknownKeys(item, ['locale', 'path'], at);
    const locale = requireString(c, item, 'locale', at);
    const path = requireString(c, item, 'path', at);
    if (locale === null || path === null) return;
    if (!(SNIPPET_LOCALES as readonly string[]).includes(locale)) {
      c.error(`${at}.locale: must be one of ${SNIPPET_LOCALES.join(', ')}`);
      return;
    }
    if (!isSafeRelativePath(path)) {
      c.error(`${at}.path: must be a relative path inside the plugin folder`);
      return;
    }
    snippets.push({ locale: locale as SnippetLocale, path });
  });

  return { entities, entityExtensions, services, subscribers, views, commands, menus, settings, snippets };
}

// ───────────── 본체 ─────────────

/** 이미 JSON.parse 된 값을 검증한다. 예외를 던지지 않고 결과로 돌려준다(자료 문제 = 결과). */
export function parseManifest(input: unknown, options: ManifestParseOptions = {}): ManifestParseResult {
  const c = new Collector();
  if (!isObject(input)) {
    return { ok: false, errors: ['plugin.json: top level must be an object'], warnings: [] };
  }
  c.unknownKeys(input, TOP_KEYS, 'plugin.json');

  const name = requireString(c, input, 'name', 'plugin.json', PLUGIN_NAME_PATTERN);
  const version = requireString(c, input, 'version', 'plugin.json', SEMVER_PATTERN);
  const minAppVersion = requireString(c, input, 'minAppVersion', 'plugin.json', SEMVER_PATTERN);
  if (minAppVersion !== null && options.appVersion !== undefined && isValidSemver(options.appVersion)
    && compareSemver(minAppVersion, options.appVersion) > 0) {
    c.error(`plugin.json.minAppVersion: requires app ${minAppVersion} but this app is ${options.appVersion}`);
  }

  const main = requireString(c, input, 'main', 'plugin.json');
  if (main !== null) {
    if (!isSafeRelativePath(main)) c.error('plugin.json.main: must be a relative path inside the plugin folder');
    else if (!/\.(mjs|cjs|js)$/.test(main)) c.error('plugin.json.main: must end with .mjs, .cjs or .js');
  }

  let ui: string | undefined;
  if (own(input, 'ui') !== undefined) {
    const value = requireString(c, input, 'ui', 'plugin.json');
    if (value !== null) {
      if (isSafeRelativePath(value)) ui = value;
      else c.error('plugin.json.ui: must be a relative path inside the plugin folder');
    }
  }

  let description: string | undefined;
  const descriptionValue = own(input, 'description');
  if (descriptionValue !== undefined) {
    if (typeof descriptionValue === 'string') description = descriptionValue;
    else c.error('plugin.json.description: must be a string');
  }

  const contributes = readContributes(c, own(input, 'contributes'));

  const activationEvents: ActivationEvent[] = [];
  const eventsValue = own(input, 'activationEvents');
  if (!Array.isArray(eventsValue)) {
    c.error('plugin.json.activationEvents: required array (use ["onStartup"] to start with the app)');
  } else {
    const seen = new Set<string>();
    eventsValue.forEach((raw, index) => {
      const event = typeof raw === 'string' ? parseActivationEvent(raw) : null;
      if (!event) {
        c.error(`plugin.json.activationEvents[${index}]: unknown activation event ${JSON.stringify(raw)} (onStartup | onView:<id> | onCommand:<id> | onEntity:<name>)`);
        return;
      }
      if (seen.has(event.raw)) return;
      seen.add(event.raw);
      activationEvents.push(event);
      // VS Code 처럼 선언 안 된 뷰·명령을 가리키면 경고만(다른 플러그인의 뷰일 수도 있다)
      if (event.kind === 'onView' && !contributes.views.some((v) => v.id === event.target)) {
        c.warn(`plugin.json.activationEvents[${index}]: view "${event.target}" is not declared in contributes.views`);
      }
      if (event.kind === 'onCommand' && !contributes.commands.some((cmd) => cmd.id === event.target)) {
        c.warn(`plugin.json.activationEvents[${index}]: command "${event.target}" is not declared in contributes.commands`);
      }
    });
  }

  const permissions: PluginPermission[] = [];
  const permissionsValue = own(input, 'permissions');
  if (permissionsValue !== undefined && !Array.isArray(permissionsValue)) {
    c.error('plugin.json.permissions: must be an array');
  } else if (Array.isArray(permissionsValue)) {
    const seen = new Set<string>();
    permissionsValue.forEach((raw, index) => {
      const permission = typeof raw === 'string' ? parsePermission(raw) : null;
      if (!permission) {
        c.error(`plugin.json.permissions[${index}]: unknown permission ${JSON.stringify(raw)} (entity:<name>:read|crud | host:<domain> | tool:<name>)`);
        return;
      }
      if (permission.kind === 'entity' && permission.access !== 'read' && WRITE_PROTECTED_ENTITIES.includes(permission.entity)) {
        c.error(`plugin.json.permissions[${index}]: "${permission.raw}" denied — writes to ${permission.entity} are only allowed from the app UI (human click)`);
        return;
      }
      if (seen.has(permission.raw)) return;
      seen.add(permission.raw);
      permissions.push(permission);
    });
  }

  if (c.errors.length > 0 || name === null || version === null || minAppVersion === null || main === null) {
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }
  const manifest: PluginManifest = {
    name,
    version,
    minAppVersion,
    main,
    ...(ui !== undefined ? { ui } : {}),
    ...(description !== undefined ? { description } : {}),
    activationEvents,
    contributes,
    permissions,
  };
  return { ok: true, manifest, warnings: c.warnings };
}

/** 파일 글자(JSON)부터 읽는다. JSON 이 깨져도 결과로 돌려준다. */
export function parseManifestText(text: string, options: ManifestParseOptions = {}): ManifestParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`plugin.json: invalid JSON (${(error as Error).message})`], warnings: [] };
  }
  return parseManifest(value, options);
}
