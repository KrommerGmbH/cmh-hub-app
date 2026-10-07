// R2-a — 플러그인 프로세스를 띄우는 얇은 어댑터. PluginProcess 는 이 인터페이스만 본다.
//   앱(main)  : electron-process-launcher.ts — Electron `utilityProcess.fork()` (Node + parentPort)
//   시험(vitest): 여기 NodeProcessLauncher — Node `child_process.fork()` (IPC 채널)
// 플러그인 쪽은 `process.parentPort`(Electron) 가 있으면 그것을, 없으면 `process.send`(Node) 를 쓴다(examples/plugin-hello/main.mjs).
// 이 파일은 electron 을 import 하지 않는다.

import { fork } from 'node:child_process';

export interface LaunchOptions {
  /** 플러그인 폴더 — 자식의 cwd */
  readonly cwd: string;
  /** 자식 환경변수. 부모 env 를 통째로 물려주지 않는다(비밀값 새는 길 차단) */
  readonly env: Readonly<Record<string, string>>;
  /** 예 ['--permission', '--allow-fs-read=<플러그인 폴더>'] (S2) */
  readonly execArgv: readonly string[];
  /** 프로세스 관리자에 보일 이름(Electron serviceName) */
  readonly serviceName: string;
}

export interface PluginChannel {
  readonly pid: number | undefined;
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** 한 번만 부른다 · code 는 모르면 null */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface ProcessLauncher {
  launch(modulePath: string, options: LaunchOptions): PluginChannel;
}

/**
 * execArgv 를 NODE_OPTIONS 글자로 바꾼다. 값은 큰따옴표로 감싸고 그 안의 역슬래시 · 큰따옴표는 앞에 역슬래시를 붙여 막는다
 * (Node `ParseNodeOptionsEnvVar` 규칙 — 따옴표 안 역슬래시는 다음 글자를 그대로). Windows 경로 · 빈칸 있는 사용자 이름 대비.
 */
export function toNodeOptions(execArgv: readonly string[]): string {
  return execArgv
    .map((arg) => {
      const eq = arg.indexOf('=');
      if (eq < 0) return arg;
      const value = arg.slice(eq + 1).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${arg.slice(0, eq)}="${value}"`;
    })
    .join(' ');
}

export interface NodeProcessLauncherOptions {
  /** true 면 execArgv 를 NODE_OPTIONS 로 넘긴다(ElectronProcessLauncher 와 같은 길 — 시험용) */
  readonly viaNodeOptions?: boolean;
}

export class NodeProcessLauncher implements ProcessLauncher {
  constructor(private readonly launcherOptions: NodeProcessLauncherOptions = {}) {}

  launch(modulePath: string, options: LaunchOptions): PluginChannel {
    const viaEnv = this.launcherOptions.viaNodeOptions === true && options.execArgv.length > 0;
    const child = fork(modulePath, [], {
      cwd: options.cwd,
      env: { ...options.env, ...(viaEnv ? { NODE_OPTIONS: toNodeOptions(options.execArgv) } : {}) },
      execArgv: viaEnv ? [] : [...options.execArgv],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    const exitListeners: ((code: number | null) => void)[] = [];
    let exited = false;
    const finish = (code: number | null): void => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code);
    };
    child.on('exit', (code) => finish(code));
    child.on('error', () => finish(null));
    return {
      get pid() {
        return child.pid;
      },
      send(message) {
        if (!child.connected) throw new Error('plugin process is not connected');
        child.send(message as Parameters<typeof child.send>[0]);
      },
      onMessage(listener) {
        child.on('message', (message) => listener(message));
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
      kill() {
        child.kill();
      },
    };
  }
}
