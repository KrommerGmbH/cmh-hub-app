// R1 — 마이그레이션 전에 DB 파일 사본 · 실패하면 사본으로 되돌림(합의안 권고 · research/06 S7 · 2026-10-07)
// 파일 DB 일 때만. 처음 만든 파일이면 «사본» = 파일 없음 → 실패하면 파일을 지운다.
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
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

/** 열고 · (돌릴 것이 있으면) 사본 → 마이그레이션. 실패하면 닫고 되돌린 뒤 MigrationError 를 던진다 */
export async function migrateWithBackup(options: MigrateWithBackupOptions): Promise<MigrateWithBackupResult> {
  const { filename } = options;
  const isFile = filename !== MEMORY_DATABASE && filename !== '';
  const existedBefore = isFile && existsSync(filename) && statSync(filename).size > 0;
  const handle = openSqliteDatabase(filename);
  const runner = new MigrationRunner(handle.db, options.migrations);
  const runOptions = options.destructive === undefined ? {} : { destructive: options.destructive };

  let backupPath: string | null = null;
  try {
    const pending = await runner.pending(runOptions);
    if (isFile && existedBefore && pending.update.length + pending.destructive.length > 0) {
      backupPath = backupPathFor(filename);
      rmSync(backupPath, { force: true });
      // better-sqlite3 온라인 백업 — WAL 에 있는 것까지 한 파일로
      await handle.database.backup(backupPath);
    }
    const result = await runner.migrate(runOptions);
    return { handle, result, backupPath };
  } catch (e) {
    await handle.db.destroy().catch(() => undefined);
    // 닫으면 WAL 이 본 파일로 합쳐진다 — 되돌릴 때만 곁 파일(-wal · -shm)을 지운다
    if (isFile && backupPath) {
      removeSidecars(filename);
      copyFileSync(backupPath, filename);
    } else if (isFile && !existedBefore) {
      removeSidecars(filename);
      rmSync(filename, { force: true });
    }
    if (e instanceof MigrationError) {
      throw new MigrationError(`${e.message}${isFile ? (backupPath ? ` — 사본(${backupPath})으로 되돌렸다` : existedBefore ? '' : ' — 새로 만든 파일을 지웠다') : ''}`, e.migrationClass, { cause: e });
    }
    throw e;
  }
}
