import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from './event-bus.js';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import { createProcessRuntimeFactory, PluginProcess, type PermissionDeniedInfo, type PluginDataAccess } from './plugin-process.js';
import { NodeProcessLauncher, toNodeOptions } from './process-launcher.js';
import { RPC_ERROR, RpcError } from './plugin-rpc.js';

const HELLO_DIR = fileURLToPath(new URL('../../../examples/plugin-hello/', import.meta.url));
const launcher = new NodeProcessLauncher();

function manifestOf(input: unknown): PluginManifest {
  const result = parseManifest(input);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

async function helloManifest(): Promise<PluginManifest> {
  const { readFile } = await import('node:fs/promises');
  return manifestOf(JSON.parse(await readFile(join(HELLO_DIR, 'plugin.json'), 'utf8')));
}

class FakeData implements PluginDataAccess {
  readonly calls: string[] = [];
  async search(entity: string, criteria: unknown) {
    this.calls.push(`search:${entity}:${JSON.stringify(criteria)}`);
    return { total: 1, elements: [{ id: 'p1', name: 'greeting' }], aggregations: {} };
  }
  async get(entity: string, id: string) { this.calls.push(`get:${entity}:${id}`); return null; }
  async upsert(entity: string) { this.calls.push(`upsert:${entity}`); return { written: 1 }; }
  async delete(entity: string) { this.calls.push(`delete:${entity}`); return { deleted: 1 }; }
}

const running: PluginProcess[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
});

async function startHello(extra: Partial<ConstructorParameters<typeof PluginProcess>[0]> = {}, manifest?: PluginManifest) {
  const data = new FakeData();
  const denied: PermissionDeniedInfo[] = [];
  const logs: string[] = [];
  const plugin = new PluginProcess({
    manifest: manifest ?? await helloManifest(),
    pluginDir: HELLO_DIR,
    launcher,
    data,
    onPermissionDenied: (info) => denied.push(info),
    onLog: (_name, level, message) => logs.push(`${level}:${message}`),
    ...extra,
  });
  running.push(plugin);
  await plugin.start();
  return { plugin, data, denied, logs };
}

function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('waitFor timed out'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

describe('PluginProcess — Node fork 어댑터 · examples/plugin-hello', () => {
  it('ping 왕복 · 별도 프로세스 · activate 로그', async () => {
    const { plugin, logs } = await startHello();
    expect(plugin.status).toBe('running');
    const reply = await plugin.request('ping') as { pong: boolean; pid: number };
    expect(reply.pong).toBe(true);
    expect(reply.pid).toBe(plugin.pid);
    expect(reply.pid).not.toBe(process.pid);
    await waitFor(() => logs.length > 0);
    expect(logs[0]).toMatch(/^info:plugin-hello 0\.1\.0 activated/);
  });

  it('선언한 엔티티 읽기는 통과 · 선언 없는 엔티티는 앱(main)이 거부', async () => {
    const { plugin, data, denied } = await startHello();
    expect(await plugin.request('hello.readPrompts')).toEqual({ ok: true, result: { total: 1, elements: [{ id: 'p1', name: 'greeting' }], aggregations: {} } });
    expect(await plugin.request('hello.readTasks')).toEqual({
      ok: false,
      error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: permission "entity:cmh_ai_task:read" not declared' },
    });
    expect(data.calls).toEqual(['search:cmh_ai_prompt:{"limit":5}']);
    expect(denied).toEqual([{ plugin: 'plugin-hello', method: 'repository.search', entity: 'cmh_ai_task', operation: 'read', reason: 'permission "entity:cmh_ai_task:read" not declared' }]);
  });

  it('승인 엔티티 쓰기는 거부 — 매니페스트를 우회해 crud 를 꽂아도', async () => {
    const forged = { ...(await helloManifest()) };
    const manifest: PluginManifest = { ...forged, permissions: [...forged.permissions, { kind: 'entity', entity: 'cmh_ai_approval', access: 'crud', raw: 'entity:cmh_ai_approval:crud' }] };
    const { plugin, data } = await startHello({}, manifest);
    expect(await plugin.request('hello.approveSelf')).toEqual({
      ok: false,
      error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: writes to cmh_ai_approval are only allowed from the app UI' },
    });
    expect(data.calls).toEqual([]);
  });

  it('응답 시간초과 → RpcError(timeout) · 프로세스는 계속 산다', async () => {
    const { plugin } = await startHello();
    const error = await plugin.request('ping', { delayMs: 1_000 }, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(RPC_ERROR.timeout);
    expect(plugin.status).toBe('running');
    expect(await plugin.request('ping')).toMatchObject({ pong: true });
  });

  it('없는 메서드는 Method not found', async () => {
    const { plugin } = await startHello();
    await expect(plugin.request('nope')).rejects.toMatchObject({ code: RPC_ERROR.methodNotFound });
  });

  it('플러그인 프로세스를 죽이면 crashed · 기다리던 요청은 거부 · 시험 프로세스(앱)는 계속', async () => {
    const { plugin } = await startHello();
    const exits: { code: number | null; expected: boolean }[] = [];
    plugin.onExit((info) => exits.push(info));
    const waiting = plugin.request('ping', { delayMs: 5_000 }).catch((e: unknown) => e);
    process.kill(plugin.pid as number, 'SIGKILL');
    const error = await waiting;
    expect((error as RpcError).code).toBe(RPC_ERROR.processExited);
    expect(plugin.status).toBe('crashed');
    expect(exits).toEqual([{ code: null, expected: false }]);
    await expect(plugin.request('ping')).rejects.toThrow('not running (crashed)');
  });

  it('stop 은 expected 종료 · stopped', async () => {
    const { plugin } = await startHello();
    const exits: boolean[] = [];
    plugin.onExit((info) => exits.push(info.expected));
    await plugin.stop();
    expect(plugin.status).toBe('stopped');
    expect(exits).toEqual([true]);
  });

  it('createProcessRuntimeFactory — subscribers 이벤트를 플러그인에 넘긴다', async () => {
    const bus = new EventBus();
    const factory = createProcessRuntimeFactory({ launcher, bus });
    const runtime = factory({ manifest: await helloManifest(), pluginDir: HELLO_DIR }) as ReturnType<typeof factory> & { process: PluginProcess };
    running.push(runtime.process);
    await runtime.start();
    expect(bus.listenerCount('app.ready', 'plugin-hello')).toBe(1);
    await bus.emit('app.ready', { at: 1 });
    // 같은 채널이라 차례가 지켜진다 — 알림 다음 요청이면 이미 받았다
    expect(await runtime.process.request('hello.lastEvent')).toEqual({ event: 'app.ready', payload: { at: 1 } });
  });
});

const FIXTURE_MAIN = `
const send = (m) => process.parentPort ? process.parentPort.postMessage(m) : process.send(m);
const on = (f) => process.parentPort ? process.parentPort.on('message', (e) => f(e.data)) : process.on('message', f);
const { readFileSync } = await import('node:fs');
on((m) => {
  if (!m || typeof m.method !== 'string' || m.id === undefined) return;
  if (m.method === 'activate' || m.method === 'deactivate') return send({ jsonrpc: '2.0', id: m.id, result: null });
  if (m.method === 'read') {
    try { return send({ jsonrpc: '2.0', id: m.id, result: { ok: true, text: readFileSync(m.params.path, 'utf8') } }); }
    catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { ok: false, code: e.code ?? null } }); }
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
`;

describe('PluginProcess — 폴더 밖 · 파일 읽기 제한(S2 · Node 권한 모델)', () => {
  let base = '';
  let pluginDir = '';
  const fixture = (): PluginManifest => manifestOf({ name: 'fs-probe', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onStartup'] });

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'cmh-plugin-'));
    pluginDir = join(base, 'fs-probe');
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, 'main.mjs'), FIXTURE_MAIN);
    await writeFile(join(pluginDir, 'inside.txt'), 'inside');
    await writeFile(join(base, 'secret.sqlite'), 'secret');
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('sandboxFs: false 면 폴더 밖 파일을 읽는다(별도 프로세스만으로는 fs 가 열려 있다)', async () => {
    const plugin = new PluginProcess({ manifest: fixture(), pluginDir, launcher, sandboxFs: false });
    running.push(plugin);
    await plugin.start();
    expect(await plugin.request('read', { path: join(base, 'secret.sqlite') })).toEqual({ ok: true, text: 'secret' });
  });

  it('기본(sandboxFs) 은 폴더 안은 읽고 밖은 ERR_ACCESS_DENIED', async () => {
    const plugin = new PluginProcess({ manifest: fixture(), pluginDir, launcher });
    running.push(plugin);
    await plugin.start();
    expect(await plugin.request('read', { path: join(pluginDir, 'inside.txt') })).toEqual({ ok: true, text: 'inside' });
    expect(await plugin.request('read', { path: join(base, 'secret.sqlite') })).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' });
  });

  // 역슬래시가 든 폴더 이름은 Linux 에서 Node ESM 이 main 자체를 못 읽어(ERR_INVALID_MODULE_SPECIFIER) 빼고 toNodeOptions 단위 시험으로만 본다
  it('NODE_OPTIONS 길(Electron 어댑터와 같은 길) · 빈칸 · 따옴표가 든 폴더 이름도', async () => {
    const oddDir = join(base, 'odd dir "q"', 'fs-probe');
    await mkdir(oddDir, { recursive: true });
    await writeFile(join(oddDir, 'main.mjs'), FIXTURE_MAIN);
    await writeFile(join(oddDir, 'inside.txt'), 'odd-inside');
    const plugin = new PluginProcess({ manifest: fixture(), pluginDir: oddDir, launcher: new NodeProcessLauncher({ viaNodeOptions: true }), sandboxFs: true });
    running.push(plugin);
    await plugin.start();
    expect(await plugin.request('read', { path: join(oddDir, 'inside.txt') })).toEqual({ ok: true, text: 'odd-inside' });
    expect(await plugin.request('read', { path: join(base, 'secret.sqlite') })).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' });
  });

  it('toNodeOptions', () => {
    expect(toNodeOptions(['--permission', '--allow-fs-read=C:\\Users\\Kim Lee\\plugins\\a'])).toBe('--permission --allow-fs-read="C:\\\\Users\\\\Kim Lee\\\\plugins\\\\a"');
  });

  it('main 이 심볼릭 링크로 폴더 밖을 가리키면 띄우지 않는다', async () => {
    const linkDir = join(base, 'link-probe');
    await mkdir(linkDir);
    await writeFile(join(base, 'outside.mjs'), FIXTURE_MAIN);
    await symlink(join(base, 'outside.mjs'), join(linkDir, 'main.mjs'));
    const plugin = new PluginProcess({ manifest: fixture(), pluginDir: linkDir, launcher });
    await expect(plugin.start()).rejects.toThrow('resolves outside the plugin folder');
    expect(plugin.status).toBe('crashed');
  });
});
