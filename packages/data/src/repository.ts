// R1 — Repository<E> (Shopware EntityRepository 꼴) · DataSourceFactory(local = SQLite 파일 · server = Admin API).
// 앱의 다른 모듈(R2~R9)은 Repository 만 본다 — dataSource 를 바꿔도 부르는 쪽 코드는 같다.
import { createDefaultRegistry } from './definition/index.js';
import type { EntityRegistry } from './definition/registry.js';
import type { Entity } from './definition/types.js';
import { AdminApiDriver, type AdminApiTransport } from './driver/admin-api/admin-api-driver.js';
import { SqliteDriver } from './driver/sqlite/sqlite-driver.js';
import type { SqliteHandle } from './driver/sqlite/sqlite-database.js';
import type { CriteriaInput, EntityDriver, EntitySearchResult, IdSearchResult, RawRow, ReadOptions, WriteResult } from './driver/types.js';
import type { Migration } from './migration/migration.js';
import type { MigrationRunResult } from './migration/migration-runner.js';
import { migrateWithBackup } from './migration/migrate-with-backup.js';
import { coreMigrations } from './migration/migrations/index.js';

export class Repository<E extends Entity = Entity> {
  constructor(
    readonly entityName: string,
    private readonly driver: EntityDriver,
  ) {}

  search(criteria: CriteriaInput, options?: ReadOptions): Promise<EntitySearchResult<E>> {
    return this.driver.search(this.entityName, criteria, options) as Promise<EntitySearchResult<E>>;
  }

  searchIds(criteria: CriteriaInput, options?: ReadOptions): Promise<IdSearchResult> {
    return this.driver.searchIds(this.entityName, criteria, options);
  }

  get(id: string, criteria?: CriteriaInput, options?: ReadOptions): Promise<E | null> {
    return this.driver.get(this.entityName, id, criteria, options) as Promise<E | null>;
  }

  aggregate(criteria: CriteriaInput, options?: ReadOptions): Promise<Record<string, unknown>> {
    return this.driver.aggregate(this.entityName, criteria, options);
  }

  upsert(rows: readonly (Partial<E> | RawRow)[]): Promise<WriteResult> {
    return this.driver.upsert(this.entityName, rows as readonly RawRow[]);
  }

  delete(ids: readonly string[]): Promise<WriteResult> {
    return this.driver.delete(this.entityName, ids);
  }
}

export type DataSourceKind = 'local' | 'server';

export interface LocalDataSourceOptions {
  readonly dataSource: 'local';
  /** userData/cmh-hub.sqlite (시험은 ':memory:') */
  readonly filename: string;
  readonly registry?: EntityRegistry;
  /** 플러그인 마이그레이션 — 앱 기본(coreMigrations) 뒤에 붙는다 */
  readonly migrations?: readonly Migration[];
  /** updateDestructive 까지 — 앱 판 올림 때만 */
  readonly destructive?: boolean;
  readonly locale?: string;
}

export interface ServerDataSourceOptions {
  readonly dataSource: 'server';
  readonly transport: AdminApiTransport;
  readonly registry?: EntityRegistry;
  /** 비밀칸을 sync 로 보낼까(기본 false = 예외) — AdminApiDriverOptions.allowSecretFields */
  readonly allowSecretFields?: boolean;
}

export type DataSourceOptions = LocalDataSourceOptions | ServerDataSourceOptions;

export interface DataSource {
  readonly kind: DataSourceKind;
  readonly registry: EntityRegistry;
  readonly driver: EntityDriver;
  /** local 일 때 이번에 돈 마이그레이션 */
  readonly migration: MigrationRunResult | null;
  repository<E extends Entity = Entity>(entityName: string): Repository<E>;
  close(): Promise<void>;
}

class DataSourceImpl implements DataSource {
  constructor(
    readonly kind: DataSourceKind,
    readonly registry: EntityRegistry,
    readonly driver: EntityDriver,
    readonly migration: MigrationRunResult | null,
    private readonly handle: SqliteHandle | null,
  ) {}

  repository<E extends Entity = Entity>(entityName: string): Repository<E> {
    this.registry.get(entityName); // 모르는 엔티티면 여기서 예외
    return new Repository<E>(entityName, this.driver);
  }

  async close(): Promise<void> {
    if (this.handle) await this.handle.db.destroy();
  }
}

export const DataSourceFactory = {
  /** local = SQLite 열기 + 마이그레이션(사본 · 실패 시 되돌림 · MigrationError · 깨진 파일은 CorruptDatabaseError) · server = Admin API driver */
  async create(options: DataSourceOptions): Promise<DataSource> {
    const registry = options.registry ?? createDefaultRegistry();
    if (options.dataSource === 'server') {
      const driver = new AdminApiDriver({
        transport: options.transport,
        registry,
        ...(options.allowSecretFields === undefined ? {} : { allowSecretFields: options.allowSecretFields }),
      });
      return new DataSourceImpl('server', registry, driver, null, null);
    }
    const { handle, result } = await migrateWithBackup({
      filename: options.filename,
      migrations: [...coreMigrations(), ...(options.migrations ?? [])],
      ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
    });
    const driver = new SqliteDriver({ db: handle.db, registry, ...(options.locale === undefined ? {} : { locale: options.locale }) });
    return new DataSourceImpl('local', registry, driver, result, handle);
  },
};
