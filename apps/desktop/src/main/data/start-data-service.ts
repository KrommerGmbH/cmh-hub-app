// R1 앱 연결 — main.ts 에서 부르는 한 줄짜리 연결(electron 을 쓴다 · 시험은 data-service.test.ts 가 DataService 를 바로 본다).
// 앱 준비 뒤 띄우고, 실패해도 창은 뜬다(로그 + console.error → app-logger 가 H05 오류 보고 줄에 넣는다 · 까닭 번호는 getDataService().lastFailure).
// 아직 화면에서 부르는 곳은 없다 — 연결만(getDataService 로 꺼낸다).
// ⚠ PLAN R1 §9 는 «마이그레이션 실패면 앱을 띄우지 않고 오류 창» — 이번 차례 지시는 «실패해도 창은 뜬다»라 그쪽을 따랐다(오류 창은 화면이 생길 때).

import { basename, join } from 'node:path';
import { app } from 'electron';
import { ElectronProcessLauncher } from '../plugin/electron-process-launcher.js';
import { DataService, type DataServiceState } from './data-service.js';

/** userData 안 SQLite 파일 이름(PLAN R1 §9) */
export const DATA_FILE_NAME = 'cmh-hub.sqlite';

const TAG = '[data]';
let service: DataService | null = null;
let startedPromise: Promise<boolean> | null = null;

export function getDataService(): DataService | null {
  return service;
}

export interface StartDataServiceOptions {
  /**
   * R7-c — will-quit 에서 자료층을 내리기 «전에» 할 일(플러그인 화면 → 플러그인 레지스트리를 내린다 · app-services.ts).
   * 끝날 때까지 기다린 뒤 stop() 한다. 던지거나 거부돼도 stop 은 한다(로그만).
   */
  readonly beforeStop?: () => Promise<void>;
  /** R7-c — 자료층 상태가 바뀔 때(로그 뒤에 부른다 · 던져도 자료층은 모른다). app-services.ts 가 설정 다시 열기에 쓴다 */
  readonly onStateChange?: (state: DataServiceState, detail: string | null) => void;
}

/** R7-c — 띄운 자료 서비스와 «처음 띄우기가 끝났나»(running 이면 true · 실패 · 내리는 중 취소면 false · 거부하지 않는다) */
export interface StartedDataService {
  readonly service: DataService;
  readonly started: Promise<boolean>;
}

/**
 * 【AI 임시 결정】(검수 10 🟢6) 두 번째 부름 — 옵션 없이 부르면 처음 것을 돌려준다 · beforeStop · onStateChange 를 주면 예외.
 * 처음 띄울 때 will-quit 리스너를 한 번만 걸었으므로 두 번째 옵션은 쓸 곳이 없다 — 조용히 버리지 않고(그 정리가 안 돌면 자료층이 먼저 내려간다) 던진다.
 */
export function startDataService(options: StartDataServiceOptions = {}): StartedDataService {
  if (service && startedPromise) {
    if (options.beforeStop !== undefined || options.onStateChange !== undefined) {
      throw new Error('startDataService: already started — beforeStop / onStateChange of a second call would be ignored');
    }
    return { service, started: startedPromise };
  }
  const filename = join(app.getPath('userData'), DATA_FILE_NAME);
  // ⏸ ⑫ 결정 뒤 server — 지금은 dataSource 'local' 고정(자식 data-worker-core.ts 가 정한다 · R9 전환 없음)
  const created = new DataService({
    filename,
    launcher: new ElectronProcessLauncher(),
    onLog: (level, message) => {
      const line = `${TAG} ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.info(line);
    },
    onStateChange: (state, detail) => {
      console.info(`${TAG} state ${state}${detail ? ` (${detail})` : ''}`);
      try {
        options.onStateChange?.(state, detail);
      } catch (error) {
        console.error(`${TAG} onStateChange listener failed`, error);
      }
    },
  });
  service = created;
  const started = created.start().then(
    (open) => {
      console.info(`${TAG} DataService ready · pid ${created.pid ?? '?'} · ${basename(open.filename)} · migrations ${open.updated.length + open.destructive.length}`);
      return true;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 띄우는 사이 앱이 끝나는 중(stop) — 오류가 아니다(검수 6 N4 · error 줄은 서버 오류 보고로 간다)
      if (created.state === 'stopping' || created.state === 'stopped') {
        console.info(`${TAG} DataService start cancelled by shutdown`, message);
        return false;
      }
      // 메시지에는 파일 이름만 있다(자료층이 전체 경로를 뗀다 · 전체 경로는 created.lastFailure.data 에만 · 검수 6 N6)
      console.error(`${TAG} DataService failed to start — app continues without local data`, message);
      return false;
    },
  );
  startedPromise = started;

  // 내리기: will-quit 에서만 stop() 을 시작한다(검수 6 S2 — before-quit 은 다른 리스너가 quit 을 취소할 수 있어, 거기서 내리면 자료층이 죽은 채 앱이 산다).
  app.on(
    'will-quit',
    createWillQuitHandler({
      ...(options.beforeStop ? { beforeStop: options.beforeStop } : {}),
      stop: () => created.stop(),
      exit: () => app.exit(0),
    }),
  );
  return { service: created, started };
}

export interface WillQuitHandlerOptions {
  readonly beforeStop?: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly exit: () => void;
  readonly logError?: (message: string, error: unknown) => void;
}

/**
 * will-quit 리스너(시험할 수 있게 뗐다). 차례: beforeStop(플러그인 → 설정 쓰기 끝) → stop(자료층) → exit.
 * 안 끝났으면 막고(preventDefault) 기다린 뒤 exit — app.quit() 을 다시 부르면 before-quit 이 다시 돌아 다른 정리(engine.dispose 등)가 두 번 불린다.
 * beforeStop 이 던지거나 거부돼도 stop 은 한다 · stop 이 거부돼도 exit 은 한다.
 * 검수 10 🟢1 — will-quit 이 두 번 와도(내리는 중 또 quit) exit 은 한 번만 건다(exitScheduled).
 */
export function createWillQuitHandler(options: WillQuitHandlerOptions): (event: { preventDefault(): void }) => void {
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(`${TAG} ${message}`, error));
  let stopping: Promise<void> | null = null;
  let stopped = false;
  let exitScheduled = false;
  return (event) => {
    if (stopped) return;
    const beforeStop = options.beforeStop;
    stopping ??= Promise.resolve()
      .then(() => beforeStop?.())
      .catch((error: unknown) => logError('beforeStop failed — stopping data service anyway', error))
      .then(() => options.stop())
      .catch((error: unknown) => logError('data service stop failed — exiting anyway', error))
      .finally(() => {
        stopped = true;
      });
    event.preventDefault();
    if (exitScheduled) return;
    exitScheduled = true;
    void stopping.finally(() => options.exit());
  };
}
