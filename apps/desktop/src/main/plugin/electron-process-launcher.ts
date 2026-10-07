// R2-a — Electron `utilityProcess.fork()` 어댑터(앱 main 에서만 쓴다 · vitest 는 NodeProcessLauncher).
// 자식은 Node 환경 + `process.parentPort` · 부모는 `child.postMessage()` / `'message'` 이벤트(Electron 44 electron.d.ts UtilityProcess).
// utility process 가 죽어도 main 은 산다 — 'exit' 이벤트만 온다.
// ⚠ S2 실측(2026-10-07 · Electron 44.5.1 · Node 24.21.0 · Linux xvfb): `ForkOptions.execArgv` 로 준 `--permission` 은
//   자식 process.execArgv 에 보이기만 하고 권한 모델이 켜지지 않는다(process.permission 없음 · 폴더 밖 파일 읽힘).
//   같은 플래그를 env `NODE_OPTIONS` 로 주면 켜진다(밖 읽기 ERR_ACCESS_DENIED · child_process 도 막힘). 그래서 execArgv 를 NODE_OPTIONS 로 옮긴다.
//   Electron fuse `EnableNodeOptionsEnvironmentVariable` 을 끄면(배포 보안 강화 때 흔함) 이 길도 닫힌다 — 끄기 전에 다른 길을 찾아야 한다.
// kill('SIGKILL') 은 utilityProcess.kill()(신호 못 고름) 대신 `process.kill(pid,'SIGKILL')` — Electron 실측은 확인 못 함(시험은 Node 어댑터만).

import { utilityProcess } from 'electron';
import { toNodeOptions, type LaunchOptions, type PluginChannel, type ProcessLauncher } from './process-launcher.js';

export class ElectronProcessLauncher implements ProcessLauncher {
  launch(modulePath: string, options: LaunchOptions): PluginChannel {
    const child = utilityProcess.fork(modulePath, [], {
      cwd: options.cwd,
      env: { ...options.env, ...(options.execArgv.length > 0 ? { NODE_OPTIONS: toNodeOptions(options.execArgv) } : {}) },
      serviceName: options.serviceName,
      stdio: 'inherit',
    });
    const exitListeners: ((code: number | null) => void)[] = [];
    let exited = false;
    child.on('exit', (code) => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code);
    });
    return {
      get pid() {
        return child.pid;
      },
      send(message) {
        if (exited) throw new Error('plugin process has exited');
        child.postMessage(message);
      },
      onMessage(listener) {
        child.on('message', (message: unknown) => listener(message));
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
      kill(signal = 'SIGTERM') {
        if (exited) return;
        if (signal === 'SIGTERM') {
          child.kill();
          return;
        }
        // utilityProcess.kill() 은 신호를 고를 수 없다 — SIGKILL 은 pid 로 직접(Windows 는 TerminateProcess)
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 그 사이 끝났다(ESRCH)
        }
      },
    };
  }
}
