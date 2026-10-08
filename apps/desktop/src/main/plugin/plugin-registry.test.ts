import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './event-bus.js';
import { createProcessRuntimeFactory } from './plugin-process.js';
import { PluginLifecycleError, PluginRegistry, type PluginExitInfo, type PluginLifecycleHooks, type PluginRuntime, type PluginRuntimeFactory } from './plugin-registry.js';
import { NodeProcessLauncher } from './process-launcher.js';
import { ServiceContainer } from './service-container.js';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));

function manifest(name: string, events: string[], version = '1.0.0'): string {
  return JSON.stringify({ name, version, minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: events, contributes: { views: [{ id: `${name}.view`, title: name, where: 'pane' }] } });
}

class FakeRuntime implements PluginRuntime {
  started = false;
  stopped = false;
  private readonly listeners: ((info: PluginExitInfo) => void)[] = [];
  constructor(readonly name: string, private readonly failStart = false) {}
  async start() {
    if (this.failStart) throw new Error('boom');
    this.started = true;
  }
  async stop() {
    this.stopped = true;
    for (const l of this.listeners) l({ code: 0, expected: true });
  }
  onExit(listener: (info: PluginExitInfo) => void) { this.listeners.push(listener); }
  crash() { for (const l of this.listeners) l({ code: 1, expected: false }); }
}

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cmh-plugins-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function addPlugin(folder: string, json: string): Promise<void> {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, folder, 'plugin.json'), json);
}

function setup(hooks: PluginLifecycleHooks = {}, failing: string[] = []) {
  const runtimes: FakeRuntime[] = [];
  const errors: string[] = [];
  const factory: PluginRuntimeFactory = ({ manifest: m }) => {
    const runtime = new FakeRuntime(m.name, failing.includes(m.name));
    runtimes.push(runtime);
    return runtime;
  };
  const registry = new PluginRegistry({ root, appVersion: '0.1.0', runtimeFactory: factory, hooks, onError: (n, msg) => errors.push(`${n}: ${msg}`) });
  return { registry, runtimes, errors };
}

describe('PluginRegistry — 스캔', () => {
  it('<root>/*/plugin.json 만 읽고 깨진 것은 error 로 둔다', async () => {
    await addPlugin('alpha', manifest('alpha', ['onStartup']));
    await addPlugin('broken', '{ nope');
    await addPlugin('mismatch', manifest('other-name', ['onStartup']));
    await mkdir(join(root, 'not-a-plugin'));
    await writeFile(join(root, 'loose.json'), '{}');
    const { registry } = setup();
    const list = await registry.scan();
    expect(list.map((p) => [p.name, p.state])).toEqual([['alpha', 'discovered'], ['broken', 'error'], ['mismatch', 'error']]);
    expect(registry.get('mismatch')?.errorMessage).toBe('plugin.json name "other-name" must equal the folder name "mismatch"');
    await expect(registry.install('broken')).rejects.toBeInstanceOf(PluginLifecycleError);
  });
  it('폴더가 없으면 빈 목록', async () => {
    const registry = new PluginRegistry({ root: join(root, 'missing'), appVersion: '0.1.0', runtimeFactory: () => new FakeRuntime('x') });
    expect(await registry.scan()).toEqual([]);
  });
});

describe('PluginRegistry — 생명주기 순서(Shopware)', () => {
  it('install → activate → deactivate → uninstall · hook 차례', async () => {
    await addPlugin('alpha', manifest('alpha', ['onView:alpha.view']));
    const calls: string[] = [];
    const { registry } = setup({
      install: ({ manifest: m }) => { calls.push(`install:${m.name}`); },
      activate: () => { calls.push('activate'); },
      deactivate: () => { calls.push('deactivate'); },
      uninstall: (_c, o) => { calls.push(`uninstall:keepUserData=${o.keepUserData}`); },
    });
    await registry.scan();
    await registry.install('alpha');
    expect(registry.get('alpha')?.state).toBe('installed');
    await registry.activate('alpha');
    expect(registry.get('alpha')?.state).toBe('active');
    await registry.deactivate('alpha');
    expect(registry.get('alpha')?.state).toBe('inactive');
    await registry.uninstall('alpha', { keepUserData: true });
    expect(registry.get('alpha')?.state).toBe('discovered');
    await registry.install('alpha');
    await registry.uninstall('alpha', { keepUserData: false });
    expect(calls).toEqual(['install:alpha', 'activate', 'deactivate', 'uninstall:keepUserData=true', 'install:alpha', 'uninstall:keepUserData=false']);
  });
  it('순서 위반은 PluginLifecycleError', async () => {
    await addPlugin('alpha', manifest('alpha', ['onStartup']));
    const { registry } = setup();
    await registry.scan();
    await expect(registry.activate('alpha')).rejects.toThrow('cannot activate plugin "alpha" in state discovered');
    await expect(registry.uninstall('alpha', { keepUserData: false })).rejects.toThrow('cannot uninstall plugin "alpha" in state discovered');
    await registry.install('alpha');
    await expect(registry.install('alpha')).rejects.toThrow('cannot install plugin "alpha" in state installed');
    await expect(registry.deactivate('alpha')).rejects.toThrow('in state installed');
    await registry.activate('alpha');
    await expect(registry.uninstall('alpha', { keepUserData: true })).rejects.toThrow('cannot uninstall plugin "alpha" in state active');
    await expect(registry.install('nope')).rejects.toThrow('unknown plugin "nope"');
  });
  it('install hook 이 실패하면 상태를 바꾸지 않는다', async () => {
    await addPlugin('alpha', manifest('alpha', ['onStartup']));
    const { registry } = setup({ install: () => { throw new Error('migration failed'); } });
    await registry.scan();
    await expect(registry.install('alpha')).rejects.toThrow('migration failed');
    expect(registry.get('alpha')?.state).toBe('discovered');
  });
  it('update 는 판이 오를 때만 · 떠 있던 것은 내렸다가 다시', async () => {
    await addPlugin('alpha', manifest('alpha', ['onStartup']));
    const updates: string[] = [];
    const { registry, runtimes } = setup({ update: (_c, info) => { updates.push(`${info.fromVersion}->${info.toVersion}`); } });
    await registry.scan();
    await registry.install('alpha');
    await registry.activate('alpha');
    await registry.startup();
    await expect(registry.update('alpha')).rejects.toThrow('version 1.0.0 is not newer than 1.0.0');
    await addPlugin('alpha', manifest('alpha', ['onStartup'], '1.1.0'));
    await registry.update('alpha');
    expect(updates).toEqual(['1.0.0->1.1.0']);
    expect(registry.get('alpha')).toMatchObject({ version: '1.1.0', state: 'active', running: true });
    expect(runtimes.map((r) => [r.started, r.stopped])).toEqual([[true, true], [true, false]]);
  });
});

describe('PluginRegistry — 게으른 활성화(activationEvents)', () => {
  it('fire 는 이벤트를 선언한 active 플러그인만 띄운다', async () => {
    await addPlugin('alpha', manifest('alpha', ['onView:alpha.view']));
    await addPlugin('beta', manifest('beta', ['onView:beta.view', 'onCommand:beta.run']));
    await addPlugin('gamma', manifest('gamma', ['onView:alpha.view'])); // 설치만 · 활성 안 함
    const { registry, runtimes } = setup();
    await registry.scan();
    for (const name of ['alpha', 'beta', 'gamma']) await registry.install(name);
    await registry.activate('alpha');
    await registry.activate('beta');
    expect(await registry.startup()).toEqual([]);
    expect(runtimes).toEqual([]);
    expect(await registry.fire('onView:alpha.view')).toEqual(['alpha']);
    expect(registry.isRunning('alpha')).toBe(true);
    expect(registry.isRunning('beta')).toBe(false);
    expect(registry.isRunning('gamma')).toBe(false);
    expect(await registry.fire('onView:alpha.view')).toEqual([]); // 이미 떠 있다
    expect(await registry.fire('onCommand:beta.run')).toEqual(['beta']);
    expect(runtimes.map((r) => r.name)).toEqual(['alpha', 'beta']);
  });
  it('onStartup 은 startup() 때 · startup 뒤 activate 하면 바로', async () => {
    await addPlugin('alpha', manifest('alpha', ['onStartup']));
    await addPlugin('beta', manifest('beta', ['onStartup']));
    const { registry } = setup();
    await registry.scan();
    await registry.install('alpha');
    await registry.activate('alpha');
    expect(registry.isRunning('alpha')).toBe(false);
    expect(await registry.startup()).toEqual(['alpha']);
    await registry.install('beta');
    await registry.activate('beta');
    expect(registry.isRunning('beta')).toBe(true);
  });
  it('활성화 실패 · 프로세스 죽음 → state error · 구독 · 서비스 걷기 · deactivate 로 나온다', async () => {
    await addPlugin('alpha', manifest('alpha', ['onView:alpha.view']));
    await addPlugin('beta', manifest('beta', ['onView:beta.view']));
    const bus = new EventBus();
    const services = new ServiceContainer();
    const runtimes: FakeRuntime[] = [];
    const errors: string[] = [];
    const registry = new PluginRegistry({
      root, appVersion: '0.1.0', bus, services, onError: (n, m) => errors.push(`${n}: ${m}`),
      runtimeFactory: ({ manifest: m }) => {
        const r = new FakeRuntime(m.name, m.name === 'beta');
        runtimes.push(r);
        return r;
      },
    });
    await registry.scan();
    for (const name of ['alpha', 'beta']) {
      await registry.install(name);
      await registry.activate(name);
    }
    expect(await registry.fire('onView:beta.view')).toEqual([]);
    expect(registry.get('beta')).toMatchObject({ state: 'error', running: false, errorMessage: 'activation failed: boom' });
    await registry.fire('onView:alpha.view');
    bus.on('app.ready', () => undefined, 'alpha');
    services.register('x', () => 1);
    services.decorate<number>('x', (inner) => inner + 1, 'alpha');
    expect(services.get('x')).toBe(2);
    runtimes[1]?.crash();
    expect(registry.get('alpha')).toMatchObject({ state: 'error', running: false, errorMessage: 'plugin process exited unexpectedly (code 1)' });
    expect(bus.listenerCount(undefined, 'alpha')).toBe(0);
    expect(services.get('x')).toBe(1);
    expect(errors).toEqual(['beta: activation failed: boom', 'alpha: plugin process exited unexpectedly (code 1)']);
    await expect(registry.activate('alpha')).rejects.toThrow('in state error');
    await registry.deactivate('alpha');
    await registry.activate('alpha');
    expect(registry.get('alpha')).toMatchObject({ state: 'active', errorMessage: null });
  });
});

describe('PluginRegistry — 경합 · 폴더 검사', () => {
  it('plugin registry: deactivate 중 fire 는 새 런타임을 띄우지 않는다', async () => {
    await addPlugin('r1', manifest('r1', ['onStartup', 'onCommand:x']));
    let alive = 0;
    let made = 0;
    const registry = new PluginRegistry({
      root, appVersion: '0.1.0',
      runtimeFactory: () => {
        made += 1;
        let onExit: ((info: PluginExitInfo) => void) | null = null;
        return {
          async start() { alive += 1; },
          async stop() {
            await new Promise((r) => setTimeout(r, 100));
            alive -= 1;
            onExit?.({ code: 0, expected: true });
          },
          onExit(listener) { onExit = listener; },
        };
      },
    });
    await registry.scan();
    await registry.install('r1');
    await registry.activate('r1');
    await registry.startup();
    expect(alive).toBe(1);
    const deactivating = registry.deactivate('r1');
    await new Promise((r) => setTimeout(r, 10));
    const fired = await registry.fire('onCommand:x');
    await deactivating;
    expect(fired).toEqual([]);
    expect(registry.get('r1')).toMatchObject({ state: 'inactive', running: false });
    expect(alive).toBe(0);
    expect(made).toBe(1);
  });

  it('fire 는 앞선 activate 가 끝난 뒤의 상태로 판단한다(줄 안)', async () => {
    await addPlugin('r2', manifest('r2', ['onCommand:y']));
    const { registry, runtimes } = setup({ activate: () => new Promise((r) => setTimeout(r, 30)) });
    await registry.scan();
    await registry.install('r2');
    const activating = registry.activate('r2');
    expect(await registry.fire('onCommand:y')).toEqual([]); // 아직 installed 로 보였다 — 줄 밖 사전 거름에서 빠진다
    await activating;
    expect(await registry.fire('onCommand:y')).toEqual(['r2']);
    expect(runtimes).toHaveLength(1);
  });

  it('plugin sandbox: 폴더 안 심볼릭 링크는 scan/install 에서 거부', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cmh-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
      // scan 때 이미 링크가 있다 → error · 매니페스트를 버려 어떤 생명주기도 못 한다
      await addPlugin('linked', manifest('linked', ['onStartup']));
      await mkdir(join(root, 'linked', 'deep', 'er'), { recursive: true });
      await symlink(outside, join(root, 'linked', 'deep', 'er', 'data'));
      // scan 뒤 install 전에 링크가 생긴다 → install 거부 · error
      await addPlugin('later', manifest('later', ['onStartup']));
      // 하드링크는 경고만
      await addPlugin('hard', manifest('hard', ['onStartup']));
      await link(join(outside, 'secret.txt'), join(root, 'hard', 'copy.txt'));
      const { registry, runtimes } = setup();
      await registry.scan();
      expect(registry.get('linked')).toMatchObject({ state: 'error', version: null });
      expect(registry.get('linked')?.errorMessage).toMatch(/symbolic links are not allowed.*deep\/er\/data/);
      await expect(registry.install('linked')).rejects.toBeInstanceOf(PluginLifecycleError);
      await expect(registry.deactivate('linked')).rejects.toBeInstanceOf(PluginLifecycleError);
      expect(registry.get('hard')).toMatchObject({ state: 'discovered' });
      expect(registry.get('hard')?.warnings).toContain('hard link (shares content with a file elsewhere): copy.txt');

      await symlink(join(outside, 'secret.txt'), join(root, 'later', 'secret.txt'));
      await expect(registry.install('later')).rejects.toThrow(/symbolic links are not allowed/);
      expect(registry.get('later')).toMatchObject({ state: 'error', version: null });
      await expect(registry.deactivate('later')).rejects.toBeInstanceOf(PluginLifecycleError);
      expect(runtimes).toEqual([]);

      // 링크를 지우고 다시 scan 하면 discovered 로 돌아온다
      await rm(join(root, 'later', 'secret.txt'));
      await registry.scan();
      expect(registry.get('later')).toMatchObject({ state: 'discovered', errorMessage: null });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('PluginRegistry + PluginProcess(Node fork) — examples/plugin-hello', () => {
  it('onView 로 실제 프로세스를 띄우고 · kill 하면 error · 앱(시험 프로세스)은 산다', async () => {
    const registry = new PluginRegistry({ root: EXAMPLES, appVersion: '0.1.0', runtimeFactory: createProcessRuntimeFactory({ launcher: new NodeProcessLauncher() }) });
    try {
      expect((await registry.scan()).map((p) => p.name)).toContain('plugin-hello');
      await registry.install('plugin-hello');
      await registry.activate('plugin-hello');
      expect(await registry.startup()).toEqual([]);
      expect(await registry.fire('onView:hello.view')).toEqual(['plugin-hello']);
      const runtime = (registry as unknown as { records: Map<string, { runtime: { process: { pid: number } } }> }).records.get('plugin-hello')?.runtime;
      const pid = runtime?.process.pid as number;
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 'SIGKILL');
      const started = Date.now();
      while (registry.get('plugin-hello')?.state !== 'error' && Date.now() - started < 3_000) await new Promise((r) => setTimeout(r, 10));
      expect(registry.get('plugin-hello')).toMatchObject({ state: 'error', running: false });
      expect(registry.get('plugin-hello')?.errorMessage).toMatch(/^plugin process exited unexpectedly/);
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      await registry.dispose();
    }
  });
});

describe('PluginRegistry.request — 뜨는 중이면 시작을 기다린다(검수 8 🟡2)', () => {
  /** start 가 ms 만큼 걸리고 그 전에는 요청을 «starting» 으로 거부하는 런타임(plugin-process.ts request 와 같은 태도) */
  class SlowRuntime implements PluginRuntime {
    running = false;
    constructor(private readonly ms: number, private readonly failStart = false) {}
    async start() {
      await new Promise((r) => setTimeout(r, this.ms));
      if (this.failStart) throw new Error('boom');
      this.running = true;
    }
    async stop() { this.running = false; }
    onExit(_listener: (info: PluginExitInfo) => void) {}
    async request(method: string) {
      if (!this.running) throw new Error('plugin is not running (starting)');
      return `done ${method}`;
    }
  }
  const json = JSON.stringify({ name: 'tooly', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onTool:echo', 'onView:tooly.view'], contributes: { views: [{ id: 'tooly.view', title: 't', where: 'pane' }], tools: [{ name: 'echo', description: 'e', access: 'read' }] } });

  it('검수 8 재현 — onView 로 시작 중일 때 tool 요청(isRunning 이 이미 true)이 시작을 기다린 뒤 성공', async () => {
    await addPlugin('tooly', json);
    const registry = new PluginRegistry({ root, appVersion: '0.1.0', runtimeFactory: () => new SlowRuntime(40) });
    await registry.scan();
    await registry.install('tooly');
    await registry.activate('tooly');
    const firing = registry.fire('onView:tooly.view', 'tooly');
    await new Promise((r) => setTimeout(r, 5));
    expect(registry.isRunning('tooly')).toBe(true); // 아직 start 가 안 끝났는데 true — 도구 쪽이 fire 를 건너뛴다
    await expect(registry.request('tooly', 'tool:echo')).resolves.toBe('done tool:echo');
    await firing;
  });

  it('시작이 실패하면 «not running» 으로 거부(기다린 뒤)', async () => {
    await addPlugin('tooly', json);
    const registry = new PluginRegistry({ root, appVersion: '0.1.0', runtimeFactory: () => new SlowRuntime(20, true) });
    await registry.scan();
    await registry.install('tooly');
    await registry.activate('tooly');
    const firing = registry.fire('onView:tooly.view', 'tooly');
    await new Promise((r) => setTimeout(r, 5));
    await expect(registry.request('tooly', 'tool:echo')).rejects.toThrow(/is not running/);
    await firing;
  });
});
