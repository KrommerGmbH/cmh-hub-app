// R1 앱 연결 — main(DataService) ↔ 자료 프로세스(data-worker) 사이 JSON-RPC 약속(메서드 이름 · 오류 번호 · 칸 꼴).
// electron · better-sqlite3 를 import 하지 않는 순수 모듈(양쪽이 같이 쓴다). RPC 자체는 플러그인 것(../plugin/plugin-rpc.ts)을 그대로 쓴다.
//
// 권한(검수 합의):
//   · 읽기(repo.search · searchIds · get · aggregate)는 늘 scope 'api' — 비밀칸(apiAware false)은 결과에서 빠지고 거르기 · 정렬에 쓰면 오류.
//     scope 는 RPC 로 받지 않는다(params.scope · params.options.scope 가 있으면 invalidParams).
//   · 쓰기(repo.upsert · repo.delete)는 쓰기 보호 엔티티(cmh_ai_approval · settings/approval-entity.ts)면 늘 거부(합의안 5 — 승인 상태 쓰기는 main UI IPC 만).
//   · 비밀칸 읽기는 secrets.read 하나 — 자식은 «비밀칸인지»만 보고, 누가 불러도 되는지는 main(DataService 허용 목록)이 막는다.

import { RPC_ERROR } from '../plugin/plugin-rpc.js';

export const DATA_METHOD = {
  /** main → 자식: DB 열기 + 마이그레이션(사본 · 되돌림) · 실패하면 오류로 답하고 자식은 끝난다 */
  open: 'open',
  /** main → 자식: DB 를 닫는다(WAL 합치기) · 답한 뒤 main 이 SIGTERM */
  shutdown: 'shutdown',
  health: 'health',
  search: 'repo.search',
  searchIds: 'repo.searchIds',
  get: 'repo.get',
  upsert: 'repo.upsert',
  delete: 'repo.delete',
  aggregate: 'repo.aggregate',
  readSecret: 'secrets.read',
} as const;

export const DATA_RPC_ERROR = {
  ...RPC_ERROR,
  /** DB 열기 · 마이그레이션 실패(깨진 파일 포함) — data.backupPath 는 모름(문장에 적힌다) */
  openFailed: -32010,
  /** 쓰기 실패(DataWriteError · ValueError · 제약 위반) */
  writeFailed: -32011,
  /** 자료 프로세스를 쓸 수 없음(시작 전 · 오류 상태 · 멈춤) — main 쪽에서 만든다 */
  unavailable: -32012,
  /** DB 가 아직 안 열렸다(open 전 요청) */
  notOpen: -32013,
} as const;

export interface OpenParams {
  readonly filename: string;
}

export interface OpenResult {
  readonly filename: string;
  /** 이번에 돈 마이그레이션 클래스 이름 */
  readonly updated: readonly string[];
  readonly destructive: readonly string[];
}

export interface HealthResult {
  readonly ok: true;
  readonly pid: number;
  readonly filename: string;
  readonly uptimeMs: number;
  readonly entities: number;
}

export interface SecretReadResult {
  /** 비밀칸 값(safeStorage 암호 blob) · 줄이나 값이 없으면 null */
  readonly value: unknown;
}

/** RPC 오류 data 에 붙이는 원래 오류 이름(CriteriaError · DataWriteError · MigrationError …) */
export interface DataErrorData {
  readonly name: string;
}
