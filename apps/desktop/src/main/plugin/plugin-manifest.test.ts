import { describe, expect, it } from 'vitest';
import { PLUGIN_MAX_TOOLS, compareSemver, isSafeRelativePath, parseManifest, parseManifestText, parsePermission } from './plugin-manifest.js';
import { checkEntityAccess, checkHostAccess, checkToolAccess } from './plugin-permissions.js';

const valid = () => ({
  name: 'plugin-hello',
  version: '1.2.3',
  minAppVersion: '0.1.0',
  main: 'main.mjs',
  ui: 'ui/index.html',
  activationEvents: ['onStartup', 'onView:hello.view', 'onCommand:hello.say', 'onEntity:cmh_ai_task'],
  contributes: {
    entities: [{ name: 'hello_note', fields: [{ name: 'title', type: 'string' }] }],
    entityExtensions: [{ entity: 'cmh_ai_task', fields: [{ name: 'hello_flag', type: 'bool' }] }],
    services: [{ id: 'hello.formatter' }, { id: 'hello.searchDecorator', decorates: 'core.search' }],
    subscribers: [{ event: 'app.ready' }],
    views: [{ id: 'hello.view', title: 'Hello', where: 'sidebar' }],
    commands: [{ id: 'hello.say', title: 'Say' }],
    menus: [{ command: 'hello.say', location: 'sidebar.context' }],
    settings: [{ key: 'hello.greeting', type: 'string', default: 'hi' }],
    snippets: [{ locale: 'ko-KR', path: 'snippet/ko-KR.json' }],
  },
  permissions: ['entity:cmh_ai_prompt:read', 'entity:hello_note:crud', 'entity:cmh_ai_approval:read', 'host:api.example.com', 'host:*.example.org', 'tool:mcp:cmh-shop-api-mcp:*'],
});

function errorsOf(input: unknown, appVersion?: string): readonly string[] {
  const result = parseManifest(input, appVersion === undefined ? {} : { appVersion });
  return result.ok ? [] : result.errors;
}

describe('parseManifest — 올바른 것', () => {
  it('모든 칸을 읽고 경고가 없다', () => {
    const result = parseManifest(valid(), { appVersion: '0.1.0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.manifest.ui).toBe('ui/index.html');
    expect(result.manifest.activationEvents.map((e) => e.kind)).toEqual(['onStartup', 'onView', 'onCommand', 'onEntity']);
    expect(result.manifest.contributes.services[1]).toEqual({ id: 'hello.searchDecorator', decorates: 'core.search' });
    expect(result.manifest.permissions.find((p) => p.kind === 'entity' && p.entity === 'hello_note')).toMatchObject({ access: 'crud' });
  });
  it('모르는 키는 경고만(최상위 · contributes · 항목)', () => {
    const input = { ...valid(), homepage: 'x', contributes: { ...valid().contributes, keybindings: [], views: [{ id: 'hello.view', title: 'Hello', where: 'pane', icon: 'x' }] } };
    const result = parseManifest(input);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      'plugin.json: unknown key "homepage" ignored',
      'contributes: unknown key "keybindings" ignored',
      'contributes.views[0]: unknown key "icon" ignored',
    ]);
  });
  it('examples/plugin-hello/plugin.json 이 통과한다', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL('../../../examples/plugin-hello/plugin.json', import.meta.url), 'utf8');
    const result = parseManifestText(text, { appVersion: '0.1.0' });
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('parseManifest — 거부', () => {
  it('이름', () => {
    for (const name of ['Hello', '-hello', 'hello_world', 'a'.repeat(65), '', 'hello world']) {
      expect(errorsOf({ ...valid(), name }).length, name).toBeGreaterThan(0);
    }
  });
  it('버전 · minAppVersion · 앱보다 높은 minAppVersion', () => {
    for (const version of ['1.0', '01.0.0', 'v1.0.0', '1.0.0.0', 'latest']) {
      expect(errorsOf({ ...valid(), version }).length, version).toBeGreaterThan(0);
    }
    expect(errorsOf({ ...valid(), minAppVersion: '0.2.0' }, '0.1.0')).toEqual(['plugin.json.minAppVersion: requires app 0.2.0 but this app is 0.1.0']);
  });
  it('경로 탈출 · 절대경로 · URL', () => {
    for (const path of ['../evil.mjs', 'a/../../evil.mjs', '/etc/passwd.js', 'C:\\x\\main.js', '\\\\srv\\share\\a.js', 'a\\..\\..\\b.js', 'file:///x.js']) {
      expect(errorsOf({ ...valid(), main: path }).length, path).toBeGreaterThan(0);
    }
    expect(errorsOf({ ...valid(), ui: '../../outside.html' })).toEqual(['plugin.json.ui: must be a relative path inside the plugin folder']);
    expect(errorsOf({ ...valid(), main: 'main.py' })).toEqual(['plugin.json.main: must end with .mjs, .cjs or .js']);
    expect(errorsOf({ ...valid(), contributes: { snippets: [{ locale: 'ko-KR', path: '../x.json' }] } }).length).toBe(1);
  });
  it('모르는 activation event', () => {
    for (const event of ['*', 'onStartupFinished', 'onView:', 'onUri:x', 'onEntity:Bad-Name', 42]) {
      expect(errorsOf({ ...valid(), activationEvents: [event] }).length, String(event)).toBe(1);
    }
    expect(errorsOf({ ...valid(), activationEvents: undefined }).length).toBe(1);
  });
  it('승인 엔티티 쓰기 권한 · 재정의 · 확장은 거부(합의안 5)', () => {
    expect(errorsOf({ ...valid(), permissions: ['entity:cmh_ai_approval:crud'] })).toEqual([
      'plugin.json.permissions[0]: "entity:cmh_ai_approval:crud" denied — writes to cmh_ai_approval are only allowed from the app UI (human click)',
    ]);
    expect(errorsOf({ ...valid(), contributes: { entities: [{ name: 'cmh_ai_approval', fields: [{ name: 'x', type: 'string' }] }] } }).length).toBe(1);
    expect(errorsOf({ ...valid(), contributes: { entityExtensions: [{ entity: 'cmh_ai_approval', fields: [{ name: 'auto', type: 'bool' }] }] } }).length).toBe(1);
  });
  it('모르는 권한 · 틀린 contributes', () => {
    for (const permission of ['entity:cmh_ai_task:write', 'entity:cmh_ai_task', 'fs:/', 'host:https://x.com', 'host:*', 'tool:']) {
      expect(errorsOf({ ...valid(), permissions: [permission] }).length, permission).toBe(1);
    }
    expect(errorsOf({ ...valid(), contributes: { views: [{ id: 'v', title: 'V', where: 'statusbar' }] } })).toEqual(['contributes.views[0].where: must be one of sidebar, pane']);
    expect(errorsOf({ ...valid(), contributes: { menus: [{ command: 'nope', location: 'x' }] } })).toEqual(['contributes.menus[0].command: "nope" is not declared in contributes.commands']);
    expect(errorsOf({ ...valid(), contributes: { settings: [{ key: 'k', type: 'number', default: 'x' }] } })).toEqual(['contributes.settings[0].default: must be a number']);
  });
  it('이름 첫 글자는 영문 소문자(숫자로 시작하면 Chromium 이 호스트를 IPv4 로 읽는다 · 검수 8 🟢3)', () => {
    for (const name of ['123', '1plugin', '0-x']) expect(errorsOf({ ...valid(), name }).length, name).toBeGreaterThan(0);
    expect(errorsOf({ ...valid(), name: 'a1-x' })).toEqual([]);
  });
  it(`도구는 ${PLUGIN_MAX_TOOLS} 개까지(검수 8 🟢7)`, () => {
    const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, description: 'd', access: 'read' }));
    expect(errorsOf({ ...valid(), contributes: { tools: tools(PLUGIN_MAX_TOOLS) } })).toEqual([]);
    expect(errorsOf({ ...valid(), contributes: { tools: tools(PLUGIN_MAX_TOOLS + 1) } })).toEqual([`contributes.tools: more than ${PLUGIN_MAX_TOOLS} tools (${PLUGIN_MAX_TOOLS + 1})`]);
  });
  it('예약 엔티티 system_config — 재정의 · 확장 · 권한 선언(read 도) 모두 거부(검수 10 🟡4)', () => {
    expect(errorsOf({ ...valid(), contributes: { entities: [{ name: 'system_config', fields: [{ name: 'x', type: 'string' }] }] } }).length).toBe(1);
    expect(errorsOf({ ...valid(), contributes: { entityExtensions: [{ entity: 'system_config', fields: [{ name: 'x', type: 'string' }] }] } }).length).toBe(1);
    for (const permission of ['entity:system_config:read', 'entity:system_config:crud']) {
      expect(errorsOf({ ...valid(), permissions: [permission] }), permission).toEqual([
        `plugin.json.permissions[0]: "${permission}" denied — system_config is reserved for the app (plugin settings: host:settings.get)`,
      ]);
    }
  });
  it('JSON 이 깨지면 결과로', () => {
    const result = parseManifestText('{ nope');
    expect(result.ok).toBe(false);
  });
});

describe('작은 도우미', () => {
  it('compareSemver', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0+build', '1.0.0')).toBe(0);
  });
  it('isSafeRelativePath', () => {
    expect(isSafeRelativePath('dist/main.mjs')).toBe(true);
    expect(isSafeRelativePath('./main.mjs')).toBe(true);
    expect(isSafeRelativePath('.')).toBe(false);
    expect(isSafeRelativePath('a\0b')).toBe(false);
  });
  it('권한 검사 — 엔티티 · 호스트 · 도구', () => {
    const permissions = ['entity:cmh_ai_prompt:read', 'entity:hello_note:crud', 'entity:cmh_ai_approval:read', 'host:api.example.com', 'host:*.example.org', 'tool:mcp:shop:*']
      .map((raw) => parsePermission(raw))
      .filter((p) => p !== null);
    expect(checkEntityAccess(permissions, 'cmh_ai_prompt', 'read').allowed).toBe(true);
    expect(checkEntityAccess(permissions, 'cmh_ai_prompt', 'write').allowed).toBe(false);
    expect(checkEntityAccess(permissions, 'hello_note', 'write').allowed).toBe(true);
    expect(checkEntityAccess(permissions, 'cmh_ai_task', 'read').allowed).toBe(false);
    expect(checkEntityAccess(permissions, 'cmh_ai_approval', 'read').allowed).toBe(true);
    // 매니페스트 검증을 우회해 crud 를 꽂아도 쓰기는 거부
    const forged = [{ kind: 'entity', entity: 'cmh_ai_approval', access: 'crud', raw: 'entity:cmh_ai_approval:crud' } as const];
    expect(checkEntityAccess(forged, 'cmh_ai_approval', 'write')).toEqual({ allowed: false, reason: 'writes to cmh_ai_approval are only allowed from the app UI' });
    expect(checkHostAccess(permissions, 'https://api.example.com/v1').allowed).toBe(true);
    expect(checkHostAccess(permissions, 'http://api.example.com/v1').allowed).toBe(false);
    expect(checkHostAccess(permissions, 'https://evil.com/?api.example.com').allowed).toBe(false);
    expect(checkHostAccess(permissions, 'https://a.example.org/').allowed).toBe(true);
    expect(checkHostAccess(permissions, 'https://example.org/').allowed).toBe(false);
    expect(checkHostAccess(permissions, 'https://xexample.org/').allowed).toBe(false);
    expect(checkToolAccess(permissions, 'mcp:shop:dal_search').allowed).toBe(true);
    expect(checkToolAccess(permissions, 'mcp:shop:a:b').allowed).toBe(false);
    expect(checkToolAccess(permissions, 'mcp:other:x').allowed).toBe(false);
  });
});
