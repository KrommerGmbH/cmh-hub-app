// R1 — 정의 → SQLite DDL. 마이그레이션이 이 글을 그대로 박아 두거나(1차 기본 스키마) 플러그인이 불러 쓴다.
// 칸 꼴: id·fk = TEXT(32자 hex) · string·text·json·datetime(ISO)·date(YYYY-MM-DD) = TEXT · int·bool(0/1) = INTEGER · float = REAL
import { sql, type Kysely } from 'kysely';
import { translationForeignKey, translationTableName } from '../definition/define-entity.js';
import { ResolvedEntityDefinition } from '../definition/registry.js';
import type { EntityDefinition, FieldDefinition, FieldType } from '../definition/types.js';

const SQLITE_TYPE: Record<FieldType, 'TEXT' | 'INTEGER' | 'REAL'> = {
  id: 'TEXT',
  fk: 'TEXT',
  string: 'TEXT',
  text: 'TEXT',
  json: 'TEXT',
  datetime: 'TEXT',
  date: 'TEXT',
  int: 'INTEGER',
  bool: 'INTEGER',
  float: 'REAL',
};

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`기본값이 유한한 수가 아니다: ${value}`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function columnSql(field: FieldDefinition, opts: { inTranslation?: boolean } = {}): string {
  const parts = [quoteIdentifier(field.name), SQLITE_TYPE[field.type]];
  // 번역 칸은 번역 줄마다 비어 있을 수 있다(서버도 언어별 줄 · 필수 검사는 시스템 언어 줄에만)
  const notNull = !opts.inTranslation && (field.primaryKey || field.required || field.defaultValue !== undefined);
  if (field.primaryKey) parts.push('PRIMARY KEY');
  if (notNull) parts.push('NOT NULL');
  if (field.defaultValue !== undefined && !opts.inTranslation) parts.push(`DEFAULT ${literal(field.defaultValue)}`);
  if (field.type === 'fk' && field.reference) {
    parts.push(`REFERENCES ${quoteIdentifier(field.reference)}(${quoteIdentifier('id')})`);
    if (field.onDelete) parts.push(`ON DELETE ${field.onDelete.toUpperCase()}`);
  }
  return parts.join(' ');
}

function resolve(definition: EntityDefinition): ResolvedEntityDefinition {
  return definition instanceof ResolvedEntityDefinition ? definition : new ResolvedEntityDefinition(definition);
}

export const SchemaBuilder = {
  /** CREATE TABLE(+ 번역 테이블 + fk 색인) 글 — 차례대로 돌린다 */
  createTableStatements(definition: EntityDefinition): string[] {
    const d = resolve(definition);
    const table = quoteIdentifier(d.entityName);
    const own = d.fields.filter((f) => !f.translated);
    const lines = own.map((f) => `  ${columnSql(f)}`);
    for (const u of d.uniques) lines.push(`  UNIQUE (${u.map(quoteIdentifier).join(', ')})`);
    const out = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`];
    for (const f of own) {
      if (f.type !== 'fk') continue;
      out.push(`CREATE INDEX ${quoteIdentifier(`idx.${d.entityName}.${f.name}`)} ON ${table} (${quoteIdentifier(f.name)})`);
    }
    if (d.hasTranslatedFields) out.push(SchemaBuilder.createTranslationTableStatement(d));
    return out;
  },

  /** `<entity>_translation` — 1차 로컬은 `locale` 문자열 칸(서버는 `language_id` → language) */
  createTranslationTableStatement(definition: EntityDefinition): string {
    const d = resolve(definition);
    const fk = translationForeignKey(d.entityName);
    const lines = [
      `  ${quoteIdentifier(fk)} TEXT NOT NULL REFERENCES ${quoteIdentifier(d.entityName)}(${quoteIdentifier('id')}) ON DELETE CASCADE`,
      `  ${quoteIdentifier('locale')} TEXT NOT NULL`,
      ...d.fields.filter((f) => f.translated).map((f) => `  ${columnSql(f, { inTranslation: true })}`),
      `  ${quoteIdentifier('created_at')} TEXT NOT NULL`,
      `  ${quoteIdentifier('updated_at')} TEXT`,
      `  PRIMARY KEY (${quoteIdentifier(fk)}, ${quoteIdentifier('locale')})`,
    ];
    return `CREATE TABLE ${quoteIdentifier(translationTableName(d.entityName))} (\n${lines.join(',\n')}\n)`;
  },

  /** 플러그인 extendFields 칸 — ALTER TABLE ADD COLUMN(SQLite: NOT NULL 이면 기본값이 있어야 한다) */
  addColumnStatement(entityName: string, field: FieldDefinition): string {
    if (field.primaryKey) throw new Error(`${entityName}.${field.name}: PK 칸은 ALTER 로 더할 수 없다`);
    if (field.required && field.defaultValue === undefined && !field.translated) {
      throw new Error(`${entityName}.${field.name}: 필수 칸을 더하려면 defaultValue 가 있어야 한다(SQLite ADD COLUMN 제약)`);
    }
    const table = field.translated ? translationTableName(entityName) : entityName;
    return `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${columnSql(field, { inTranslation: field.translated === true })}`;
  },

  async createTable(db: Kysely<any>, definition: EntityDefinition): Promise<void> {
    for (const s of SchemaBuilder.createTableStatements(definition)) await sql.raw(s).execute(db);
  },

  async addColumn(db: Kysely<any>, entityName: string, field: FieldDefinition): Promise<void> {
    await sql.raw(SchemaBuilder.addColumnStatement(entityName, field)).execute(db);
  },
};
