// R1 — 마이그레이션 전에 DB 파일 사본 · 실패하면 사본으로 되돌림(합의안 권고 · research/06 S7 · 2026-10-07)
// 파일 DB 일 때만. 처음 만든 파일이면 «사본» = 파일 없음 → 실패하면 파일을 지운다.
// 2026-10-07 검수 B1 — 사본은 임시 이름에 만들고 «다 만든 뒤에만» rename 으로 제 이름을 준다. 사본 만들기가 실패하면
// 원본은 손대지 않고 마이그레이션도 돌리지 않는다(반쯤 쓴 사본으로 원본을 덮던 문제).
// 2026-10-07 검수 6 — S4: 깨진 파일(SQLITE_NOTADB · SQLITE_CORRUPT*)은 CorruptDatabaseError(파일은 지우지도 덮지도 않는다) ·
// S3: 끊긴 실행이 남긴 임시 파일(*.pre-migration.bak.tmp-* · *.restore-*)을 열 때 치운다 · N6: 메시지에는 파일 이름만.
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
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

/** SQLite 가 «DB 파일이 아니다 · 깨졌다»로 답한 오류 코드인가(better-sqlite3 SqliteError.code) */
function corruptCodeOf(e: unknown): string | null {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return null;
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT') ? code : null;
}

/**
 * DB 파일이 SQLite 가 아니거나 깨졌다(열기 · 첫 읽기에서). 파일은 지우지도 덮지도 않는다 — 사람이 고른다(사본으로 되돌리기 · 폴더 열기 · 종료).
 * backupPath = 앞선 판 올림 때 남은 `.pre-migration.bak` 이 있으면 그 전체 경로(메시지에는 파일 이름만).
 */
export class CorruptDatabaseError extends Error {
  override readonly name = 'CorruptDatabaseError';
  constructor(
    message: string,
    readonly sqliteCode: string,
    readonly backupPath: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function existingBackupOf(filename: string): string | null {
  const path = backupPathFor(filename);
  try {
    return existsSync(path) && statSync(path).size > 0 ? path : null;
  } catch {
    return null;
  }
}

function corruptError(filename: string, code: string, e: unknown): CorruptDatabaseError {
  const backup = existingBackupOf(filename);
  const note = backup ? ` — 앞선 사본(${basename(backup)})이 있다` : ' — 앞선 사본은 없다';
  const message = `DB 파일(${basename(filename)})이 SQLite 가 아니거나 깨졌다(${code}: ${messageOf(e)}) · 파일은 그대로 두었다${note}`;
  return new CorruptDatabaseError(withoutDir(message, filename), code, backup, { cause: e });
}

/** pid 가 살아 있나(EPERM = 있지만 남의 것 → 산 것으로 본다) */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown }).code === 'EPERM';
  }
}

/**
 * 끊긴 실행(사본 · 되돌리기 도중 죽음 · 강제 종료)이 남긴 임시 파일을 지운다 — `<파일>.pre-migration.bak.tmp-<pid>-<ms>` · `<파일>.restore-<pid>-<ms>`.
 * 이름의 pid 가 지금 살아 있는 남의 프로세스면 그 프로세스가 쓰는 중일 수 있어 남긴다. 치우기 실패는 열기를 막지 않는다.
 */
function removeStaleTempFiles(filename: string): void {
  const dir = dirname(filename);
  const prefixes = [`${basename(backupPathFor(filename))}.tmp-`, `${basename(filename)}.restore-`];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const match = /^(\d+)-\d+$/.exec(name.slice(prefix.length));
    if (!match) continue; // 우리가 만든 꼴이 아니면 손대지 않는다
    const pid = Number(match[1]);
    if (pid !== process.pid && isProcessAlive(pid)) continue;
    removeQuietly(join(dir, name));
  }
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

/** 메시지 안 «DB 폴더 경로»를 뗀다 — fs 오류(ENOENT · EACCES …) 문장에는 전체 경로가 들어 있다(N6) */
function withoutDir(message: string, filename: string): string {
  const dir = dirname(filename);
  return dir === '.' || dir === '' ? message : message.split(`${dir}${sep}`).join('');
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
  if (isFile) removeStaleTempFiles(filename);
  let handle: SqliteHandle;
  try {
    handle = openSqliteDatabase(filename);
  } catch (e) {
    const code = corruptCodeOf(e);
    if (isFile && code) throw corruptError(filename, code, e);
    throw e;
  }
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
    // 깨진 파일이 첫 읽기(pending 조회)에서 드러났다 — 사본도 마이그레이션도 아직 없다 · 파일은 그대로
    const corruptCode = stage === 'check' ? corruptCodeOf(e) : null;
    if (isFile && existedBefore && corruptCode) throw corruptError(filename, corruptCode, e);
    let note = '';
    if (isFile && backupPath) {
      try {
        restoreFromBackup(filename, backupPath);
        note = ` — 사본(${basename(backupPath)})으로 되돌렸다`;
      } catch (restoreError) {
        note = ` — 사본(${basename(backupPath)})으로 되돌리기도 실패했다(${messageOf(restoreError)}) · 사본은 남아 있다`;
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
    throw new MigrationError(withoutDir(`${base}${note}`, filename), e instanceof MigrationError ? e.migrationClass : null, { cause: e, backupPath });
  }
}
