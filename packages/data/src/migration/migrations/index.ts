import type { Migration } from '../migration.js';
import { Migration1791331200CmhAiBaseSchema } from './Migration1791331200CmhAiBaseSchema.js';

export { Migration1791331200CmhAiBaseSchema };

/** 앱이 들고 가는 마이그레이션 — 플러그인 것은 DataSourceFactory 에 따로 넘긴다 */
export function coreMigrations(): Migration[] {
  return [new Migration1791331200CmhAiBaseSchema()];
}
