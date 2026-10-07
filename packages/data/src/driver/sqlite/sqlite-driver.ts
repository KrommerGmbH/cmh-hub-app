// R1 — SqliteDriver: Criteria parse() JSON → kysely(raw sql 조각 · 값은 전부 바인딩) → better-sqlite3.
// 칸 · 테이블 이름은 정의에서만 온다(사용자 글자가 SQL 이름으로 들어가지 않는다) · 모르는 것은 예외.
// 서버(MySQL utf8mb4_unicode_ci)와 다른 점: 글자 `=` · 정렬은 대소문자를 가른다(SQLite 기본 BINARY) · LIKE 는 ASCII 만 대소문자 무시.
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { translationForeignKey, translationTableName } from '../../definition/define-entity.js';
import type { EntityRegistry, ResolvedEntityDefinition } from '../../definition/registry.js';
import type { AssociationDefinition, Entity, FieldDefinition } from '../../definition/types.js';
import { isId, newId, snakeToCamel } from '../../naming.js';
import { isCompositeFilter, normalizeCriteria, type AggregationNode, type FilterNode, type LeafFilterNode, type NormalizedCriteria } from '../criteria-normalizer.js';
import { resolveFieldPath, resolveOwnField } from '../field-resolver.js';
import {
  CriteriaError,
  DataWriteError,
  type CriteriaInput,
  type EntityDriver,
  type EntitySearchResult,
  type IdSearchResult,
  type RawRow,
  type ReadOptions,
  type WriteResult,
} from '../types.js';
import { fromStorage, toStorage } from '../value-codec.js';
import { checkAggregationField, checkLeafFilter, checkSortField, filterStorage, validateCriteria } from '../criteria-rules.js';

type Scope = 'api' | 'system';
type Sql<T = unknown> = RawBuilder<T>;

/** 쿼리 안에서 엔티티 하나를 가리키는 별칭 묶음 */
interface TableScope {
  readonly def: ResolvedEntityDefinition;
  readonly alias: string;
  /** 번역 테이블 별칭(번역 칸이 없으면 null) */
  readonly tAlias: string | null;
}

/** IN (...) 한 번에 넣는 수 — SQLite 바인딩 상한(32766)보다 한참 아래 */
const IN_CHUNK = 500;

export interface SqliteDriverOptions {
  readonly db: Kysely<any>;
  readonly registry: EntityRegistry;
  /** 번역 칸을 읽고 쓸 locale(ko-KR · en-GB · de-DE) — 서버의 language_id 대신(1차 단순화) */
  readonly locale?: string;
}

function chunks<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function ref(alias: string, column: string): Sql {
  return sql.ref(`${alias}.${column}`);
}

function andAll(parts: Sql<SqlBool>[]): Sql<SqlBool> {
  return parts.length === 0 ? sql<SqlBool>`1 = 1` : sql<SqlBool>`${sql.join(parts, sql` AND `)}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class SqliteDriver implements EntityDriver {
  private readonly db: Kysely<any>;
  private readonly registry: EntityRegistry;
  private readonly locale: string;
  private aliasSeq = 0;

  constructor(options: SqliteDriverOptions) {
    this.db = options.db;
    this.registry = options.registry;
    // 서버 기본 언어(Shopware 시스템 언어)는 보통 en-GB — 앱은 R8 설정 locale 을 넘긴다
    this.locale = options.locale ?? 'en-GB';
  }

  // ───────────── 읽기 ─────────────

  async search(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<EntitySearchResult> {
    const def = this.registry.get(entityName);
    const c = this.prepare(def, criteria, options);
    return this.searchInternal(def, c, options.scope ?? 'api', null, true);
  }

  async searchIds(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<IdSearchResult> {
    const def = this.registry.get(entityName);
    const c = this.prepare(def, criteria, options);
    const scope = options.scope ?? 'api';
    const t = this.newScope(def);
    const where = this.documentWhere(t, c, scope, null);
    const rows = await this.rows(
      sql`SELECT ${ref(t.alias, 'id')} AS ${sql.id('id')} FROM ${this.fromSql(t)} WHERE ${where}${this.orderSql(t, c, scope)}${this.limitSql(c)}`,
    );
    const total = c.totalCountMode === 0 ? null : await this.count(t, where);
    return { total, ids: rows.map((r) => String(r['id'])) };
  }

  async get(entityName: string, id: string, criteria?: CriteriaInput, options: ReadOptions = {}): Promise<Entity | null> {
    if (!isId(id)) throw new CriteriaError(`${entityName}: id '${id}' 는 32자 hex 가 아니다`);
    const def = this.registry.get(entityName);
    const c = this.prepare(def, criteria ?? {}, options);
    const one: NormalizedCriteria = { ...c, ids: [id], page: null, limit: null, totalCountMode: 0, aggregations: [] };
    const r = await this.searchInternal(def, one, options.scope ?? 'api', null, false);
    return r.elements[0] ?? null;
  }

  async aggregate(entityName: string, criteria: CriteriaInput, options: ReadOptions = {}): Promise<Record<string, unknown>> {
    const def = this.registry.get(entityName);
    const c = this.prepare(def, criteria, options);
    const scope = options.scope ?? 'api';
    const t = this.newScope(def);
    return this.aggregations(t, c, scope);
  }

  /** 모양 검사 + 정의 검사(SQL 을 하나도 돌리기 전에 예외) */
  private prepare(def: ResolvedEntityDefinition, criteria: CriteriaInput, options: ReadOptions): NormalizedCriteria {
    const c = normalizeCriteria(criteria);
    validateCriteria(this.registry, def, c, options.scope ?? 'api');
    return c;
  }

  private async searchInternal(
    def: ResolvedEntityDefinition,
    c: NormalizedCriteria,
    scope: Scope,
    restrict: { column: string; values: readonly string[] } | null,
    withAggregations: boolean,
  ): Promise<EntitySearchResult> {
    const t = this.newScope(def);
    const where = this.documentWhere(t, c, scope, restrict);
    const fields = this.readableFields(def, scope);
    const select = sql.join(fields.map((f) => sql`${this.column(t, f)} AS ${sql.id(f.name)}`));
    const rows = await this.rows(sql`SELECT ${select} FROM ${this.fromSql(t)} WHERE ${where}${this.orderSql(t, c, scope)}${this.limitSql(c)}`);
    const elements = rows.map((row) => this.hydrate(fields, row));
    const total = c.totalCountMode === 0 ? null : await this.count(t, where);
    for (const [name, nested] of c.associations) await this.loadAssociation(def, elements, name, nested, scope);
    const aggregations = withAggregations ? await this.aggregations(this.newScope(def), c, scope) : {};
    return { total, elements, aggregations };
  }

  /** 문서 WHERE = filter + post-filter + ids (+ 연관 적재 때 부모 id) */
  private documentWhere(t: TableScope, c: NormalizedCriteria, scope: Scope, restrict: { column: string; values: readonly string[] } | null): Sql<SqlBool> {
    const parts = this.baseWhereParts(t, c, scope);
    for (const f of c.postFilters) parts.push(this.compileFilter(t, f, scope));
    if (restrict) parts.push(sql<SqlBool>`${ref(t.alias, restrict.column)} IN (${sql.join(restrict.values)})`);
    return andAll(parts);
  }

  /** 집계도 보는 WHERE = filter + ids (post-filter 는 문서만 · Shopware 와 같다) */
  private baseWhereParts(t: TableScope, c: NormalizedCriteria, scope: Scope): Sql<SqlBool>[] {
    const parts = c.filters.map((f) => this.compileFilter(t, f, scope));
    if (c.ids) parts.push(c.ids.length === 0 ? sql<SqlBool>`0 = 1` : sql<SqlBool>`${ref(t.alias, 'id')} IN (${sql.join(c.ids)})`);
    return parts;
  }

  private orderSql(t: TableScope, c: NormalizedCriteria, scope: Scope): Sql {
    if (c.sort.length === 0) return sql``;
    const parts = c.sort.map((s, i) => {
      const field = resolveOwnField(this.registry, t.def, s.field, scope, `sort[${i}]`);
      checkSortField(field, `sort[${i}]`);
      return sql`${this.column(t, field)} ${sql.raw(s.order)}`;
    });
    return sql` ORDER BY ${sql.join(parts)}`;
  }

  private limitSql(c: NormalizedCriteria): Sql {
    if (c.limit === null) return sql``;
    const offset = ((c.page ?? 1) - 1) * c.limit;
    return sql` LIMIT ${c.limit} OFFSET ${offset}`;
  }

  private async count(t: TableScope, where: Sql<SqlBool>): Promise<number> {
    const rows = await this.rows(sql`SELECT COUNT(*) AS ${sql.id('c')} FROM ${this.fromSql(t)} WHERE ${where}`);
    return Number(rows[0]?.['c'] ?? 0);
  }

  // ───────────── 필터 ─────────────

  private compileFilter(t: TableScope, f: FilterNode, scope: Scope): Sql<SqlBool> {
    if (isCompositeFilter(f)) {
      const glue = f.operator === 'and' ? sql` AND ` : sql` OR `;
      const inner = sql.join(
        f.queries.map((q) => this.compileFilter(t, q, scope)),
        glue,
      );
      return f.type === 'not' ? sql<SqlBool>`NOT (${inner})` : sql<SqlBool>`(${inner})`;
    }
    const path = resolveFieldPath(this.registry, t.def, f.field, scope);
    if (path.hops.length === 0) return this.leaf(t, path.field, f);
    // 연관 칸 — 하위 SELECT 로(to-many 는 «하나라도 맞으면» · 같은 multi 안 두 조건이 같은 줄일 필요는 없다 · Shopware 와 다를 수 있다)
    const hops = path.hops;
    const build = (outer: TableScope, i: number): Sql<SqlBool> => {
      const hop = hops[i];
      if (!hop) throw new CriteriaError(`${f.field}: 연관 경로를 풀 수 없다`);
      const inner = this.newScope(this.registry.get(hop.association.reference));
      const cond = i + 1 < hops.length ? build(inner, i + 1) : this.leaf(inner, path.field, f);
      return this.viaAssociation(outer, hop.association, inner, cond);
    };
    return build(t, 0);
  }

  private viaAssociation(outer: TableScope, a: AssociationDefinition, inner: TableScope, cond: Sql<SqlBool>): Sql<SqlBool> {
    switch (a.kind) {
      case 'manyToOne':
        return sql<SqlBool>`${ref(outer.alias, a.storageName)} IN (SELECT ${ref(inner.alias, 'id')} FROM ${this.fromSql(inner)} WHERE ${cond})`;
      case 'oneToMany':
        return sql<SqlBool>`${ref(outer.alias, 'id')} IN (SELECT ${ref(inner.alias, a.referenceField)} FROM ${this.fromSql(inner)} WHERE ${cond})`;
      case 'manyToMany': {
        const m = this.nextAlias('m');
        // 안쪽 FROM 에 번역 LEFT JOIN 이 붙을 수 있어 JOIN 대신 IN 을 두 겹으로
        return sql<SqlBool>`${ref(outer.alias, 'id')} IN (SELECT ${ref(m, a.mappingLocalColumn)} FROM ${sql.table(a.mappingTable)} AS ${sql.raw(m)} WHERE ${ref(m, a.mappingReferenceColumn)} IN (SELECT ${ref(inner.alias, 'id')} FROM ${this.fromSql(inner)} WHERE ${cond}))`;
      }
    }
  }

  private leaf(t: TableScope, field: FieldDefinition, f: LeafFilterNode): Sql<SqlBool> {
    const col = this.column(t, field);
    const at = `filter ${f.type}(${f.field})`;
    checkLeafFilter(field, f, at);
    switch (f.type) {
      case 'equals': {
        if (f.value === null) return sql<SqlBool>`${col} IS NULL`;
        return sql<SqlBool>`${col} = ${filterStorage(field, f.value, at)}`;
      }
      case 'equalsAny': {
        const hasNull = f.values.some((v) => v === null);
        const values = f.values.filter((v) => v !== null).map((v) => filterStorage(field, v, at));
        const parts: Sql<SqlBool>[] = [];
        if (values.length > 0) parts.push(sql<SqlBool>`${col} IN (${sql.join(values)})`);
        if (hasNull) parts.push(sql<SqlBool>`${col} IS NULL`);
        if (parts.length === 0) return sql<SqlBool>`0 = 1`;
        return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
      }
      case 'contains':
      case 'prefix':
      case 'suffix': {
        const v = escapeLike(f.value);
        const pattern = f.type === 'contains' ? `%${v}%` : f.type === 'prefix' ? `${v}%` : `%${v}`;
        return sql<SqlBool>`${col} LIKE ${pattern} ESCAPE '\\'`;
      }
      case 'range': {
        const ops = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
        const parts: Sql<SqlBool>[] = [];
        for (const [k, v] of Object.entries(f.parameters) as Array<[keyof typeof ops, string | number]>) {
          parts.push(sql<SqlBool>`${col} ${sql.raw(ops[k])} ${filterStorage(field, v, `${at}.${k}`)}`);
        }
        return andAll(parts);
      }
    }
  }

  // ───────────── 집계 ─────────────

  private async aggregations(t: TableScope, c: NormalizedCriteria, scope: Scope): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (c.aggregations.length === 0) return out;
    const where = andAll(this.baseWhereParts(t, c, scope));
    for (const a of c.aggregations) out[a.name] = await this.aggregation(t, a, where, scope);
    return out;
  }

  /** 결과 꼴(Shopware JSON · apiAlias 뺌): count {count} · sum {sum} · avg {avg} · min {min} · max {max} · terms {buckets:[{key,count}]} */
  private async aggregation(t: TableScope, a: AggregationNode, where: Sql<SqlBool>, scope: Scope): Promise<unknown> {
    const at = `aggregation ${a.type}(${a.name})`;
    const field = resolveOwnField(this.registry, t.def, a.field, scope, at);
    checkAggregationField(field, a, at);
    const col = this.column(t, field);
    const from = this.fromSql(t);
    switch (a.type) {
      case 'count': {
        // Shopware CountAggregation = 값이 다른 것을 센다고 본다(COUNT DISTINCT · 서버 실측 안 함)
        const rows = await this.rows(sql`SELECT COUNT(DISTINCT ${col}) AS ${sql.id('v')} FROM ${from} WHERE ${where}`);
        return { count: Number(rows[0]?.['v'] ?? 0) };
      }
      case 'sum':
      case 'avg': {
        const fn = a.type === 'sum' ? sql.raw('SUM') : sql.raw('AVG');
        const rows = await this.rows(sql`SELECT ${fn}(${col}) AS ${sql.id('v')} FROM ${from} WHERE ${where}`);
        const v = rows[0]?.['v'];
        // 줄이 없으면 sum = 0 · avg = null
        if (a.type === 'sum') return { sum: v === null || v === undefined ? 0 : Number(v) };
        return { avg: v === null || v === undefined ? null : Number(v) };
      }
      case 'min':
      case 'max': {
        const fn = a.type === 'min' ? sql.raw('MIN') : sql.raw('MAX');
        const rows = await this.rows(sql`SELECT ${fn}(${col}) AS ${sql.id('v')} FROM ${from} WHERE ${where}`);
        return { [a.type]: fromStorage(field, rows[0]?.['v'] ?? null) };
      }
      case 'terms': {
        let order: Sql = sql` ORDER BY ${sql.id('k')} ASC`;
        if (a.sort) {
          const dir = sql.raw(a.sort.order);
          if (a.sort.field === '_count') order = sql` ORDER BY ${sql.id('c')} ${dir}, ${sql.id('k')} ASC`;
          else if (resolveOwnField(this.registry, t.def, a.sort.field, scope, at) === field) order = sql` ORDER BY ${sql.id('k')} ${dir}`;
          else throw new CriteriaError(`${at}: terms 정렬은 그 칸 또는 _count 만 된다`);
        }
        const limit = a.limit === null ? sql`` : sql` LIMIT ${a.limit}`;
        const rows = await this.rows(
          sql`SELECT ${col} AS ${sql.id('k')}, COUNT(DISTINCT ${ref(t.alias, 'id')}) AS ${sql.id('c')} FROM ${from} WHERE ${where} GROUP BY ${col}${order}${limit}`,
        );
        // bucket key 는 글자(Shopware 와 같이) · bool 은 '1' · '0'
        return { buckets: rows.map((r) => ({ key: r['k'] === null || r['k'] === undefined ? null : String(r['k']), count: Number(r['c']) })) };
      }
    }
  }

  // ───────────── 연관 ─────────────

  private async loadAssociation(def: ResolvedEntityDefinition, parents: Entity[], name: string, nested: NormalizedCriteria, scope: Scope): Promise<void> {
    const a = def.association(name);
    if (!a) throw new CriteriaError(`${def.entityName}: 정의에 없는 연관 '${name}'`);
    if (nested.aggregations.length > 0) throw new CriteriaError(`${def.entityName}.${name}: 연관 안 aggregation 은 못 한다`);
    const target = this.registry.get(a.reference);
    // 연관 criteria 의 post-filter 는 filter 로 본다 · 연관 total 은 세지 않는다
    const inner: NormalizedCriteria = { ...nested, filters: [...nested.filters, ...nested.postFilters], postFilters: [], totalCountMode: 0 };

    if (a.kind === 'manyToOne') {
      // n:1 = 부모 fk 값으로 두 번째 SELECT · 쪽 나눔 없음
      const fkProp = snakeToCamel(a.storageName);
      const fkValues = [...new Set(parents.map((p) => p[fkProp]).filter((v): v is string => typeof v === 'string'))];
      const byId = new Map<string, Entity>();
      const one: NormalizedCriteria = { ...inner, page: null, limit: null, sort: [] };
      for (const part of chunks(fkValues)) {
        const r = await this.searchInternal(target, one, scope, { column: 'id', values: part }, false);
        for (const e of r.elements) byId.set(e.id, e);
      }
      for (const p of parents) {
        const fk = p[fkProp];
        p[a.propertyName] = typeof fk === 'string' ? (byId.get(fk) ?? null) : null;
      }
      return;
    }

    const parentIds = parents.map((p) => p.id);
    const all: NormalizedCriteria = { ...inner, page: null, limit: null };
    const grouped = new Map<string, Entity[]>(parentIds.map((id) => [id, []]));

    if (a.kind === 'oneToMany') {
      // 1:n = 부모 id 들로 SELECT … IN 한 번(500개씩) · 대상 쪽 fk 칸으로 묶는다
      const refProp = snakeToCamel(a.referenceField);
      if (!target.field(a.referenceField)) throw new CriteriaError(`${target.entityName}: 연관 칸 '${a.referenceField}' 이 정의에 없다`);
      for (const part of chunks(parentIds)) {
        const r = await this.searchInternal(target, all, scope, { column: a.referenceField, values: part }, false);
        for (const e of r.elements) {
          const key = e[refProp];
          if (typeof key === 'string') grouped.get(key)?.push(e);
        }
      }
    } else {
      // n:m = 중간 테이블에서 짝을 읽고 → 대상 id 로 SELECT(대상 정렬 차례를 지킨다)
      const pairs: Array<{ local: string; reference: string }> = [];
      for (const part of chunks(parentIds)) {
        const rows = await this.rows(
          sql`SELECT ${sql.id(a.mappingLocalColumn)} AS ${sql.id('l')}, ${sql.id(a.mappingReferenceColumn)} AS ${sql.id('r')} FROM ${sql.table(a.mappingTable)} WHERE ${sql.id(a.mappingLocalColumn)} IN (${sql.join(part)})`,
        );
        for (const r of rows) pairs.push({ local: String(r['l']), reference: String(r['r']) });
      }
      const refIds = [...new Set(pairs.map((p) => p.reference))];
      const ordered: Entity[] = [];
      for (const part of chunks(refIds)) {
        const r = await this.searchInternal(target, all, scope, { column: 'id', values: part }, false);
        ordered.push(...r.elements);
      }
      // 대상 차례를 지키려고 대상 기준으로 돈다
      const localsByRef = new Map<string, string[]>();
      for (const p of pairs) localsByRef.set(p.reference, [...(localsByRef.get(p.reference) ?? []), p.local]);
      for (const e of ordered) for (const local of localsByRef.get(e.id) ?? []) grouped.get(local)?.push(e);
    }

    // 연관 쪽 page/limit 은 부모마다 JS 에서 자른다(Shopware 는 부모마다 SQL 로 자른다 · 결과는 같다)
    const offset = nested.limit === null ? 0 : ((nested.page ?? 1) - 1) * nested.limit;
    for (const p of parents) {
      const list = grouped.get(p.id) ?? [];
      p[a.propertyName] = nested.limit === null ? list : list.slice(offset, offset + nested.limit);
    }
  }

  // ───────────── 쓰기 ─────────────

  async upsert(entityName: string, rows: readonly RawRow[]): Promise<WriteResult> {
    const def = this.registry.get(entityName);
    if (!Array.isArray(rows)) throw new DataWriteError(`${entityName}: upsert 는 배열을 받는다`);
    const prepared = rows.map((row, i) => this.prepareRow(def, row, `${entityName}[${i}]`));
    const seen = new Set<string>();
    for (const p of prepared) {
      if (seen.has(p.id)) throw new DataWriteError(`${entityName}: 한 번에 같은 id '${p.id}' 가 두 번 들어왔다`);
      seen.add(p.id);
    }
    const table = sql.table(def.entityName);
    try {
      await this.db.transaction().execute(async (trx) => {
        const existing = new Set<string>();
        for (const part of chunks(prepared.map((p) => p.id))) {
          const r = await sql<{ id: string }>`SELECT ${sql.id('id')} FROM ${table} WHERE ${sql.id('id')} IN (${sql.join(part)})`.execute(trx);
          for (const row of r.rows) existing.add(row.id);
        }
        const now = new Date().toISOString();
        for (const p of prepared) {
          if (existing.has(p.id)) {
            if (!p.own.has('updated_at')) p.own.set('updated_at', now);
            const sets = [...p.own].map(([k, v]) => sql`${sql.id(k)} = ${v}`);
            await sql`UPDATE ${table} SET ${sql.join(sets)} WHERE ${sql.id('id')} = ${p.id}`.execute(trx);
          } else {
            this.checkRequired(def, p, `${entityName}(${p.id})`);
            if (!p.own.has('created_at')) p.own.set('created_at', now);
            p.own.set('id', p.id);
            const cols = [...p.own.keys()].map((k) => sql.id(k));
            await sql`INSERT INTO ${table} (${sql.join(cols)}) VALUES (${sql.join([...p.own.values()])})`.execute(trx);
          }
          if (p.translated.size > 0) await this.writeTranslation(trx, def, p.id, p.translated, now);
        }
      });
    } catch (e) {
      if (e instanceof DataWriteError) throw e;
      throw new DataWriteError(`${entityName}: 쓰기 실패 — ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return { ids: prepared.map((p) => p.id) };
  }

  async delete(entityName: string, ids: readonly string[]): Promise<WriteResult> {
    const def = this.registry.get(entityName);
    for (const id of ids) if (!isId(id)) throw new DataWriteError(`${entityName}: id '${id}' 는 32자 hex 가 아니다`);
    const table = sql.table(def.entityName);
    const deleted: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const part of chunks([...new Set(ids)])) {
          const r = await sql<{ id: string }>`SELECT ${sql.id('id')} FROM ${table} WHERE ${sql.id('id')} IN (${sql.join(part)})`.execute(trx);
          const found = new Set(r.rows.map((x) => x.id));
          if (found.size === 0) continue;
          // 자식 줄은 FK ON DELETE CASCADE 가 지운다(서버 CascadeDelete 와 같다 · PRAGMA foreign_keys = ON)
          await sql`DELETE FROM ${table} WHERE ${sql.id('id')} IN (${sql.join([...found])})`.execute(trx);
          for (const id of part) if (found.has(id)) deleted.push(id);
        }
      });
    } catch (e) {
      throw new DataWriteError(`${entityName}: 지우기 실패 — ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return { ids: deleted };
  }

  private prepareRow(def: ResolvedEntityDefinition, row: RawRow, at: string): { id: string; own: Map<string, unknown>; translated: Map<string, unknown> } {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new DataWriteError(`${at}: 줄이 객체가 아니다`);
    const own = new Map<string, unknown>();
    const translated = new Map<string, unknown>();
    let id: string | null = null;
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue;
      const field = def.field(key);
      if (!field) {
        if (def.association(key)) throw new DataWriteError(`${at}: 연관 '${key}' 을 같이 쓰는 것은 아직 못 한다 — 엔티티마다 따로 upsert`);
        throw new DataWriteError(`${at}: 정의에 없는 칸 '${key}'`);
      }
      const target = field.translated ? translated : own;
      if (target.has(field.name)) throw new DataWriteError(`${at}: 칸 '${field.name}' 이 두 이름으로 두 번 들어왔다`);
      let stored: string | number | null;
      try {
        stored = toStorage(field, value, `${at}.${key}`);
      } catch (e) {
        throw new DataWriteError(e instanceof Error ? e.message : String(e), { cause: e });
      }
      if (field.primaryKey) {
        if (typeof stored !== 'string') throw new DataWriteError(`${at}: id 가 비었다`);
        id = stored;
        continue;
      }
      target.set(field.name, stored);
    }
    return { id: id ?? newId(), own, translated };
  }

  private checkRequired(def: ResolvedEntityDefinition, p: { own: Map<string, unknown>; translated: Map<string, unknown> }, at: string): void {
    // DEFAULT 가 있어도 서버 DAL 이 요구하는 칸(serverRequired)은 새 줄에서 값을 받아야 한다(requiredOnInsert 가 넣는다)
    for (const f of def.requiredOnInsert) {
      const v = f.translated ? p.translated.get(f.name) : p.own.get(f.name);
      if (v === undefined || v === null) throw new DataWriteError(`${at}: 필수 칸 '${snakeToCamel(f.name)}' 이 없다`);
    }
  }

  private async writeTranslation(trx: Kysely<any>, def: ResolvedEntityDefinition, id: string, values: Map<string, unknown>, now: string): Promise<void> {
    const fk = translationForeignKey(def.entityName);
    const cols = [fk, 'locale', ...values.keys(), 'created_at'];
    const vals = [id, this.locale, ...values.values(), now];
    const updates = [...values.keys()].map((k) => sql`${sql.id(k)} = excluded.${sql.id(k)}`);
    updates.push(sql`${sql.id('updated_at')} = ${now}`);
    await sql`INSERT INTO ${sql.table(translationTableName(def.entityName))} (${sql.join(cols.map((c) => sql.id(c)))}) VALUES (${sql.join(vals)})
      ON CONFLICT (${sql.id(fk)}, ${sql.id('locale')}) DO UPDATE SET ${sql.join(updates)}`.execute(trx);
  }

  // ───────────── 바탕 ─────────────

  private nextAlias(prefix: string): string {
    this.aliasSeq = (this.aliasSeq + 1) % 1_000_000;
    return `${prefix}${this.aliasSeq}`;
  }

  private newScope(def: ResolvedEntityDefinition): TableScope {
    const alias = this.nextAlias('e');
    return { def, alias, tAlias: def.hasTranslatedFields ? `${alias}t` : null };
  }

  private fromSql(t: TableScope): Sql {
    const base = sql`${sql.table(t.def.entityName)} AS ${sql.raw(t.alias)}`;
    if (!t.tAlias) return base;
    const fk = translationForeignKey(t.def.entityName);
    // 번역이 없는 줄도 나오게 LEFT JOIN — 서버의 «시스템 언어로 되돌아가기»(fallback)는 1차에 없다
    return sql`${base} LEFT JOIN ${sql.table(translationTableName(t.def.entityName))} AS ${sql.raw(t.tAlias)} ON ${ref(t.tAlias, fk)} = ${ref(t.alias, 'id')} AND ${ref(t.tAlias, 'locale')} = ${this.locale}`;
  }

  private column(t: TableScope, field: FieldDefinition): Sql {
    if (field.translated) {
      if (!t.tAlias) throw new CriteriaError(`${t.def.entityName}.${field.name}: 번역 테이블이 없다`);
      return ref(t.tAlias, field.name);
    }
    return ref(t.alias, field.name);
  }

  private readableFields(def: ResolvedEntityDefinition, scope: Scope): FieldDefinition[] {
    return def.fields.filter((f) => scope === 'system' || f.apiAware !== false);
  }

  private hydrate(fields: readonly FieldDefinition[], row: Record<string, unknown>): Entity {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[snakeToCamel(f.name)] = fromStorage(f, row[f.name]);
    return out as Entity;
  }

  private async rows(query: Sql): Promise<Record<string, unknown>[]> {
    const r = await query.execute(this.db);
    return r.rows as Record<string, unknown>[];
  }
}
