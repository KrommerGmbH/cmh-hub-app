// R2-b — 실제 별도 프로세스(Node fork)에서 host:* 권한 검사와 tool:* 호출을 끝까지 본다.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionDeniedInfo, PluginDataAccess } from './plugin-host-api.js';
import { createProcessRuntimeFactory } from './plugin-process.js';
import { PluginRegistry } from './plugin-registry.js';
import { RPC_ERROR } from './plugin-rpc.js';
import { PluginToolSource } from './plugin-tools.js';
import { NodeProcessLauncher } from './process-launcher.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/host-rpc/', import.meta.url));

class FakeData implements PluginDataAccess {
  readonly calls: string[] = [];
  async search(entity: string) { this.calls.push(`search:${entity}`); return { total: 1 }; }
  async get() { return null; }
  async upsert() { return null; }
  async delete() { return null; }
}

let root = '';
let registry: PluginRegistry | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cmh-host-rpc-'));
  await cp(FIXTURE, join(root, 'host-rpc'), { recursive: true });
});
afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await rm(root, { recursive: true, force: true });
});

async function setup(viaNodeOptions: boolean) {
  const data = new FakeData();
  const denied: PermissionDeniedInfo[] = [];
  const logs: string[] = [];
  const factory = createProcessRuntimeFactory({
    launcher: new NodeProcessLauncher({ viaNodeOptions }),
    data,
    settings: { get: (plugin, key) => (plugin === 'host-rpc' && key === 'greeting' ? 'hallo' : undefined) },
    onPermissionDenied: (info) => denied.push(info),
    onLog: (plugin, level, message) => logs.push(`${plugin}:${level}:${message}`),
  });
  registry = new PluginRegistry({ root, appVersion: '0.1.0', runtimeFactory: factory });
  await registry.scan();
  await registry.install('host-rpc');
  await registry.activate('host-rpc');
  return { registry, data, denied, logs, tools: new PluginToolSource({ host: registry }) };
}

describe.each([false, true])('host:* · tool:* — 실제 자식 프로세스(NODE_OPTIONS=%s)', (viaNodeOptions) => {
  it('tool 호출이 onTool 로 그 플러그인을 깨우고 · 자식이 부른 host:log 는 통과 · 선언 없는 host:* 는 permissionDenied', async () => {
    const { registry: reg, data, denied, logs, tools } = await setup(viaNodeOptions);
    expect(reg.isRunning('host-rpc')).toBe(false); // 게으른 활성화 — 도구가 불릴 때까지 안 띄운다
    expect(tools.listTools().map((t) => [t.name, t.needsApproval])).toEqual([['plugin:host-rpc:echo', false], ['plugin:host-rpc:save', true]]);

    expect(await tools.callTool('plugin:host-rpc:echo', { text: 'hi' })).toEqual({ ok: true, text: 'hi', truncated: false });
    expect(reg.isRunning('host-rpc')).toBe(true);
    expect(await tools.callTool('plugin:host-rpc:save', {})).toEqual({ ok: false, error: 'save refused by plugin', truncated: false });

    const probe = await reg.request('host-rpc', 'probe') as Record<string, unknown>;
    expect(probe).toEqual({
      log: { ok: true, result: null },
      unknown: { ok: false, code: RPC_ERROR.permissionDenied, message: 'permission denied: host method "host:nope" is not available to plugins' },
      undeclaredEntity: { ok: false, code: RPC_ERROR.permissionDenied, message: 'permission denied: permission "entity:cmh_ai_task:read" not declared' },
      declaredEntity: { ok: true, result: { total: 1 } },
      setting: { ok: true, result: 'hallo' },
      undeclaredSetting: { ok: false, code: RPC_ERROR.permissionDenied, message: 'permission denied: setting "secret" is not declared in contributes.settings' },
      dataNotification: 'sent',
    });
    expect(logs).toContain('host-rpc:info:hello from child');
    expect(logs).toContain('host-rpc:warn:rpc: dropped notification "host:data.search": this method must be called as a request (with id)');
    expect(data.calls).toEqual(['search:cmh_ai_prompt']);
    expect(denied.map((d) => d.method)).toEqual(['host:nope', 'host:data.search', 'host:settings.get']);
  });
});
