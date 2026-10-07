import { describe, expect, it } from 'vitest';
import { evaluateGuard, parseGuardPolicy } from '../settings/guard-policy.js';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import type { PluginState } from './plugin-registry.js';
import { PluginToolSource, parsePluginToolName, pluginToolName, toolNeedsApproval, toolResultFromPlugin, type PluginToolHost } from './plugin-tools.js';

function manifestOf(input: Record<string, unknown>): PluginManifest {
  const result = parseManifest({ name: 'tooly', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onTool:echo', 'onTool:save'], ...input });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

const TOOLY = manifestOf({
  contributes: {
    tools: [
      { name: 'echo', description: 'Echo', access: 'read', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'save', description: 'Save' },
    ],
  },
});

describe('도구 이름 — plugin:<플러그인>:<도구>', () => {
  it('세 마디로 만들고 되읽는다', () => {
    expect(pluginToolName('plugin-hello', 'say.hi')).toBe('plugin:plugin-hello:say.hi');
    expect(parsePluginToolName('plugin:plugin-hello:say.hi')).toEqual({ plugin: 'plugin-hello', tool: 'say.hi' });
  });
  it('도구 이름에 : · 공백 · 비ASCII · 빈 값이면 예외 · 플러그인 이름이 규칙 밖이면 예외', () => {
    for (const bad of ['a:b', 'a b', 'ｅcho', '', '-lead', 'x'.repeat(65)]) expect(() => pluginToolName('p', bad)).toThrow(/tool name/);
    for (const bad of ['Plugin', 'a_b', '']) expect(() => pluginToolName(bad, 'echo')).toThrow(/plugin name/);
  });
  it('되읽기는 꼴이 아니면 null(마디 수 · 앞붙이 · 글자)', () => {
    for (const bad of ['plugin:a', 'plugin:a:b:c', 'app:a:b', 'plugin:A:b', 'plugin:a:b c']) expect(parsePluginToolName(bad)).toBeNull();
  });
  it('Guard 정책 글롭이 그대로 맞는다 · 마디를 늘려 deny 를 비껴가지 못한다', () => {
    const policy = parseGuardPolicy({ defaultMode: 'guard', tools: { 'plugin:tooly:*': 'allow', 'plugin:evil:*': 'deny' }, credentials: {} });
    expect(evaluateGuard(policy, { tool: pluginToolName('tooly', 'echo'), known: true, needsApproval: false })).toEqual({ decision: 'allow', requiresApproval: false, matchedPattern: 'plugin:tooly:*' });
    expect(evaluateGuard(policy, { tool: pluginToolName('evil', 'x'), known: true }).decision).toBe('deny');
    // 플러그인 도구 기본 known=false → allow 규칙이어도 최소 ask
    expect(evaluateGuard(policy, { tool: pluginToolName('tooly', 'echo'), known: false }).decision).toBe('ask');
  });
});

describe('쓰기 꼴 도구 → needsApproval', () => {
  it('access 가 read 만 아니다 · 빠지면 write', () => {
    expect(TOOLY.contributes.tools.map((t) => [t.name, t.access, toolNeedsApproval(t)])).toEqual([
      ['echo', 'read', false],
      ['save', 'write', true],
    ]);
  });
  it('needsApproval 이 Guard requiresApproval 로 간다(allow 여도 승인 관문)', () => {
    const policy = parseGuardPolicy({ defaultMode: 'full', tools: { 'plugin:**': 'allow' }, credentials: {} });
    expect(evaluateGuard(policy, { tool: 'plugin:tooly:save', known: true, needsApproval: true })).toMatchObject({ decision: 'allow', requiresApproval: true });
  });
  it('도구 이름이 승인 엔티티를 담으면 Guard 가 deny(플러그인이 이름으로 우회 못 함)', () => {
    const policy = parseGuardPolicy({ defaultMode: 'full', tools: { 'plugin:**': 'allow' }, credentials: {} });
    expect(evaluateGuard(policy, { tool: pluginToolName('tooly', 'cmh_ai_approval_update'), known: true }).decision).toBe('deny');
  });
});

describe('매니페스트 contributes.tools', () => {
  const base = { name: 'tooly', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onStartup'] };
  const errors = (tools: unknown): readonly string[] => {
    const r = parseManifest({ ...base, contributes: { tools } });
    return r.ok ? [] : r.errors;
  };
  it('거부: 이름에 : · parameters 가 object 스키마가 아님 · access 모름 · 중복 · 설명 없음', () => {
    expect(errors([{ name: 'a:b', description: 'x' }])[0]).toMatch(/contributes\.tools\[0\]\.name/);
    expect(errors([{ name: 'a', description: 'x', parameters: { type: 'string' } }])[0]).toMatch(/parameters/);
    expect(errors([{ name: 'a', description: 'x', access: 'admin' }])[0]).toMatch(/access/);
    expect(errors([{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }])[0]).toMatch(/duplicate id "a"/);
    expect(errors([{ name: 'a' }])[0]).toMatch(/description/);
  });
  it('onTool 활성화가 없고 onStartup 도 없으면 경고', () => {
    const r = parseManifest({ ...base, activationEvents: ['onView:v'], contributes: { views: [{ id: 'v', title: 'V', where: 'pane' }], tools: [{ name: 'a', description: 'x' }] } });
    expect(r.ok && r.warnings).toEqual(['contributes.tools: tool "a" has no activation event (add "onTool:a")']);
  });
  it('onTool:<선언 안 한 도구> 는 경고 · onTool:<깨진 이름> 은 오류', () => {
    const warn = parseManifest({ ...base, activationEvents: ['onTool:ghost'] });
    expect(warn.ok && warn.warnings).toEqual(['plugin.json.activationEvents[0]: tool "ghost" is not declared in contributes.tools']);
    expect(parseManifest({ ...base, activationEvents: ['onTool:a:b'] }).ok).toBe(false);
  });
  it('ui 는 .html 만', () => {
    expect(parseManifest({ ...base, ui: 'ui/index.js' }).ok).toBe(false);
    expect(parseManifest({ ...base, ui: 'ui/index.html' }).ok).toBe(true);
  });
});

class FakeHost implements PluginToolHost {
  running = new Set<string>();
  fired: string[] = [];
  requests: string[] = [];
  reply: unknown = { text: 'pong' };
  startOnFire = true;
  constructor(private readonly plugins: Array<{ name: string; state: PluginState; manifest: PluginManifest | null }>) {}
  activePlugins() { return this.plugins.filter((p) => p.state === 'active'); }
  async fire(event: string, only?: string) {
    this.fired.push(`${event}@${only}`);
    if (this.startOnFire && only) this.running.add(only);
    return only ? [only] : [];
  }
  isRunning(name: string) { return this.running.has(name); }
  async request(name: string, method: string, params?: unknown) {
    this.requests.push(`${name}:${method}:${JSON.stringify(params)}`);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

describe('PluginToolSource', () => {
  it('listTools — active 플러그인만 · 이름 · needsApproval · known 기본 false', () => {
    const host = new FakeHost([{ name: 'tooly', state: 'active', manifest: TOOLY }, { name: 'off', state: 'inactive', manifest: TOOLY }]);
    const source = new PluginToolSource({ host, isKnown: (n) => n === 'plugin:tooly:echo' });
    expect(source.listTools().map((t) => [t.name, t.needsApproval, t.known])).toEqual([
      ['plugin:tooly:echo', false, true],
      ['plugin:tooly:save', true, false],
    ]);
  });

  it('callTool — 안 떠 있으면 onTool 로 그 플러그인만 깨우고 tool:<이름> 요청', async () => {
    const host = new FakeHost([{ name: 'tooly', state: 'active', manifest: TOOLY }]);
    const source = new PluginToolSource({ host });
    expect(await source.callTool('plugin:tooly:echo', { text: 'a' })).toEqual({ ok: true, text: 'pong', truncated: false });
    expect(host.fired).toEqual(['onTool:echo@tooly']);
    expect(host.requests).toEqual(['tooly:tool:echo:{"text":"a"}']);
    await source.callTool('plugin:tooly:echo', {});
    expect(host.fired).toHaveLength(1); // 이미 떠 있으면 다시 깨우지 않는다
  });

  it('callTool 은 던지지 않는다 — 비활성 · 선언 없는 도구 · 깨우기 실패 · 플러그인 오류 · 이름 꼴', async () => {
    const host = new FakeHost([{ name: 'tooly', state: 'active', manifest: TOOLY }]);
    const source = new PluginToolSource({ host });
    expect(await source.callTool('plugin:other:echo', {})).toMatchObject({ ok: false, error: 'plugin "other" is not active' });
    expect(await source.callTool('plugin:tooly:ghost', {})).toMatchObject({ ok: false, error: 'plugin "tooly" does not declare tool "ghost"' });
    expect(await source.callTool('app:echo', {})).toMatchObject({ ok: false });
    host.startOnFire = false;
    expect((await source.callTool('plugin:tooly:echo', {})) as { error: string }).toMatchObject({ ok: false, error: expect.stringMatching(/not running/) as unknown });
    host.running.add('tooly');
    host.reply = new Error('boom');
    expect(await source.callTool('plugin:tooly:echo', {})).toEqual({ ok: false, error: 'plugin:tooly:echo: boom', truncated: false });
  });

  it('중단 신호 — 이미 중단이면 부르지 않는다', async () => {
    const host = new FakeHost([{ name: 'tooly', state: 'active', manifest: TOOLY }]);
    const source = new PluginToolSource({ host });
    const ac = new AbortController();
    ac.abort();
    expect(await source.callTool('plugin:tooly:echo', {}, { signal: ac.signal })).toMatchObject({ ok: false, error: 'aborted' });
    expect(host.requests).toEqual([]);
  });
});

describe('toolResultFromPlugin', () => {
  it('문자열 · {text} · 그 밖 JSON · {ok:false} · 상한 자르기', () => {
    expect(toolResultFromPlugin('a')).toEqual({ ok: true, text: 'a', truncated: false });
    expect(toolResultFromPlugin({ text: 'b' })).toEqual({ ok: true, text: 'b', truncated: false });
    expect(toolResultFromPlugin({ n: 1 })).toEqual({ ok: true, text: '{"n":1}', truncated: false });
    expect(toolResultFromPlugin(null)).toEqual({ ok: true, text: 'null', truncated: false });
    expect(toolResultFromPlugin({ ok: false, error: 'no' })).toEqual({ ok: false, error: 'no', truncated: false });
    expect(toolResultFromPlugin('x'.repeat(10), 4)).toEqual({ ok: true, text: 'xxxx', truncated: true });
  });
});
