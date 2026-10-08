// R7-c — 설정 행 테이블 `system_config`(SettingsStore 저장 자리 · 2026-10-08).
// 【AI 임시 결정 · 로컬 앱 DB 전용 · 서버 테이블 아님】 앱 SQLite 파일(userData/cmh-hub.sqlite) 안의 설정 행이다. 서버 Shopware 에도
//   같은 이름 테이블이 있으나 이 행은 서버로 sync 하지 않는다(서버 마이그레이션 아님 · R9 서버 모드 전환 때 따로 정한다).
// 칸 이름은 Shopware 와 같다(정의: definition/entities/system-config.ts). 기본 스키마처럼 SQL 을 그대로 박아 둔다 —
//   정의가 나중에 바뀌어도 이 파일은 손대지 말고 새 Migration<timestamp> 로 ALTER 한다(시험 «고정 SQL 스키마 = 정의» 가 어긋남을 잡는다).
// UNIQUE: ①(configuration_key, sales_channel_id) — 판매채널이 있는 행끼리 ②부분 UNIQUE 색인 — sales_channel_id 가 null 인 행은 키 하나에 한 줄
//   (SQLite 는 UNIQUE 에서 NULL 끼리 다르다고 보므로 ①만으로는 null 채널 키가 두 줄 들어간다).
// 키는 대소문자를 가른다(BINARY) — SettingsStore 캐시(Map)와 같다. 서버 칸 collation 은 이 저장소에서 확인하지 못했다.
import { sql, type Kysely } from 'kysely';
import { Migration } from '../migration.js';

const STATEMENTS: readonly string[] = [
  `CREATE TABLE "system_config" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "configuration_key" TEXT NOT NULL,
  "configuration_value" TEXT NOT NULL,
  "sales_channel_id" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("configuration_key", "sales_channel_id")
)`,
  `CREATE INDEX "idx.system_config.sales_channel_id" ON "system_config" ("sales_channel_id")`,
  `CREATE UNIQUE INDEX "uniq.system_config.configuration_key_null_channel" ON "system_config" ("configuration_key") WHERE "sales_channel_id" IS NULL`,
];

export class Migration1791417600SystemConfig extends Migration {
  readonly creationTimestamp = 1791417600; // 2026-10-08T00:00:00Z

  override get className(): string {
    return 'Migration1791417600SystemConfig';
  }

  async update(db: Kysely<any>): Promise<void> {
    for (const s of STATEMENTS) await sql.raw(s).execute(db);
  }
}
