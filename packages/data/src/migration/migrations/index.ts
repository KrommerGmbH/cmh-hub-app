import type { Migration } from '../migration.js';
import { Migration1791331200CmhAiBaseSchema } from './Migration1791331200CmhAiBaseSchema.js';
import { Migration1791374400McpNameNocase } from './Migration1791374400McpNameNocase.js';

export { Migration1791331200CmhAiBaseSchema, Migration1791374400McpNameNocase };

/** 앱이 들고 가는 마이그레이션 — 플러그인 것은 DataSourceFactory 에 따로 넘긴다 */
export function coreMigrations(): Migration[] {
  return [new Migration1791331200CmhAiBaseSchema(), new Migration1791374400McpNameNocase()];
}
