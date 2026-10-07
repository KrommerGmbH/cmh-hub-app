// R1 1차 기본 스키마 — cmh_ai_provider · model · mcp_server · mcp_tool · conversation · conversation_message (2026-10-07)
// Shopware 마이그레이션처럼 SQL 을 그대로 박아 둔다: 정의(definition/entities/cmh-ai.ts)가 나중에 바뀌어도 이미 돈 DB 와 새 DB 가 갈리지 않게.
// 정의를 바꾸면 이 파일은 손대지 말고 새 Migration<timestamp> 로 ALTER 한다 — 시험 «정의와 스키마가 같다» 가 어긋남을 잡는다.
// 처음 글은 SchemaBuilder.createTableStatements(CMH_AI_DEFINITIONS) 가 만든 것.
import { sql, type Kysely } from 'kysely';
import { Migration } from '../migration.js';

const STATEMENTS: readonly string[] = [
  `CREATE TABLE "cmh_ai_provider" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'local',
  "base_url" TEXT,
  "company_id" TEXT,
  "models_url" TEXT,
  "price_url" TEXT,
  "api_key_enc" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "free_tier" INTEGER NOT NULL DEFAULT 0,
  "daily_limit" INTEGER,
  "rpm_limit" INTEGER,
  "rpm_headroom" INTEGER NOT NULL DEFAULT 3,
  "used_today" INTEGER NOT NULL DEFAULT 0,
  "used_today_date" TEXT,
  "used_minute" INTEGER NOT NULL DEFAULT 0,
  "used_minute_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("code")
)`,
  `CREATE TABLE "cmh_ai_model" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider_id" TEXT NOT NULL REFERENCES "cmh_ai_provider"("id") ON DELETE CASCADE,
  "code" TEXT NOT NULL,
  "label" TEXT,
  "context_window" INTEGER,
  "active" INTEGER NOT NULL DEFAULT 1,
  "inactive_reason" TEXT,
  "last_seen_at" TEXT,
  "description" TEXT,
  "output_token_limit" INTEGER,
  "abilities" TEXT,
  "thinking" INTEGER,
  "tool_calling" INTEGER,
  "enabled_by_user" INTEGER,
  "price_in_per_mtok" REAL,
  "price_out_per_mtok" REAL,
  "price_currency" TEXT,
  "price_source" TEXT,
  "price_checked_at" TEXT,
  "last_error" TEXT,
  "last_failed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("provider_id", "code")
)`,
  `CREATE INDEX "idx.cmh_ai_model.provider_id" ON "cmh_ai_model" ("provider_id")`,
  `CREATE TABLE "cmh_ai_mcp_server" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'stdio',
  "command" TEXT,
  "args" TEXT,
  "url" TEXT,
  "env_keys" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "gateway_managed" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("code")
)`,
  `CREATE TABLE "cmh_ai_mcp_tool" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "server_id" TEXT NOT NULL REFERENCES "cmh_ai_mcp_server"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "title" TEXT,
  "description" TEXT,
  "parameters" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "needs_approval" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("server_id", "name")
)`,
  `CREATE INDEX "idx.cmh_ai_mcp_tool.server_id" ON "cmh_ai_mcp_tool" ("server_id")`,
  `CREATE TABLE "cmh_ai_conversation" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT,
  "customer_id" TEXT,
  "agent_id" TEXT NOT NULL,
  "agent_version_id" TEXT NOT NULL DEFAULT '0fa91ce3e96a4bc2be4bd9ce752c3425',
  "counterpart_type" TEXT NOT NULL DEFAULT 'user',
  "capability_id" TEXT,
  "title" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "summary" TEXT,
  "summary_upto_seq" INTEGER NOT NULL DEFAULT 0,
  "token_total" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT
)`,
  `CREATE INDEX "idx.cmh_ai_conversation.user_id" ON "cmh_ai_conversation" ("user_id")`,
  `CREATE INDEX "idx.cmh_ai_conversation.customer_id" ON "cmh_ai_conversation" ("customer_id")`,
  `CREATE INDEX "idx.cmh_ai_conversation.agent_id" ON "cmh_ai_conversation" ("agent_id")`,
  `CREATE INDEX "idx.cmh_ai_conversation.capability_id" ON "cmh_ai_conversation" ("capability_id")`,
  `CREATE TABLE "cmh_ai_conversation_message" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "conversation_id" TEXT NOT NULL REFERENCES "cmh_ai_conversation"("id") ON DELETE CASCADE,
  "seq" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'normal',
  "content" TEXT,
  "content_hash" TEXT,
  "attachments" TEXT,
  "chat_run_id" TEXT,
  "run_id" TEXT,
  "tokens" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'done',
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT,
  UNIQUE ("conversation_id", "seq")
)`,
  `CREATE INDEX "idx.cmh_ai_conversation_message.conversation_id" ON "cmh_ai_conversation_message" ("conversation_id")`,
  `CREATE INDEX "idx.cmh_ai_conversation_message.chat_run_id" ON "cmh_ai_conversation_message" ("chat_run_id")`,
  `CREATE INDEX "idx.cmh_ai_conversation_message.run_id" ON "cmh_ai_conversation_message" ("run_id")`,
];

export class Migration1791331200CmhAiBaseSchema extends Migration {
  readonly creationTimestamp = 1791331200; // 2026-10-07T00:00:00Z

  override get className(): string {
    return 'Migration1791331200CmhAiBaseSchema';
  }

  async update(db: Kysely<any>): Promise<void> {
    for (const s of STATEMENTS) await sql.raw(s).execute(db);
  }
}
