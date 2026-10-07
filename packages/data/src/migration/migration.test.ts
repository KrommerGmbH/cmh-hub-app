import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Criteria } from '../criteria.js';
import { createDefaultRegistry } from '../definition/index.js';
import { openSqliteDatabase } from '../driver/sqlite/sqlite-database.js';
import { DataSourceFactory } from '../repository.js';
import { backupPathFor, coreMigrations, CorruptDatabaseError, Migration, Migration1791331200CmhAiBaseSchema, MigrationError, MigrationRunner, migrateWithBackup, SchemaBuilder } from './index.js';

/** 앱 기본 마이그레이션 이름(차례대로) */
const CORE = coreMigrations().map((m) => m.className);

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
    expect(first.updated).toEqual(CORE);
    const second = await new MigrationRunner(h.db, coreMigrations()).migrate();
    expect(second.updated).toEqual([]);
    const rows = await h.db.selectFrom('migration').selectAll().execute();
    expect(rows).toHaveLength(CORE.length);
    expect(rows[0]).toMatchObject({ class: 'Migration1791331200CmhAiBaseSchema', creation_timestamp: 1791331200, update_destructive: null });
    expect(typeof rows[0]?.['update']).toBe('string');
    // destructive 는 따로 — 부르면 그때 한 번
    const d = await new MigrationRunner(h.db, coreMigrations()).migrate({ destructive: true });
    expect(d).toEqual({ updated: [], destructive: CORE });
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
    expect(a.migration?.updated).toEqual(CORE);
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
    expect(ran.map((r) => r['class'])).toEqual(CORE);
    const half = await sql`SELECT name FROM sqlite_master WHERE name = 'plugin_half_done'`.execute(handle);
    expect(half.rows).toEqual([]);
    await handle.destroy();
  });

  it('migrateWithBackup — 사본 만들기 실패면 원본을 건드리지 않는다', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    await a.repository('cmh_ai_provider').upsert([{ id: 'a'.repeat(32), code: 'kept', name: 'Kept' }]);
    await a.close();
    // 지난 판 올림 때 남은 옛 사본 — 실패한 새 사본이 이것을 덮어도 안 된다
    const oldBackup = backupPathFor(filename);
    writeFileSync(oldBackup, 'OLD-BACKUP');
    const before = readFileSync(filename);

    // 디스크가 가득 차 사본을 반쯤 쓰고 죽는 경우를 흉내(검수 재현 mig.ts 와 같은 꼴)
    const spy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (destination: string) {
      writeFileSync(destination, 'PARTIAL');
      throw new Error('ENOSPC: 흉내');
    });
    let caught: unknown;
    try {
      await migrateWithBackup({ filename, migrations: [...coreMigrations(), new InsertProviderMigration()] });
    } catch (e) {
      caught = e;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).message).toMatch(/사본 만들기 실패: ENOSPC: 흉내 — 마이그레이션은 돌리지 않았고 원본은 그대로다/);
    expect(((caught as MigrationError).cause as Error).message).toBe('ENOSPC: 흉내');

    // 원본은 한 바이트도 안 바뀌었고 · 옛 사본도 그대로 · 반쯤 쓴 임시 파일은 치웠다
    expect(readFileSync(filename).equals(before)).toBe(true);
    expect(readFileSync(oldBackup, 'utf8')).toBe('OLD-BACKUP');
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-') || n.includes('.restore-'))).toEqual([]);

    // 마이그레이션은 돌지 않았다(InsertProvider 의 줄도 · migration 줄도 없다)
    const b = await DataSourceFactory.create({ dataSource: 'local', filename });
    expect((await b.repository('cmh_ai_provider').search(new Criteria())).elements.map((e) => e['code'])).toEqual(['kept']);
    await b.close();
    const raw = openSqliteDatabase(filename);
    expect((await raw.db.selectFrom('migration').select('class').execute()).map((r) => r['class'])).toEqual(CORE);
    await raw.db.destroy();
  });

  it('migrateWithBackup — 마이그레이션 밖 오류도 MigrationError 로 감싸고 cause 를 지킨다', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    await a.close();
    class NoopMigration extends Migration {
      readonly creationTimestamp = 1791400200;
      override get className(): string {
        return 'Migration1791400200Noop';
      }
      async update(): Promise<void> {
        await Promise.resolve();
      }
    }
    // runner 가 잡기 전에 터지는 오류(pending 조회) — 그래도 MigrationError · cause 는 원래 오류
    const boom = new Error('pending 조회 실패');
    const spy = vi.spyOn(MigrationRunner.prototype, 'pending').mockRejectedValue(boom);
    try {
      const err = await migrateWithBackup({ filename, migrations: [...coreMigrations(), new NoopMigration()] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).cause).toBe(boom);
      expect((err as MigrationError).message).toMatch(/마이그레이션 실패: pending 조회 실패/);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(filename)).toBe(true);
  });

  it('처음 만든 파일에서 실패하면 파일을 지운다', async () => {
    const filename = join(dir, 'fresh.sqlite');
    await expect(migrateWithBackup({ filename, migrations: [...coreMigrations(), new BrokenMigration()] })).rejects.toThrow(MigrationError);
    expect(existsSync(filename)).toBe(false);
  });

  it('깨진 파일(SQLITE_NOTADB) — CorruptDatabaseError · 파일은 그대로 · 앞선 사본 경로는 칸으로만(메시지는 파일 이름만)', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const garbage = Buffer.from('this is not a sqlite database — '.repeat(200), 'utf8');
    writeFileSync(filename, garbage);

    const first = await migrateWithBackup({ filename, migrations: coreMigrations() }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(CorruptDatabaseError);
    expect((first as CorruptDatabaseError).sqliteCode).toBe('SQLITE_NOTADB');
    expect((first as CorruptDatabaseError).backupPath).toBeNull();
    expect(readFileSync(filename).equals(garbage)).toBe(true);
    expect(existsSync(`${filename}-wal`)).toBe(false);

    writeFileSync(backupPathFor(filename), 'OLD-BACKUP');
    const second = (await migrateWithBackup({ filename, migrations: coreMigrations() }).catch((e: unknown) => e)) as CorruptDatabaseError;
    expect(second).toBeInstanceOf(CorruptDatabaseError);
    expect(second.backupPath).toBe(backupPathFor(filename));
    expect(second.message).toContain('cmh-hub.sqlite.pre-migration.bak');
    expect(second.message).not.toContain(dir);
    expect(readFileSync(filename).equals(garbage)).toBe(true);
    expect(readFileSync(backupPathFor(filename), 'utf8')).toBe('OLD-BACKUP');
  });

  it('마이그레이션 실패 메시지에 폴더 경로가 없다 · 사본 전체 경로는 MigrationError.backupPath', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    await a.close();
    const err = (await migrateWithBackup({ filename, migrations: [...coreMigrations(), new BrokenMigration()] }).catch((e: unknown) => e)) as MigrationError;
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.backupPath).toBe(backupPathFor(filename));
    expect(err.message).toContain('사본(cmh-hub.sqlite.pre-migration.bak)으로 되돌렸다');
    expect(err.message).not.toContain(dir);
  });

  it('끊긴 실행이 남긴 임시 파일(*.pre-migration.bak.tmp-* · *.restore-*)을 열 때 치운다 · 살아 있는 남의 pid 것은 남긴다', async () => {
    const filename = join(dir, 'cmh-hub.sqlite');
    const a = await DataSourceFactory.create({ dataSource: 'local', filename });
    await a.close();
    // 없는 pid(Linux pid_max 4194304 보다 크다) · 이 프로세스 pid · 살아 있는 부모 pid
    const dead = 2_147_000_000;
    const staleBak = `${backupPathFor(filename)}.tmp-${dead}-1`;
    const staleRestore = `${filename}.restore-${dead}-2`;
    const ownBak = `${backupPathFor(filename)}.tmp-${process.pid}-3`;
    const liveOther = `${backupPathFor(filename)}.tmp-${process.ppid}-4`;
    const notOurs = `${backupPathFor(filename)}.tmp-keep-me`;
    for (const f of [staleBak, staleRestore, ownBak, liveOther, notOurs]) writeFileSync(f, 'LEFTOVER');

    const b = await DataSourceFactory.create({ dataSource: 'local', filename });
    await b.close();
    expect(existsSync(staleBak)).toBe(false);
    expect(existsSync(staleRestore)).toBe(false);
    expect(existsSync(ownBak)).toBe(false);
    expect(existsSync(liveOther)).toBe(true);
    expect(existsSync(notOurs)).toBe(true);
  });
});

describe('Migration1791374400McpNameNocase — 서버 utf8mb4_unicode_ci 와 맞춤', () => {
  it('mcp_server.code 대소문자만 다른 값은 UNIQUE 위반', async () => {
    const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:' });
    const servers = ds.repository('cmh_ai_mcp_server');
    const { ids } = await servers.upsert([{ code: 'Foo', name: 'x', type: 'stdio' }]);
    await expect(servers.upsert([{ code: 'foo', name: 'y', type: 'stdio' }])).rejects.toThrow(/UNIQUE constraint failed: cmh_ai_mcp_server\.code/);
    // 같은 줄의 대소문자만 바꾸는 것은 된다(자기 자신과는 겹치지 않는다)
    await servers.upsert([{ id: ids[0], code: 'FOO' }]);
    // mcp_tool.name 은 서버 안에서만 — 다른 서버면 같은 이름도 된다
    const { ids: [other] } = await servers.upsert([{ code: 'bar', name: 'z', type: 'stdio' }]);
    const tools = ds.repository('cmh_ai_mcp_tool');
    await tools.upsert([{ serverId: ids[0], name: 'Fetch' }, { serverId: other, name: 'fetch' }]);
    await expect(tools.upsert([{ serverId: ids[0], name: 'FETCH' }])).rejects.toThrow(/UNIQUE constraint failed: cmh_ai_mcp_tool\.server_id, cmh_ai_mcp_tool\.name/);
    // provider.code 는 서버도 utf8mb4_bin(대소문자 가름) — 로컬도 그대로 둘 다 들어간다
    await ds.repository('cmh_ai_provider').upsert([{ code: 'Same', name: 'A' }, { code: 'same', name: 'B' }]);
    await ds.close();
  });

  it('이미 대소문자만 다른 줄이 있는 DB 는 이 마이그레이션에서 멈추고 사본으로 되돌린다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmh-data-nocase-'));
    try {
      const filename = join(dir, 'cmh-hub.sqlite');
      const old = await migrateWithBackup({ filename, migrations: [new Migration1791331200CmhAiBaseSchema()] });
      await sql`INSERT INTO cmh_ai_mcp_server (id, code, name, created_at) VALUES (${'a'.repeat(32)}, 'Foo', 'a', '2026-10-07T00:00:00.000Z'), (${'b'.repeat(32)}, 'foo', 'b', '2026-10-07T00:00:00.000Z')`.execute(old.handle.db);
      await old.handle.db.destroy();
      await expect(migrateWithBackup({ filename, migrations: coreMigrations() })).rejects.toThrow(/Migration1791374400McpNameNocase\.update 실패: .*UNIQUE.* — 사본\(.*\)으로 되돌렸다/);
      const raw = openSqliteDatabase(filename);
      expect((await raw.db.selectFrom('cmh_ai_mcp_server').select('code').orderBy('code').execute()).map((r) => r['code'])).toEqual(['Foo', 'foo']);
      await raw.db.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(ds.migration?.updated).toEqual([...CORE, 'Migration1791500000PluginModelLicense']);
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
