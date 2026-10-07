// R1 — 마이그레이션 전에 DB 파일 사본 · 실패하면 사본으로 되돌림(합의안 권고 · research/06 S7 · 2026-10-07)
// 파일 DB 일 때만. 처음 만든 파일이면 «사본» = 파일 없음 → 실패하면 파일을 지운다.
// 2026-10-07 검수 B1 — 사본은 임시 이름에 만들고 «다 만든 뒤에만» rename 으로 제 이름을 준다. 사본 만들기가 실패하면
// 원본은 손대지 않고 마이그레이션도 돌리지 않는다(반쯤 쓴 사본으로 원본을 덮던 문제).
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { MEMORY_DATABASE, openSqliteDatabase, type SqliteHandle } from '../driver/sqlite/sqlite-database.js';
import type { Migration } from './migration.js';
import { MigrationError, MigrationRunner, type MigrationRunResult } from './migration-runner.js';

export interface MigrateWithBackupOptions {
  readonly filename: string;
  readonly migrations: readonly Migration[];
  readonly destructive?: boolean;
}

export interface MigrateWithBackupResult {
  readonly handle: SqliteHandle;
  readonly result: MigrationRunResult;
  /** 사본을 만들었으면 그 경로(성공해도 남겨 둔다 — 다음 판 올림 때 덮어쓴다) */
  readonly backupPath: string | null;
}

export function backupPathFor(filename: string): string {
  return `${filename}.pre-migration.bak`;
}

function removeSidecars(filename: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(`${filename}${suffix}`, { force: true });
}

/** 치우기 실패는 원래 오류를 가리지 않는다 */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 남은 임시 파일은 다음 실행에서도 해가 없다(제 이름이 아니다)
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tempNameFor(path: string, tag: string): string {
  return `${path}.${tag}-${process.pid}-${Date.now()}`;
}

/** 사본을 임시 이름에 끝까지 만든 뒤에만 제 이름으로(rename). 실패하면 임시 파일만 지우고 예외 — 원본 · 옛 사본은 그대로 */
async function makeBackup(handle: SqliteHandle, backupPath: string): Promise<void> {
  const tmp = tempNameFor(backupPath, 'tmp');
  try {
    // better-sqlite3 온라인 백업 — WAL 에 있는 것까지 한 파일로
    await handle.database.backup(tmp);
    renameSync(tmp, backupPath);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
}

/** 사본 → 원본. 임시 이름에 복사한 뒤 rename — 복사 도중 죽어도 원본 자리에 반쪽 파일이 남지 않는다 */
function restoreFromBackup(filename: string, backupPath: string): void {
  const tmp = tempNameFor(filename, 'restore');
  try {
    copyFileSync(backupPath, tmp);
    // 닫으면 WAL 이 본 파일로 합쳐진다 — 되돌릴 때만 곁 파일(-wal · -shm)을 지운다
    removeSidecars(filename);
    renameSync(tmp, filename);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
}

/**
 * 열고 · (돌릴 것이 있으면) 사본 → 마이그레이션. 실패하면 닫고 되돌린 뒤 MigrationError 를 던진다(원래 오류는 cause).
 * 되돌리기는 «다 만든 사본»이 있을 때만 한다. 사본 만들기가 실패하면 마이그레이션을 돌리지 않고 원본도 건드리지 않는다.
 */
export async function migrateWithBackup(options: MigrateWithBackupOptions): Promise<MigrateWithBackupResult> {
  const { filename } = options;
  const isFile = filename !== MEMORY_DATABASE && filename !== '';
  const existedBefore = isFile && existsSync(filename) && statSync(filename).size > 0;
  const handle = openSqliteDatabase(filename);
  const runner = new MigrationRunner(handle.db, options.migrations);
  const runOptions = options.destructive === undefined ? {} : { destructive: options.destructive };

  /** rename 까지 끝난 사본 — 이것이 있을 때만 되돌린다 */
  let backupPath: string | null = null;
  let stage: 'check' | 'backup' | 'migrate' = 'check';
  try {
    const pending = await runner.pending(runOptions);
    if (isFile && existedBefore && pending.update.length + pending.destructive.length > 0) {
      stage = 'backup';
      const target = backupPathFor(filename);
      await makeBackup(handle, target);
      backupPath = target;
    }
    stage = 'migrate';
    const result = await runner.migrate(runOptions);
    return { handle, result, backupPath };
  } catch (e) {
    await handle.db.destroy().catch(() => undefined);
    let note = '';
    if (isFile && backupPath) {
      try {
        restoreFromBackup(filename, backupPath);
        note = ` — 사본(${backupPath})으로 되돌렸다`;
      } catch (restoreError) {
        note = ` — 사본(${backupPath})으로 되돌리기도 실패했다(${messageOf(restoreError)}) · 사본은 남아 있다`;
      }
    } else if (isFile && !existedBefore) {
      removeSidecars(filename);
      rmSync(filename, { force: true });
      note = ' — 새로 만든 파일을 지웠다';
    } else if (stage === 'backup') {
      note = ' — 마이그레이션은 돌리지 않았고 원본은 그대로다';
    }
    const base =
      stage === 'backup'
        ? `마이그레이션 전 사본 만들기 실패: ${messageOf(e)}`
        : e instanceof MigrationError
          ? e.message
          : `마이그레이션 실패: ${messageOf(e)}`;
    throw new MigrationError(`${base}${note}`, e instanceof MigrationError ? e.migrationClass : null, { cause: e });
  }
}
