// R1 — 칸 종류 × 필터 · 정렬 · 집계 규칙과 Criteria 전체 검사. 두 driver 가 같이 쓴다:
// 서버로 보내기 전에도 같은 검사를 하므로, 같은 Criteria 는 로컬 · 서버에서 같은 곳에서 같은 예외를 낸다.
import type { EntityRegistry, ResolvedEntityDefinition } from '../definition/registry.js';
import type { FieldDefinition } from '../definition/types.js';
import { isCompositeFilter, type AggregationNode, type FilterNode, type LeafFilterNode, type NormalizedCriteria } from './criteria-normalizer.js';
import { resolveFieldPath, resolveOwnField } from './field-resolver.js';
import { CriteriaError } from './types.js';
import { toStorage, ValueError } from './value-codec.js';

/** 필터 값 → 저장 값(값 오류도 Criteria 오류로) */
export function filterStorage(field: FieldDefinition, value: unknown, at: string): string | number | null {
  try {
    return toStorage(field, value, at);
  } catch (e) {
    if (e instanceof ValueError) throw new CriteriaError(e.message);
    throw e;
  }
}

export function checkLeafFilter(field: FieldDefinition, f: LeafFilterNode, at: string): void {
  switch (f.type) {
    case 'equals':
      if (f.value !== null && field.type === 'json') throw new CriteriaError(`${at}: json 칸은 null 비교만 된다`);
      if (f.value !== null) filterStorage(field, f.value, at);
      return;
    case 'equalsAny':
      if (field.type === 'json') throw new CriteriaError(`${at}: json 칸은 equalsAny 를 못 한다`);
      for (const v of f.values) if (v !== null) filterStorage(field, v, at);
      return;
    case 'contains':
    case 'prefix':
    case 'suffix':
      if (field.type === 'int' || field.type === 'float' || field.type === 'bool') throw new CriteriaError(`${at}: ${field.type} 칸에는 ${f.type} 를 못 한다`);
      return;
    case 'range':
      if (field.type === 'bool' || field.type === 'json') throw new CriteriaError(`${at}: ${field.type} 칸에는 range 를 못 한다`);
      for (const [k, v] of Object.entries(f.parameters)) filterStorage(field, v, `${at}.${k}`);
      return;
  }
}

export function checkSortField(field: FieldDefinition, at: string): void {
  if (field.type === 'json') throw new CriteriaError(`${at}: json 칸 '${field.name}' 으로는 정렬하지 않는다`);
}

export function checkAggregationField(field: FieldDefinition, a: AggregationNode, at: string): void {
  switch (a.type) {
    case 'count':
      return;
    case 'sum':
    case 'avg':
      if (field.type !== 'int' && field.type !== 'float') throw new CriteriaError(`${at}: 수 칸이 아니다`);
      return;
    case 'min':
    case 'max':
      if (field.type === 'json' || field.type === 'bool') throw new CriteriaError(`${at}: ${field.type} 칸은 ${a.type} 를 못 한다`);
      return;
    case 'terms':
      if (field.type === 'json') throw new CriteriaError(`${at}: json 칸은 terms 를 못 한다`);
      return;
  }
}

function validateFilter(registry: EntityRegistry, def: ResolvedEntityDefinition, f: FilterNode, scope: 'api' | 'system'): void {
  if (isCompositeFilter(f)) {
    for (const q of f.queries) validateFilter(registry, def, q, scope);
    return;
  }
  const path = resolveFieldPath(registry, def, f.field, scope);
  checkLeafFilter(path.field, f, `filter ${f.type}(${f.field})`);
}

/** Criteria 전체를 정의에 대어 본다 — 모르는 칸 · 연관 · 안 되는 조합이면 예외 */
export function validateCriteria(registry: EntityRegistry, def: ResolvedEntityDefinition, c: NormalizedCriteria, scope: 'api' | 'system', nested = false): void {
  for (const f of [...c.filters, ...c.postFilters]) validateFilter(registry, def, f, scope);
  c.sort.forEach((s, i) => checkSortField(resolveOwnField(registry, def, s.field, scope, `sort[${i}]`), `sort[${i}]`));
  for (const a of c.aggregations) {
    const at = `aggregation ${a.type}(${a.name})`;
    if (nested) throw new CriteriaError(`${def.entityName}: 연관 안 aggregation 은 못 한다`);
    const field = resolveOwnField(registry, def, a.field, scope, at);
    checkAggregationField(field, a, at);
    if (a.type === 'terms' && a.sort && a.sort.field !== '_count' && resolveOwnField(registry, def, a.sort.field, scope, at) !== field) {
      throw new CriteriaError(`${at}: terms 정렬은 그 칸 또는 _count 만 된다`);
    }
  }
  for (const [name, inner] of c.associations) {
    const a = def.association(name);
    if (!a) throw new CriteriaError(`${def.entityName}: 정의에 없는 연관 '${name}'`);
    validateCriteria(registry, registry.get(a.reference), inner, scope, true);
  }
}
