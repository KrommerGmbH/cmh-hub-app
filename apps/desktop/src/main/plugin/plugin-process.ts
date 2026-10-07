// R2-a — 플러그인 한 개 = 별도 프로세스 하나(VS Code 확장 호스트 꼴). main 은 RPC 로만 말한다.
// 활성화 = launcher.launch(main) → 'activate' 요청 → 답이 오면 running. 프로세스가 죽으면 crashed + onExit(expected=false) · 앱은 산다.
// 권한 검사는 여기(main 쪽 RPC 핸들러)에서 한다. 플러그인이 `repository.search` 같은 요청을 보내면 매니페스트 permissions 와 대조 —
//   선언 없으면 거부(-32001) · 승인 엔티티 쓰기는 늘 거부(합의안 5). 플러그인 쪽 코드는 믿지 않는다.
// electron 을 import 하지 않는다(Electron 은 ProcessLauncher 어댑터 뒤에 있다).
//
// 플러그인 → 앱 메서드: plugin-host-api.ts 의 표 하나(host:log · host:settings.get · host:data.* + R2-a 옛 이름 repository.* · log).
//   표에 없는 `host:*` 는 permissionDenied(deny by default · R2-b).
// 앱 → 플러그인: activate { name, version } · deactivate · event (알림) { event, payload } · tool:<name> (R2-b · plugin-tools.ts) · 그 밖은 플러그인이 정한 메서드(예 ping)
//
// 내리기(검수 3 차단 6): deactivate 요청(stopTimeoutMs) → SIGTERM → killTimeoutMs → SIGKILL → killTimeoutMs 만 exit 대기 → 그래도 안 끝나면 포기하고 stopped.
//   start 실패 길도 같은 차례로 거둔다. SIGTERM 을 무시하는 플러그인도 stop() 이 끝나고 고아가 남지 않는다.
// 폴더 검사(검수 3 차단 7): start 때 폴더 전체를 lstat 으로 훑어 심볼릭 링크 · 특수 파일이 하나라도 있으면 띄우지 않는다(하드링크는 경고) —
//   Node 권한 모델은 링크를 따라가서 `--allow-fs-read=<폴더>` 안의 링크로 밖을 읽을 수 있다. 레지스트리 scan · install 도 같은 검사(inspectPluginFolder).
//   ⚠ 검사와 실행 사이에 플러그인이 스스로 링크를 만들 수는 없다(쓰기 권한 없음) — 하지만 다른 프로세스가 폴더를 바꾸는 것까지는 못 막는다.
// RPC 홍수 막기: 플러그인 → 앱 동시 요청 16 · 글 한 통 1MB · log 알림 초당 20(넘친 것은 버리고 개수만 한 줄로).

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { scanFolderNoFollow, type FolderScanProblemKind } from '../util/folder-scan.js';
import type { PluginManifest } from './plugin-manifest.js';
import { createHostMethods, unknownHostMethod, type PermissionDeniedInfo, type PluginDataAccess, type PluginSettingsReader } from './plugin-host-api.js';
import type { ProcessLauncher, PluginChannel } from './process-launcher.js';
import { RPC_ERROR, RpcEndpoint, RpcError } from './plugin-rpc.js';
import type { EventBus } from './event-bus.js';
import type { PluginRuntime, PluginRuntimeFactory, PluginExitInfo } from './plugin-registry.js';

// 옛 자리에서 import 하던 쪽을 위해(정본은 plugin-host-api.ts)
export type { PermissionDeniedInfo, PluginDataAccess, PluginSettingsReader } from './plugin-host-api.js';
export { PLUGIN_LOG_PER_SECOND } from './plugin-host-api.js';

export interface PluginProcessOptions {
  readonly manifest: PluginManifest;
  /** 플러그인 폴더(절대경로) */
  readonly pluginDir: string;
  readonly launcher: ProcessLauncher;
  readonly data?: PluginDataAccess;
  /** host:settings.get 이 읽는 곳(R2-b) — 없으면 선언한 default 만 */
  readonly settings?: PluginSettingsReader;
  /** 앱 → 플러그인 요청 기본 시간초과 · 기본 10초 */
  readonly requestTimeoutMs?: number;
  /** 'activate' 답을 기다리는 시간 · 기본 10초 */
  readonly startTimeoutMs?: number;
  /** 'deactivate' 답을 기다리고 kill 하기까지 · 기본 2초 */
  readonly stopTimeoutMs?: number;
  /** SIGTERM 뒤 SIGKILL 까지 · SIGKILL 뒤 exit 를 기다리는 상한 · 기본 2초 */
  readonly killTimeoutMs?: number;
  /**
   * 기본 true — Node 권한 모델로 띄운다: `--permission --allow-fs-read=<플러그인 폴더>`(S2).
   * 실측(Electron 44.5.1 · NODE_OPTIONS 길): 폴더 밖 읽기 · 모든 쓰기 · child_process 가 ERR_ACCESS_DENIED. 네트워크는 못 막는다(Node 24 에 --allow-net 없음).
   */
  readonly sandboxFs?: boolean;
  readonly onLog?: (plugin: string, level: string, message: string) => void;
  readonly onPermissionDenied?: (info: PermissionDeniedInfo) => void;
}

export type PluginProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/** 플러그인 → 앱 동시 요청 상한 */
export const PLUGIN_MAX_CONCURRENT_REQUESTS = 16;
/** 플러그인이 보내는 글 한 통 상한(JSON 바이트) */
export const PLUGIN_MAX_MESSAGE_BYTES = 1024 * 1024;

const FOLDER_PROBLEM_TEXT: Readonly<Record<FolderScanProblemKind, string>> = {
  symlink: 'symbolic links are not allowed inside a plugin folder (the fs sandbox follows them)',
  special: 'special files (FIFO · socket · device) are not allowed inside a plugin folder',
  tooDeep: 'plugin folder is nested too deeply',
  tooMany: 'plugin folder has too many entries',
  notDirectory: 'plugin folder is not a directory',
};

/**
 * 플러그인 폴더 전체를 링크를 따라가지 않고 훑는다(scan · install · start 가 쓴다).
 * error 가 있으면 거부할 것 · warnings 는 하드링크(nlink > 1) 경고.
 */
export async function inspectPluginFolder(dir: string): Promise<{ error: string | null; warnings: string[] }> {
  let scan;
  try {
    scan = await scanFolderNoFollow(dir);
  } catch (error) {
    return { error: `cannot scan plugin folder: ${(error as Error).message}`, warnings: [] };
  }
  const warnings = scan.hardLinks.map((file) => `hard link (shares content with a file elsewhere): ${file}`);
  if (scan.problem) {
    const where = scan.problem.path === '' ? '' : ` ("${scan.problem.path}")`;
    return { error: `${FOLDER_PROBLEM_TEXT[scan.problem.kind]}${where}`, warnings };
  }
  return { error: null, warnings };
}

/** p 가 ms 안에 끝나면 true */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
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
  private stopPromise: Promise<void> | null = null;
  private exitNotified = false;

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
      const folder = await inspectPluginFolder(realDir);
      for (const warning of folder.warnings) this.options.onLog?.(this.name, 'warn', warning);
      if (folder.error) throw new Error(folder.error);
    } catch (error) {
      this.statusValue = 'crashed';
      throw error;
    }
    // 폴더를 훑는 사이 stop() 이 불렸으면 띄우지 않는다(띄우면 아무도 거두지 않는 고아가 된다)
    if (this.statusValue !== 'starting') throw new Error(`plugin ${this.name} was stopped while starting`);
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
      methods: createHostMethods({
        manifest,
        ...(this.options.data ? { data: this.options.data } : {}),
        ...(this.options.settings ? { settings: this.options.settings } : {}),
        ...(this.options.onLog ? { onLog: this.options.onLog } : {}),
        ...(this.options.onPermissionDenied ? { onPermissionDenied: this.options.onPermissionDenied } : {}),
      }),
      unknownMethod: (method) => {
        const error = unknownHostMethod(method);
        if (error) this.options.onPermissionDenied?.({ plugin: manifest.name, method: method.slice(0, 128), reason: `host method "${method.slice(0, 128)}" is not available to plugins` });
        return error;
      },
      defaultTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      maxConcurrentIncoming: PLUGIN_MAX_CONCURRENT_REQUESTS,
      maxMessageBytes: PLUGIN_MAX_MESSAGE_BYTES,
      onProtocolError: (message) => this.options.onLog?.(this.name, 'warn', `rpc: ${message}`),
    });
    this.rpc = rpc;
    this.exitPromise = new Promise<void>((resolveExit) => {
      channel.onExit((code) => {
        // stop() 이 exit 를 못 보고 포기한 뒤(stopped) 늦게 온 exit 도 예상한 종료다
        const expected = this.statusValue === 'stopping' || this.statusValue === 'stopped';
        this.statusValue = expected ? 'stopped' : 'crashed';
        rpc.close(new RpcError(RPC_ERROR.processExited, `plugin process exited (code ${code ?? 'unknown'})`));
        if (!this.exitNotified) {
          this.exitNotified = true;
          for (const listener of this.exitListeners) listener({ code, expected });
        }
        resolveExit();
      });
    });
    channel.onMessage((message) => rpc.handleMessage(message));
    try {
      await rpc.request('activate', { name: manifest.name, version: manifest.version }, this.options.startTimeoutMs ?? 10_000);
    } catch (error) {
      // 활성화 실패 = 프로세스를 거두고 crashed. 'exit' 가 와도 expected=false 로 알린다. stop() 이 이미 거두는 중이면 그것을 기다린다.
      if (this.statusValue === 'starting') {
        const gone = await this.terminate(channel);
        if (!gone && this.statusValue === 'starting') {
          this.statusValue = 'crashed';
          rpc.close(new RpcError(RPC_ERROR.processExited, 'plugin process did not exit after SIGKILL'));
        }
      } else if (this.stopPromise) {
        await this.stopPromise;
      }
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
    if (this.stopPromise) return this.stopPromise;
    if (this.statusValue !== 'running' && this.statusValue !== 'starting') return;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
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
    if (!channel) {
      this.statusValue = 'stopped';
      return;
    }
    const gone = await this.terminate(channel);
    if (!gone && this.statusValue === 'stopping') {
      // SIGKILL 뒤에도 exit 가 안 왔다(좀비 · 어댑터 문제) — 더 기다리지 않는다. 늦게 온 exit 는 expected 로 알린다.
      this.statusValue = 'stopped';
      rpc?.close(new RpcError(RPC_ERROR.processExited, 'plugin process did not exit after SIGKILL'));
      this.options.onLog?.(this.name, 'error', 'plugin process did not report exit after SIGKILL');
    }
  }

  /** SIGTERM → killTimeoutMs → SIGKILL → killTimeoutMs 만 exit 대기. exit 를 보면 true */
  private async terminate(channel: PluginChannel): Promise<boolean> {
    const exited = this.exitPromise ?? Promise.resolve();
    const killTimeoutMs = this.options.killTimeoutMs ?? 2_000;
    channel.kill('SIGTERM');
    if (await settlesWithin(exited, killTimeoutMs)) return true;
    channel.kill('SIGKILL');
    return settlesWithin(exited, killTimeoutMs);
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
      request: (method, params, timeoutMs) => child.request(method, params, timeoutMs),
    };
    return runtime;
  };
}
