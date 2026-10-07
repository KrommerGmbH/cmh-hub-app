// R2-a — 플러그인 한 개 = 별도 프로세스 하나(VS Code 확장 호스트 꼴). main 은 RPC 로만 말한다.
// 활성화 = launcher.launch(main) → 'activate' 요청 → 답이 오면 running. 프로세스가 죽으면 crashed + onExit(expected=false) · 앱은 산다.
// 권한 검사는 여기(main 쪽 RPC 핸들러)에서 한다. 플러그인이 `repository.search` 같은 요청을 보내면 매니페스트 permissions 와 대조 —
//   선언 없으면 거부(-32001) · 승인 엔티티 쓰기는 늘 거부(합의안 5). 플러그인 쪽 코드는 믿지 않는다.
// electron 을 import 하지 않는다(Electron 은 ProcessLauncher 어댑터 뒤에 있다).
//
// 플러그인 → 앱 메서드(1차):
//   repository.search { entity, criteria? }   읽기 · repository.get { entity, id } 읽기
//   repository.upsert { entity, rows[] }      쓰기 · repository.delete { entity, ids[] } 쓰기
//   log (알림) { level: 'info'|'warn'|'error', message }
// 앱 → 플러그인: activate { name, version } · deactivate · event (알림) { event, payload } · 그 밖은 플러그인이 정한 메서드(예 ping)

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PluginManifest } from './plugin-manifest.js';
import { checkEntityAccess, type EntityOperation } from './plugin-permissions.js';
import type { ProcessLauncher, PluginChannel } from './process-launcher.js';
import { RPC_ERROR, RpcEndpoint, RpcError, type RpcMethodHandler } from './plugin-rpc.js';
import type { EventBus } from './event-bus.js';
import type { PluginRuntime, PluginRuntimeFactory, PluginExitInfo } from './plugin-registry.js';

/** 플러그인이 RPC 로 쓰는 자료층(R1 Repository 를 엔티티 이름으로 감싼 것). 1차는 주입 — 앱 쪽 연결은 다음 차례. */
export interface PluginDataAccess {
  search(entity: string, criteria: unknown): Promise<unknown>;
  get(entity: string, id: string): Promise<unknown>;
  upsert(entity: string, rows: readonly unknown[]): Promise<unknown>;
  delete(entity: string, ids: readonly string[]): Promise<unknown>;
}

export interface PermissionDeniedInfo {
  readonly plugin: string;
  readonly method: string;
  readonly entity: string;
  readonly operation: EntityOperation;
  readonly reason: string;
}

export interface PluginProcessOptions {
  readonly manifest: PluginManifest;
  /** 플러그인 폴더(절대경로) */
  readonly pluginDir: string;
  readonly launcher: ProcessLauncher;
  readonly data?: PluginDataAccess;
  /** 앱 → 플러그인 요청 기본 시간초과 · 기본 10초 */
  readonly requestTimeoutMs?: number;
  /** 'activate' 답을 기다리는 시간 · 기본 10초 */
  readonly startTimeoutMs?: number;
  /** 'deactivate' 답을 기다리고 kill 하기까지 · 기본 2초 */
  readonly stopTimeoutMs?: number;
  /**
   * 기본 true — Node 권한 모델로 띄운다: `--permission --allow-fs-read=<플러그인 폴더>`(S2).
   * 실측(Electron 44.5.1 · NODE_OPTIONS 길): 폴더 밖 읽기 · 모든 쓰기 · child_process 가 ERR_ACCESS_DENIED. 네트워크는 못 막는다(Node 24 에 --allow-net 없음).
   */
  readonly sandboxFs?: boolean;
  readonly onLog?: (plugin: string, level: string, message: string) => void;
  readonly onPermissionDenied?: (info: PermissionDeniedInfo) => void;
}

export type PluginProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

const MAX_LOG_LENGTH = 4_000;

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

/** 플러그인 폴더 안의 실제 파일인가(심볼릭 링크로 밖을 가리키는 것 거부) */
export async function resolveInside(pluginDir: string, entry: string): Promise<string> {
  const realDir = await realpath(pluginDir);
  const realEntry = await realpath(resolve(realDir, entry));
  const rel = relative(realDir, realEntry);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`"${entry}" resolves outside the plugin folder`);
  return realEntry;
}

export class PluginProcess implements PluginRuntime {
  private statusValue: PluginProcessStatus = 'idle';
  private channel: PluginChannel | null = null;
  private rpc: RpcEndpoint | null = null;
  private readonly exitListeners: ((info: PluginExitInfo) => void)[] = [];
  private exitPromise: Promise<void> | null = null;

  constructor(private readonly options: PluginProcessOptions) {}

  get status(): PluginProcessStatus {
    return this.statusValue;
  }

  get pid(): number | undefined {
    return this.channel?.pid;
  }

  get name(): string {
    return this.options.manifest.name;
  }

  onExit(listener: (info: PluginExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  async start(): Promise<void> {
    if (this.statusValue !== 'idle') throw new Error(`plugin ${this.name} cannot start from status ${this.statusValue}`);
    this.statusValue = 'starting';
    const { manifest, pluginDir } = this.options;
    let realDir: string;
    let entry: string;
    try {
      realDir = await realpath(pluginDir);
      entry = await resolveInside(realDir, manifest.main);
    } catch (error) {
      this.statusValue = 'crashed';
      throw error;
    }
    const execArgv = this.options.sandboxFs !== false ? ['--permission', `--allow-fs-read=${realDir}`] : [];
    const channel = this.options.launcher.launch(entry, {
      cwd: realDir,
      env: { CMH_PLUGIN_NAME: manifest.name },
      execArgv,
      serviceName: `cmh-plugin-${manifest.name}`,
    });
    this.channel = channel;
    const rpc = new RpcEndpoint({
      send: (message) => channel.send(message),
      methods: this.hostMethods(),
      defaultTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      onProtocolError: (message) => this.options.onLog?.(this.name, 'warn', `rpc: ${message}`),
    });
    this.rpc = rpc;
    this.exitPromise = new Promise<void>((resolveExit) => {
      channel.onExit((code) => {
        const expected = this.statusValue === 'stopping';
        this.statusValue = expected ? 'stopped' : 'crashed';
        rpc.close(new RpcError(RPC_ERROR.processExited, `plugin process exited (code ${code ?? 'unknown'})`));
        for (const listener of this.exitListeners) listener({ code, expected });
        resolveExit();
      });
    });
    channel.onMessage((message) => rpc.handleMessage(message));
    try {
      await rpc.request('activate', { name: manifest.name, version: manifest.version }, this.options.startTimeoutMs ?? 10_000);
    } catch (error) {
      // 활성화 실패 = 프로세스를 거두고 crashed. 'exit' 가 와도 expected=false 로 알린다.
      if (this.statusValue === 'starting') channel.kill();
      await this.exitPromise;
      throw error;
    }
    if (this.statusValue === 'starting') this.statusValue = 'running';
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.rpc || this.statusValue !== 'running') return Promise.reject(new Error(`plugin ${this.name} is not running (${this.statusValue})`));
    return timeoutMs === undefined ? this.rpc.request(method, params) : this.rpc.request(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (this.statusValue === 'running') this.rpc?.notify(method, params);
  }

  async stop(): Promise<void> {
    if (this.statusValue !== 'running' && this.statusValue !== 'starting') return;
    const rpc = this.rpc;
    const channel = this.channel;
    this.statusValue = 'stopping';
    if (rpc) {
      try {
        await rpc.request('deactivate', undefined, this.options.stopTimeoutMs ?? 2_000);
      } catch {
        // 답이 없거나 이미 죽었어도 아래에서 거둔다
      }
    }
    channel?.kill();
    await this.exitPromise;
  }

  private hostMethods(): Record<string, RpcMethodHandler> {
    const guard = (method: string, entity: string, operation: EntityOperation): void => {
      const decision = checkEntityAccess(this.options.manifest.permissions, entity, operation);
      if (decision.allowed) return;
      this.options.onPermissionDenied?.({ plugin: this.name, method, entity, operation, reason: decision.reason });
      throw new RpcError(RPC_ERROR.permissionDenied, `permission denied: ${decision.reason}`);
    };
    const data = (): PluginDataAccess => {
      if (!this.options.data) throw new RpcError(RPC_ERROR.internal, 'no data source attached');
      return this.options.data;
    };
    return {
      'repository.search': (params) => {
        const { entity, params: p } = readEntity(params);
        guard('repository.search', entity, 'read');
        return data().search(entity, p['criteria'] ?? {});
      },
      'repository.get': (params) => {
        const { entity, params: p } = readEntity(params);
        if (typeof p['id'] !== 'string') throw invalidParams('params.id must be a string');
        guard('repository.get', entity, 'read');
        return data().get(entity, p['id']);
      },
      'repository.upsert': (params) => {
        const { entity, params: p } = readEntity(params);
        if (!Array.isArray(p['rows'])) throw invalidParams('params.rows must be an array');
        guard('repository.upsert', entity, 'write');
        return data().upsert(entity, p['rows']);
      },
      'repository.delete': (params) => {
        const { entity, params: p } = readEntity(params);
        if (!isStringArray(p['ids'])) throw invalidParams('params.ids must be an array of strings');
        guard('repository.delete', entity, 'write');
        return data().delete(entity, p['ids']);
      },
      log: (params) => {
        if (!isObject(params)) return null;
        const level = params['level'] === 'warn' || params['level'] === 'error' ? params['level'] : 'info';
        const message = typeof params['message'] === 'string' ? params['message'].slice(0, MAX_LOG_LENGTH) : '';
        this.options.onLog?.(this.name, level, message);
        return null;
      },
    };
  }
}

export interface ProcessRuntimeFactoryOptions extends Omit<PluginProcessOptions, 'manifest' | 'pluginDir'> {
  /** 주면 contributes.subscribers 의 이벤트를 플러그인에 'event' 알림으로 넘긴다(주인 = 플러그인 이름 → 내릴 때 레지스트리가 풀어 준다) */
  readonly bus?: EventBus;
}

/** PluginRegistry 에 꽂는 실제 프로세스 런타임 */
export function createProcessRuntimeFactory(options: ProcessRuntimeFactoryOptions): PluginRuntimeFactory {
  return ({ manifest, pluginDir }) => {
    const child = new PluginProcess({ ...options, manifest, pluginDir });
    const runtime: PluginRuntime & { readonly process: PluginProcess } = {
      process: child,
      async start() {
        await child.start();
        const bus = options.bus;
        if (!bus) return;
        for (const { event } of manifest.contributes.subscribers) {
          bus.on(event, (payload) => child.notify('event', { event, payload }), manifest.name);
        }
      },
      stop: () => child.stop(),
      onExit: (listener) => child.onExit(listener),
    };
    return runtime;
  };
}
