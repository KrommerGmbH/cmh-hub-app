import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Criteria } from '../criteria.js';
import { createDefaultRegistry } from '../definition/index.js';
import { openSqliteDatabase } from '../driver/sqlite/sqlite-database.js';
import { DataSourceFactory } from '../repository.js';
import { backupPathFor, coreMigrations, Migration, MigrationError, MigrationRunner, migrateWithBackup, SchemaBuilder } from './index.js';

class InsertProviderMigration extends Migration {
  readonly creationTimestamp = 1791400000;
  override get className(): string {
    return 'Migration1791400000InsertProvider';
  }
  async update(db: Kysely<any>): Promise<void> {
    await sql`INSERT INTO cmh_ai_provider (id, code, name, created_at) VALUES (${'b'.repeat(32)}, 'from-good', 'Good', ${new Date().toISOString()})`.execute(db);
  }
}

class BrokenMigration extends Migration {
  readonly creationTimestamp = 1791400100;
  override get className(): string {
    return 'Migration1791400100Broken';
  }
  async update(db: Kysely<any>): Promise<void> {
    await sql`CREATE TABLE plugin_half_done (id TEXT)`.execute(db);
    throw new Error('일부러 실패');
  }
}

describe('MigrationRunner', () => {
  it('한 번만 돈다 · migration 테이블에 적는다', async () => {
    const h = openSqliteDatabase(':memory:');
    const first = await new MigrationRunner(h.db, coreMigrations()).migrate();
    expect(first.updated).toEqual(['Migration1791331200CmhAiBaseSchema']);
    const second = await new MigrationRunner(h.db, coreMigrations()).migrate();
    expect(second.updated).toEqual([]);
    const rows = await h.db.selectFrom('migration').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ class: 'Migration1791331200CmhAiBaseSchema', creation_timestamp: 1791331200, update_destructive: null });
    expect(typeof rows[0]?.['update']).toBe('string');
    // destructive 는 따로 — 부르면 그때 한 번
    const d = await new MigrationRunner(h.db, coreMigrations()).migrate({ destructive: true });
    expect(d).toEqual({ updated: [], destructive: ['Migration1791331200CmhAiBaseSchema'] });
    expect((await new MigrationRunner(h.db, coreMigrations()).migrate({ destructive: true })).destructive).toEqual([]);
    await h.db.destroy();
  });

  it('같은 이름 두 번 = 예외', () => {
    const h = openSqliteDatabase(':memory:');
    expect(() => new MigrationRunner(h.db, [...coreMigrations(), ...coreMigrations()])).toThrow(MigrationError);
    void h.db.destroy();
  });

  it('고정 SQL 스키마 = 정의(칸 이름 · 종류 · NOT NULL · 기본값)', async () => {
    const h = openSqliteDatabase(':memory:');
    await new MigrationRunner(h.db, coreMigrations()).migrate();
    const typeOf = { id: 'TEXT', fk: 'TEXT', string: 'TEXT', text: 'TEXT', json: 'TEXT', datetime: 'TEXT', date: 'TEXT', int: 'INTEGER', bool: 'INTEGER', float: 'REAL' };
    for (const def of createDefaultRegistry().all()) {
      const cols = h.database.prepare(`PRAGMA table_info("${def.entityName}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
      expect(cols.map((c) => c.name)).toEqual(def.fields.map((f) => f.name));
      for (const f of def.fields) {
        const col = cols.find((c) => c.name === f.name);
        expect(col?.type, `${def.entityName}.${f.name}`).toBe(typeOf[f.type]);
        expect(col?.notnull === 1, `${def.entityName}.${f.name} notnull`).toBe(Boolean(f.primaryKey || f.required || f.defaultValue !== undefined));
        expect(col?.dflt_value !== null, `${def.entityName}.${f.name} default`).toBe(f.defaultValue !== undefined);
      }
    }
    await h.db.destroy();
  });
});

describe('파일 DB — 사본 · 실패 시 되돌림', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmh-data-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('두 번째 실행은 마이그레이션 0', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    expect(a.migration?.updated).toEqual(['Migration1791331200CmhAiBaseSchema']);
    await a.close();
    const b = await DataSourceFactory.create({ dataSource: 'local', filename });
    expect(b.migration?.updated).toEqual([]);
    await b.close();
    // 돌릴 것이 없으면 사본도 만들지 않는다
    expect(existsSync(backupPathFor(filename))).toBe(false);
  });

  it('실패하면 사본으로 되돌린다(앞서 성공한 마이그레이션까지)', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    await a.repository('cmh_ai_provider').upsert([{ id: 'a'.repeat(32), code: 'kept', name: 'Kept' }]);
    await a.close();

    await expect(
      migrateWithBackup({ filename, migrations: [...coreMigrations(), new InsertProviderMigration(), new BrokenMigration()] }),
    ).rejects.toThrow(/Migration1791400100Broken\.update 실패: 일부러 실패 — 사본\(.*\)으로 되돌렸다/);
    expect(existsSync(backupPathFor(filename))).toBe(true);

    const b = await DataSourceFactory.create({ dataSource: 'local', filename });
    const codes = (await b.repository('cmh_ai_provider').search(new Criteria())).elements.map((e) => e['code']);
    expect(codes).toEqual(['kept']); // InsertProvider 의 줄은 없다
    await b.close();
    const raw = openSqliteDatabase(filename);
    const handle = raw.db;
    const ran = await handle.selectFrom('migration').select('class').execute();
    expect(ran.map((r) => r['class'])).toEqual(['Migration1791331200CmhAiBaseSchema']);
    const half = await sql`SELECT name FROM sqlite_master WHERE name = 'plugin_half_done'`.execute(handle);
    expect(half.rows).toEqual([]);
    await handle.destroy();
  });

  it('처음 만든 파일에서 실패하면 파일을 지운다', async () => {
    const filename = join(dir, 'fresh.sqlite');
    await expect(migrateWithBackup({ filename, migrations: [...coreMigrations(), new BrokenMigration()] })).rejects.toThrow(MigrationError);
    expect(existsSync(filename)).toBe(false);
  });
});

describe('플러그인 — extendFields + 자기 Migration(SchemaBuilder.addColumn)', () => {
  it('더한 칸으로 쓰고 · 거르고 · 읽는다', async () => {
    const registry = createDefaultRegistry();
    const license = { name: 'license', type: 'string', defaultValue: 'unknown' } as const;
    registry.extendFields('cmh_ai_model', [license, { name: 'local_path', type: 'string' }]);
    class PluginMigration extends Migration {
      readonly creationTimestamp = 1791500000;
      override get className(): string {
        return 'Migration1791500000PluginModelLicense';
      }
      async update(db: Kysely<any>): Promise<void> {
        await SchemaBuilder.addColumn(db, 'cmh_ai_model', license);
        await SchemaBuilder.addColumn(db, 'cmh_ai_model', { name: 'local_path', type: 'string' });
      }
    }
    const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:', registry, migrations: [new PluginMigration()] });
    expect(ds.migration?.updated).toEqual(['Migration1791331200CmhAiBaseSchema', 'Migration1791500000PluginModelLicense']);
    await ds.repository('cmh_ai_provider').upsert([{ id: 'a'.repeat(32), code: 'p', name: 'P' }]);
    await ds.repository('cmh_ai_model').upsert([
      { providerId: 'a'.repeat(32), code: 'm1', license: 'Apache-2.0', localPath: 'models/m1.gguf' },
      { providerId: 'a'.repeat(32), code: 'm2' },
    ]);
    const r = await ds.repository('cmh_ai_model').search(new Criteria().addFilter(Criteria.equals('license', 'unknown')));
    expect(r.elements.map((e) => [e['code'], e['license'], e['localPath']])).toEqual([['m2', 'unknown', null]]);
    expect(() => SchemaBuilder.addColumnStatement('cmh_ai_model', { name: 'must', type: 'int', required: true })).toThrow(/defaultValue/);
    await ds.close();
  });
});
