// R1 — mcp_server.code · mcp_tool.name 대소문자 무시 UNIQUE(2026-10-07 검수 권고).
// 서버는 두 칸에 칸 collation 이 따로 없어 표 기본 utf8mb4_unicode_ci 를 쓴다 → 'Foo' · 'foo' 를 같은 값으로 보고 UNIQUE 위반
// (CmhAiAgent Migration1790100000CmhAiAgentSchema.php:999 · :1012 · :1019 · :1028). provider.code · model.code 는 서버도 utf8mb4_bin 이라 그대로 둔다.
// 기본 스키마의 UNIQUE 제약은 SQLite 에서 표를 다시 만들어야만 바꿀 수 있다(FK 자식이 있어 위험) → 고치지 않고 NOCASE UNIQUE 색인을 하나 더 둔다.
// 차이: SQLite NOCASE 는 ASCII 만 접는다(unicode_ci 는 악센트 · 비ASCII 대소문자 · 끝 공백도 같게 본다 — 서버 실측 전).
import { sql, type Kysely } from 'kysely';
import { Migration } from '../migration.js';

const STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX "uniq.cmh_ai_mcp_server.code_nocase" ON "cmh_ai_mcp_server" ("code" COLLATE NOCASE)`,
  `CREATE UNIQUE INDEX "uniq.cmh_ai_mcp_tool.server_name_nocase" ON "cmh_ai_mcp_tool" ("server_id", "name" COLLATE NOCASE)`,
];

export class Migration1791374400McpNameNocase extends Migration {
  readonly creationTimestamp = 1791374400; // 2026-10-07T12:00:00Z

  override get className(): string {
    return 'Migration1791374400McpNameNocase';
  }

  /** 이미 대소문자만 다른 줄이 있으면 색인 만들기가 실패한다 → MigrationError · migrateWithBackup 이 사본으로 되돌린다 */
  async update(db: Kysely<any>): Promise<void> {
    for (const s of STATEMENTS) await sql.raw(s).execute(db);
  }
}
