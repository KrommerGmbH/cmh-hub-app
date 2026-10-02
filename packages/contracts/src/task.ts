// W01 · W02 · 서버 T44 — 작업 큐 JSON
export type TaskKind = 'naver-browser' | 'price-crawl';

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  title: string;
  leaseSeconds: number;
  /** kind 마다 다른 JSON — 앱은 해석하지 않고 실행기에 넘긴다 */
  payload: Record<string, unknown>;
}

export interface TaskNextRequest {
  capabilities: TaskKind[];
}

export interface TaskNextResponse {
  task: TaskRecord | null;
}

export type TaskErrorCode = 'login-required' | 'selector-missing' | 'crawl-blocked' | 'timeout' | 'stopped' | 'unknown';

export interface TaskDoneRequest {
  taskId: string;
  status: 'done' | 'failed';
  result: Record<string, unknown>;
  error?: { code: TaskErrorCode; message: string };
}

export interface TaskReleaseRequest {
  taskId: string;
  reason: TaskErrorCode;
}

/** U07 ⑥ — 드라이버 명령(서버 payload 를 그대로 옮긴 꼴) */
export type DriverStep =
  | { op: 'goto'; url: string }
  | { op: 'click'; elementKey: string }
  | { op: 'type'; elementKey: string; text: string; clear?: boolean }
  | { op: 'read'; elementKey: string }
  | { op: 'waitNetwork'; endpointKey: string; timeoutMs?: number };
