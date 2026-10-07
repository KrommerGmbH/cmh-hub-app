// R1 — Criteria parse() JSON 을 검사해 안쪽 꼴로. 모르는 키 · filter type · 모양이 틀리면 예외(조용히 무시 0 · PLAN R1 §9).
// 두 driver 가 같이 쓴다 → 같은 Criteria 는 로컬이든 서버든 같은 곳에서 같은 예외.
import { isId } from '../naming.js';
import { CriteriaError, type CriteriaInput } from './types.js';

export type LogicalOperator = 'and' | 'or';
export type FilterValue = string | number | boolean | null;

export type LeafFilterNode =
  | { type: 'equals'; field: string; value: FilterValue }
  | { type: 'equalsAny'; field: string; values: FilterValue[] }
  | { type: 'contains' | 'prefix' | 'suffix'; field: string; value: string }
  | { type: 'range'; field: string; parameters: Partial<Record<RangeOperator, string | number>> };

export interface CompositeFilterNode {
  type: 'not' | 'multi';
  operator: LogicalOperator;
  queries: FilterNode[];
}

export type FilterNode = LeafFilterNode | CompositeFilterNode;

export function isCompositeFilter(f: FilterNode): f is CompositeFilterNode {
  return f.type === 'not' || f.type === 'multi';
}

export type RangeOperator = 'gt' | 'gte' | 'lt' | 'lte';

export interface SortNode {
  field: string;
  order: 'ASC' | 'DESC';
}

export type AggregationNode =
  | { type: 'count' | 'sum' | 'avg' | 'min' | 'max'; name: string; field: string }
  | { type: 'terms'; name: string; field: string; limit: number | null; sort: SortNode | null };

export interface NormalizedCriteria {
  page: number | null;
  limit: number | null;
  ids: string[] | null;
  filters: FilterNode[];
  postFilters: FilterNode[];
  sort: SortNode[];
  aggregations: AggregationNode[];
  associations: Map<string, NormalizedCriteria>;
  /** 0 = 안 셈 · 1 = 정확히 셈 · 2 = (Shopware 는 limit*5+1 까지) — 로컬은 1·2 둘 다 정확히 센다 */
  totalCountMode: 0 | 1 | 2;
}

const KNOWN_KEYS = new Set([
  'page',
  'limit',
  'ids',
  'term',
  'query',
  'filter',
  'post-filter',
  'sort',
  'aggregations',
  'groupFields',
  'grouping',
  'fields',
  'associations',
  'includes',
  'total-count-mode',
]);
/** 이 키들은 받되 비어 있어야 한다 — 값이 있으면 아직 못 하는 기능 → 예외 */
const UNSUPPORTED_KEYS = ['term', 'query', 'groupFields', 'grouping', 'fields', 'includes'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v === '';
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

export function criteriaToParams(criteria: CriteriaInput): Record<string, unknown> {
  const c = criteria as { parse?: unknown };
  if (typeof c.parse === 'function') return (criteria as { parse(): Record<string, unknown> }).parse();
  if (!isPlainObject(criteria)) throw new CriteriaError('Criteria 는 객체여야 한다');
  return criteria;
}

function fieldName(v: unknown, at: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new CriteriaError(`${at}: field 가 빈 글자다`);
  return v;
}

function filterValue(v: unknown, at: string): FilterValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new CriteriaError(`${at}: value 는 글자 · 수 · 참거짓 · null 이어야 한다`);
}

function operator(v: unknown, at: string): LogicalOperator {
  if (typeof v === 'string') {
    const o = v.toLowerCase();
    if (o === 'and' || o === 'or') return o;
  }
  throw new CriteriaError(`${at}: operator 는 and · or 다`);
}

export function normalizeFilter(raw: unknown, at: string): FilterNode {
  if (!isPlainObject(raw)) throw new CriteriaError(`${at}: filter 가 객체가 아니다`);
  const type = raw['type'];
  switch (type) {
    case 'equals':
      return { type, field: fieldName(raw['field'], at), value: filterValue(raw['value'], at) };
    case 'equalsAny': {
      // SDK 는 값들을 '|' 로 이어 보낸다(Criteria.equalsAny → value.join('|')) · 배열도 받는다
      const v = raw['value'];
      let values: FilterValue[];
      if (typeof v === 'string') values = v === '' ? [] : v.split('|');
      else if (Array.isArray(v)) values = v.map((x, i) => filterValue(x, `${at}.value[${i}]`));
      else throw new CriteriaError(`${at}: equalsAny value 는 '|' 로 이은 글자 또는 배열이다`);
      return { type, field: fieldName(raw['field'], at), values };
    }
    case 'contains':
    case 'prefix':
    case 'suffix': {
      const v = raw['value'];
      if (typeof v !== 'string' && typeof v !== 'number') throw new CriteriaError(`${at}: ${type} value 는 글자다`);
      return { type, field: fieldName(raw['field'], at), value: String(v) };
    }
    case 'range': {
      const p = raw['parameters'];
      if (!isPlainObject(p)) throw new CriteriaError(`${at}: range parameters 가 객체가 아니다`);
      const parameters: Partial<Record<RangeOperator, string | number>> = {};
      for (const [k, v] of Object.entries(p)) {
        if (k !== 'gt' && k !== 'gte' && k !== 'lt' && k !== 'lte') throw new CriteriaError(`${at}: range 연산자 '${k}' 는 모른다`);
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) throw new CriteriaError(`${at}: range ${k} 값이 글자 · 수가 아니다`);
        parameters[k] = v;
      }
      if (Object.keys(parameters).length === 0) throw new CriteriaError(`${at}: range 에 gt · gte · lt · lte 가 하나도 없다`);
      return { type, field: fieldName(raw['field'], at), parameters };
    }
    case 'not':
    case 'multi': {
      const qs = raw['queries'];
      if (!Array.isArray(qs) || qs.length === 0) throw new CriteriaError(`${at}: ${type} queries 가 비었다`);
      return { type, operator: operator(raw['operator'], at), queries: qs.map((q, i) => normalizeFilter(q, `${at}.queries[${i}]`)) };
    }
    default:
      throw new CriteriaError(`${at}: 모르는 filter type '${String(type)}'`);
  }
}

function normalizeSort(raw: unknown, at: string): SortNode {
  if (!isPlainObject(raw)) throw new CriteriaError(`${at}: sort 가 객체가 아니다`);
  if (raw['type'] !== undefined && raw['type'] !== null) throw new CriteriaError(`${at}: sort type '${String(raw['type'])}'(countSorting 등)은 못 한다`);
  const order = typeof raw['order'] === 'string' ? raw['order'].toUpperCase() : 'ASC';
  if (order !== 'ASC' && order !== 'DESC') throw new CriteriaError(`${at}: order 는 ASC · DESC 다`);
  // naturalSorting 은 무시한다 — SQLite 에 자연 정렬이 없다(서버와 차례가 다를 수 있다 · 2026-10-07)
  return { field: fieldName(raw['field'], at), order };
}

function positiveIntOrNull(v: unknown, at: string, key: string): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new CriteriaError(`${at}: ${key} 는 1 이상 정수다`);
  return n;
}

function normalizeAggregation(raw: unknown, at: string): AggregationNode {
  if (!isPlainObject(raw)) throw new CriteriaError(`${at}: aggregation 이 객체가 아니다`);
  const type = raw['type'];
  const name = raw['name'];
  if (typeof name !== 'string' || name === '') throw new CriteriaError(`${at}: aggregation name 이 비었다`);
  switch (type) {
    case 'count':
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return { type, name, field: fieldName(raw['field'], at) };
    case 'terms': {
      if (raw['aggregation'] !== undefined && raw['aggregation'] !== null) throw new CriteriaError(`${at}: terms 안 aggregation 은 못 한다`);
      const sort = raw['sort'] === undefined || raw['sort'] === null ? null : normalizeSort(raw['sort'], `${at}.sort`);
      return { type, name, field: fieldName(raw['field'], at), limit: positiveIntOrNull(raw['limit'], at, 'limit'), sort };
    }
    default:
      throw new CriteriaError(`${at}: 모르는 aggregation type '${String(type)}'`);
  }
}

function filterList(v: unknown, at: string): FilterNode[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new CriteriaError(`${at}: 배열이 아니다`);
  return v.map((f, i) => normalizeFilter(f, `${at}[${i}]`));
}

export function normalizeCriteria(input: CriteriaInput | Record<string, unknown>, at = 'criteria'): NormalizedCriteria {
  const p = criteriaToParams(input as CriteriaInput);
  for (const k of Object.keys(p)) {
    if (!KNOWN_KEYS.has(k)) throw new CriteriaError(`${at}: 모르는 키 '${k}'`);
  }
  for (const k of UNSUPPORTED_KEYS) {
    if (!isEmpty(p[k])) throw new CriteriaError(`${at}: '${k}' 는 아직 못 한다`);
  }

  let ids: string[] | null = null;
  const rawIds = p['ids'];
  if (!isEmpty(rawIds)) {
    const list = typeof rawIds === 'string' ? rawIds.split('|') : Array.isArray(rawIds) ? rawIds : null;
    if (!list) throw new CriteriaError(`${at}: ids 는 '|' 로 이은 글자 또는 배열이다`);
    for (const id of list) if (!isId(id)) throw new CriteriaError(`${at}: ids 에 32자 hex 가 아닌 값 '${String(id)}'`);
    ids = list as string[];
  }

  const sortRaw = p['sort'];
  if (sortRaw !== undefined && sortRaw !== null && !Array.isArray(sortRaw)) throw new CriteriaError(`${at}: sort 가 배열이 아니다`);
  const aggRaw = p['aggregations'];
  if (aggRaw !== undefined && aggRaw !== null && !Array.isArray(aggRaw)) throw new CriteriaError(`${at}: aggregations 가 배열이 아니다`);
  const aggregations = (aggRaw ?? []).map((a: unknown, i: number) => normalizeAggregation(a, `${at}.aggregations[${i}]`));
  const names = new Set<string>();
  for (const a of aggregations) {
    if (names.has(a.name)) throw new CriteriaError(`${at}: aggregation 이름 '${a.name}' 이 두 번 있다`);
    names.add(a.name);
  }

  const associations = new Map<string, NormalizedCriteria>();
  const assocRaw = p['associations'];
  if (assocRaw !== undefined && assocRaw !== null) {
    if (!isPlainObject(assocRaw)) throw new CriteriaError(`${at}: associations 가 객체가 아니다`);
    for (const [name, nested] of Object.entries(assocRaw)) {
      associations.set(name, normalizeCriteria(isPlainObject(nested) ? nested : {}, `${at}.associations.${name}`));
    }
  }

  const tcm = p['total-count-mode'];
  // 서버도 안 주면 0(Criteria::TOTAL_COUNT_MODE_NONE) — SDK 는 기본으로 1 을 실어 보낸다
  const totalCountMode = tcm === undefined || tcm === null ? 0 : Number(tcm);
  if (totalCountMode !== 0 && totalCountMode !== 1 && totalCountMode !== 2) throw new CriteriaError(`${at}: total-count-mode 는 0 · 1 · 2 다`);

  return {
    page: positiveIntOrNull(p['page'], at, 'page'),
    limit: positiveIntOrNull(p['limit'], at, 'limit'),
    ids,
    filters: filterList(p['filter'], `${at}.filter`),
    postFilters: filterList(p['post-filter'], `${at}.post-filter`),
    sort: (sortRaw ?? []).map((s: unknown, i: number) => normalizeSort(s, `${at}.sort[${i}]`)),
    aggregations,
    associations,
    totalCountMode,
  };
}
