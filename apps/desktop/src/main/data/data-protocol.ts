// R1 앱 연결 — main(DataService) ↔ 자료 프로세스(data-worker) 사이 JSON-RPC 약속(메서드 이름 · 오류 번호 · 칸 꼴).
// electron · better-sqlite3 를 import 하지 않는 순수 모듈(양쪽이 같이 쓴다). RPC 자체는 플러그인 것(../plugin/plugin-rpc.ts)을 그대로 쓴다.
//
// 권한(검수 합의):
//   · 읽기(repo.search · searchIds · get · aggregate)는 늘 scope 'api' — 비밀칸(apiAware false)은 결과에서 빠지고 거르기 · 정렬에 쓰면 오류.
//     scope 는 RPC 로 받지 않는다(params.scope · params.options.scope 가 있으면 invalidParams).
//   · 쓰기(repo.upsert · repo.delete)는 쓰기 보호 엔티티(cmh_ai_approval · settings/approval-entity.ts)면 늘 거부(합의안 5 — 승인 상태 쓰기는 main UI IPC 만).
//   · 비밀칸 읽기는 secrets.read 하나 — 자식은 «비밀칸인지»만 보고, 누가 불러도 되는지는 main(DataService 허용 목록)이 막는다.
//   · open · shutdown · secrets.read 는 DataService 안에서만 보낸다 — 공개 call() 은 DATA_PUBLIC_METHODS(repo.* · health)만(검수 6 B1).

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

/** DataService.call() 로 보낼 수 있는 메서드 — repo.* 와 health 만. open · shutdown · secrets.read 는 DataService 안쪽 길로만(검수 6 B1) */
export const DATA_PUBLIC_METHODS: ReadonlySet<string> = new Set<string>([
  DATA_METHOD.health,
  DATA_METHOD.search,
  DATA_METHOD.searchIds,
  DATA_METHOD.get,
  DATA_METHOD.aggregate,
  DATA_METHOD.upsert,
  DATA_METHOD.delete,
]);

export const DATA_RPC_ERROR = {
  ...RPC_ERROR,
  /** DB 열기 · 마이그레이션 실패 · 쓰기 보호 엔티티 FK 검사 실패 — data 는 DataOpenErrorData(reason · backupPath) */
  openFailed: -32010,
  /** 쓰기 실패(DataWriteError · ValueError · 제약 위반) */
  writeFailed: -32011,
  /** 자료 프로세스를 쓸 수 없음(시작 전 · 오류 상태 · 멈춤) — main 쪽에서 만든다 */
  unavailable: -32012,
  /** DB 가 아직 안 열렸다(open 전 요청) */
  notOpen: -32013,
  /**
   * DB 파일이 SQLite 가 아니거나 깨졌다(SQLITE_NOTADB · SQLITE_CORRUPT*) — 파일은 지우지도 덮지도 않았다.
   * 화면이 «사본으로 되돌리기(data.backupPath) · 폴더 열기 · 종료»를 고르게 한다(검수 6 S4 · 화면은 아직 없다).
   */
  corruptDatabase: -32014,
} as const;

/** open 실패 까닭(DataOpenErrorData.reason) */
export type DataOpenFailureReason = 'corruptDatabase' | 'migrationFailed' | 'protectedEntityCascade' | 'openFailed';

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

/**
 * open 실패(openFailed · corruptDatabase) 의 data. 전체 경로는 이 칸에만 둔다 — 메시지 · 로그에는 파일 이름만(warn · error 는 서버 오류 보고로 간다 · 검수 6 N6).
 */
export interface DataOpenErrorData extends DataErrorData {
  readonly reason: DataOpenFailureReason;
  /** 마이그레이션 전 사본(`<파일>.pre-migration.bak`) 전체 경로 · 없으면 null */
  readonly backupPath: string | null;
  /** corruptDatabase 일 때 SQLite 오류 코드(SQLITE_NOTADB …) */
  readonly sqliteCode?: string;
}
