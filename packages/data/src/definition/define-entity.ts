// R1 — 정의를 만들 때 Shopware 기본 칸을 붙인다
import type { AssociationDefinition, EntityDefinition, FieldDefinition } from './types.js';

/** Shopware `EntityDefinition::defaultFields()` = CreatedAtField(필수) · UpdatedAtField — 서버 테이블에도 있다 */
export const DEFAULT_FIELDS: readonly FieldDefinition[] = [
  { name: 'created_at', type: 'datetime', required: true },
  { name: 'updated_at', type: 'datetime' },
];

export interface EntityDefinitionInput {
  readonly entityName: string;
  /** id(PK)와 created_at · updated_at 은 넣지 않는다 — 여기서 붙인다 */
  readonly fields: readonly FieldDefinition[];
  readonly associations?: readonly AssociationDefinition[];
  readonly uniques?: readonly (readonly string[])[];
}

export function defineEntity(input: EntityDefinitionInput): EntityDefinition {
  return {
    entityName: input.entityName,
    fields: [{ name: 'id', type: 'id', primaryKey: true, required: true }, ...input.fields, ...DEFAULT_FIELDS],
    associations: input.associations ?? [],
    uniques: input.uniques ?? [],
  };
}

/** 번역 테이블 이름 — 1차 로컬은 칸 `locale`(ko-KR · en-GB · de-DE) 문자열로 줄였다. 서버는 `language_id`(→ language) · 2026-10-07 */
export function translationTableName(entityName: string): string {
  return `${entityName}_translation`;
}

export function translationForeignKey(entityName: string): string {
  return `${entityName}_id`;
}
