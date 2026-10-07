// R1 앱 연결 — 자료 프로세스 진입 파일(자식 전용 · main 에서 import 하지 않는다).
// better-sqlite3 는 동기 API 라 main 에서 돌면 창이 멈춘다(검수 합의) → Electron utilityProcess(시험은 Node child_process.fork)에서 연다.
// 전송: Electron 은 process.parentPort(postMessage · 'message' 이벤트의 .data) · Node fork 는 process.send / 'message'.
// 차례: main 이 'open' { filename } 요청 → DataSourceFactory.create(local · 마이그레이션 사본 · 되돌림) → 답.
//   열기 실패면 오류로 답하고 스스로 끝난다(main 도 SIGTERM 으로 거둔다). 'shutdown' 이나 SIGTERM 이면 DB 를 닫고 끝난다.

import { RpcEndpoint, type RpcMessage } from '../plugin/plugin-rpc.js';
import { DataWorkerCore } from './data-worker-core.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

/** 열기 실패 답이 main 에 닿을 틈 — 그 뒤 스스로 끝난다(main 이 먼저 SIGTERM 하면 그쪽이 먼저) */
const EXIT_AFTER_OPEN_FAILURE_MS = 1_000;

const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort ?? null;

function send(message: RpcMessage): void {
  if (port) {
    port.postMessage(message);
    return;
  }
  if (!process.send) throw new Error('data worker has no parent channel');
  process.send(message);
}

let exiting = false;
const core = new DataWorkerCore({
  onOpenFailed: () => {
    setTimeout(() => process.exit(1), EXIT_AFTER_OPEN_FAILURE_MS);
  },
});

const rpc = new RpcEndpoint({
  send,
  methods: core.methods(),
  onProtocolError: (message) => console.warn(`[data-worker] rpc: ${message}`),
});

async function closeAndExit(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await core.close();
  } catch (error) {
    console.error('[data-worker] close failed', error instanceof Error ? error.message : String(error));
  }
  process.exit(code);
}

if (port) port.on('message', (event) => rpc.handleMessage(event.data));
else process.on('message', (message) => rpc.handleMessage(message));

process.on('SIGTERM', () => void closeAndExit(0));
// Node fork: 부모가 끊기면(부모 죽음) 고아로 남지 않는다. Electron 은 main 이 끝나면 utility process 를 거둔다.
process.on('disconnect', () => void closeAndExit(0));
