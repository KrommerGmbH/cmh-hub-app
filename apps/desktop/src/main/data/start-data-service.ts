// R1 앱 연결 — main.ts 에서 부르는 한 줄짜리 연결(electron 을 쓴다 · 시험은 data-service.test.ts 가 DataService 를 바로 본다).
// 앱 준비 뒤 띄우고, 실패해도 창은 뜬다(로그 + console.error → app-logger 가 H05 오류 보고 줄에 넣는다 · 까닭 번호는 getDataService().lastFailure).
// 아직 화면에서 부르는 곳은 없다 — 연결만(getDataService 로 꺼낸다).
// ⚠ PLAN R1 §9 는 «마이그레이션 실패면 앱을 띄우지 않고 오류 창» — 이번 차례 지시는 «실패해도 창은 뜬다»라 그쪽을 따랐다(오류 창은 화면이 생길 때).

import { basename, join } from 'node:path';
import { app } from 'electron';
import { ElectronProcessLauncher } from '../plugin/electron-process-launcher.js';
import { DataService } from './data-service.js';

/** userData 안 SQLite 파일 이름(PLAN R1 §9) */
export const DATA_FILE_NAME = 'cmh-hub.sqlite';

const TAG = '[data]';
let service: DataService | null = null;

export function getDataService(): DataService | null {
  return service;
}

export function startDataService(): DataService {
  if (service) return service;
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
    onStateChange: (state, detail) => console.info(`${TAG} state ${state}${detail ? ` (${detail})` : ''}`),
  });
  service = created;
  created.start().then(
    (open) => console.info(`${TAG} DataService ready · pid ${created.pid ?? '?'} · ${basename(open.filename)} · migrations ${open.updated.length + open.destructive.length}`),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 띄우는 사이 앱이 끝나는 중(stop) — 오류가 아니다(검수 6 N4 · error 줄은 서버 오류 보고로 간다)
      if (created.state === 'stopping' || created.state === 'stopped') {
        console.info(`${TAG} DataService start cancelled by shutdown`, message);
        return;
      }
      // 메시지에는 파일 이름만 있다(자료층이 전체 경로를 뗀다 · 전체 경로는 created.lastFailure.data 에만 · 검수 6 N6)
      console.error(`${TAG} DataService failed to start — app continues without local data`, message);
    },
  );

  // 내리기: will-quit 에서만 stop() 을 시작한다(검수 6 S2 — before-quit 은 다른 리스너가 quit 을 취소할 수 있어, 거기서 내리면 자료층이 죽은 채 앱이 산다).
  // 안 끝났으면 한 번만 막고 기다린 뒤 app.exit — app.quit() 을 다시 부르면 before-quit 이 다시 돌아 다른 정리(engine.dispose 등)가 두 번 불린다.
  let stopping: Promise<void> | null = null;
  let stopped = false;
  app.on('will-quit', (event) => {
    if (stopped) return;
    stopping ??= created.stop().finally(() => {
      stopped = true;
    });
    event.preventDefault();
    void stopping.finally(() => app.exit(0));
  });
  return created;
}
