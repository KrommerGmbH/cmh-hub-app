// R1 — SQLite 열기(better-sqlite3 · 동기 API → main 밖 utilityProcess 에서 돌린다 · 합의안 권고)
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

export const MEMORY_DATABASE = ':memory:';

export interface SqliteHandle {
  readonly filename: string;
  readonly database: Database.Database;
  readonly db: Kysely<any>;
}

export function openSqliteDatabase(filename: string): SqliteHandle {
  const database = new Database(filename);
  try {
    // 파일 DB 는 WAL(PLAN R1 §9) · 메모리 DB 는 WAL 이 없다
    // SQLite 가 아닌 파일(SQLITE_NOTADB)은 new Database 가 아니라 여기 첫 pragma 에서 터진다
    if (filename !== MEMORY_DATABASE) database.pragma('journal_mode = WAL');
    // SQLite 는 기본으로 FK 를 안 본다 — 서버 ON DELETE CASCADE 와 맞추려면 켠다
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
  } catch (e) {
    // 열린 파일 핸들을 남기지 않는다(파일은 건드리지 않는다)
    database.close();
    throw e;
  }
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database }) });
  return { filename, database, db };
}
