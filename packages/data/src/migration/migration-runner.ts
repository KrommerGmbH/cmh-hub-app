// R1 — 마이그레이션을 테이블 `migration` 에 적고 한 번만 돌린다(Shopware `migration` 테이블과 같은 칸 이름).
// 한 마이그레이션 = 한 트랜잭션(SQLite 는 DDL 도 되돌려진다) · 파일 사본 복구는 migrateWithBackup 이 맡는다.
import { sql, type Kysely } from 'kysely';
import type { Migration } from './migration.js';

export const MIGRATION_TABLE = 'migration';

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  constructor(
    message: string,
    readonly migrationClass: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface MigrationRunResult {
  updated: string[];
  destructive: string[];
}

interface MigrationRow {
  class: string;
  creation_timestamp: number;
  update: string | null;
  update_destructive: string | null;
}

export class MigrationRunner {
  private readonly migrations: Migration[];

  constructor(
    private readonly db: Kysely<any>,
    migrations: readonly Migration[],
  ) {
    const names = new Set<string>();
    for (const m of migrations) {
      if (!m.className) throw new MigrationError('마이그레이션 이름이 비었다', null);
      if (names.has(m.className)) throw new MigrationError(`마이그레이션 '${m.className}' 이(가) 두 번 들어왔다`, m.className);
      if (!Number.isInteger(m.creationTimestamp) || m.creationTimestamp <= 0) {
        throw new MigrationError(`${m.className}: creationTimestamp 가 양의 정수가 아니다`, m.className);
      }
      names.add(m.className);
    }
    this.migrations = [...migrations].sort((a, b) => a.creationTimestamp - b.creationTimestamp || a.className.localeCompare(b.className));
  }

  async ensureTable(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS "migration" (
      "class" TEXT NOT NULL PRIMARY KEY,
      "creation_timestamp" INTEGER NOT NULL,
      "update" TEXT,
      "update_destructive" TEXT,
      "message" TEXT
    )`.execute(this.db);
  }

  private async rows(): Promise<Map<string, MigrationRow>> {
    await this.ensureTable();
    const rows = (await this.db.selectFrom(MIGRATION_TABLE).selectAll().execute()) as MigrationRow[];
    return new Map(rows.map((r) => [r.class, r]));
  }

  /** 아직 안 돈 것 — destructive 면 update 는 돌았고 update_destructive 가 빈 것까지 */
  async pending(options: { destructive?: boolean } = {}): Promise<{ update: Migration[]; destructive: Migration[] }> {
    const done = await this.rows();
    const update = this.migrations.filter((m) => !done.get(m.className)?.update);
    const destructive = options.destructive ? this.migrations.filter((m) => !done.get(m.className)?.update_destructive) : [];
    return { update, destructive };
  }

  async migrate(options: { destructive?: boolean } = {}): Promise<MigrationRunResult> {
    const pending = await this.pending(options);
    const result: MigrationRunResult = { updated: [], destructive: [] };
    for (const m of pending.update) {
      await this.runOne(m, 'update');
      result.updated.push(m.className);
    }
    for (const m of pending.destructive) {
      await this.runOne(m, 'update_destructive');
      result.destructive.push(m.className);
    }
    return result;
  }

  private async runOne(m: Migration, phase: 'update' | 'update_destructive'): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        if (phase === 'update') await m.update(trx);
        else await m.updateDestructive(trx);
        const now = new Date().toISOString();
        const existing = await trx.selectFrom(MIGRATION_TABLE).select('class').where('class', '=', m.className).executeTakeFirst();
        if (existing) {
          await trx.updateTable(MIGRATION_TABLE).set({ [phase]: now, message: null }).where('class', '=', m.className).execute();
        } else {
          await trx
            .insertInto(MIGRATION_TABLE)
            .values({ class: m.className, creation_timestamp: m.creationTimestamp, [phase]: now })
            .execute();
        }
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new MigrationError(`${m.className}.${phase === 'update' ? 'update' : 'updateDestructive'} 실패: ${reason}`, m.className, { cause: e });
    }
  }
}
