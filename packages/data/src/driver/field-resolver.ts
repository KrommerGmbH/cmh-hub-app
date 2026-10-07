// R1 — Criteria 칸 이름 → 정의 칸. camelCase · snake_case · `<entity>.` 접두 · 연관 경로(`provider.active`) 를 받는다.
// 정의에 없으면 예외(조용히 무시 0). api 범위에서 비밀칸(apiAware false)도 예외.
import type { EntityRegistry, ResolvedEntityDefinition } from '../definition/registry.js';
import type { AssociationDefinition, FieldDefinition } from '../definition/types.js';
import { CriteriaError } from './types.js';

export interface ResolvedPath {
  /** 거쳐 가는 연관(앞에서부터) — 비면 자기 칸 */
  readonly hops: ReadonlyArray<{ readonly from: ResolvedEntityDefinition; readonly association: AssociationDefinition }>;
  readonly definition: ResolvedEntityDefinition;
  readonly field: FieldDefinition;
}

export function resolveFieldPath(
  registry: EntityRegistry,
  root: ResolvedEntityDefinition,
  path: string,
  scope: 'api' | 'system',
): ResolvedPath {
  const hops: Array<{ from: ResolvedEntityDefinition; association: AssociationDefinition }> = [];
  let def = root;
  let rest = path.startsWith(`${root.entityName}.`) ? path.slice(root.entityName.length + 1) : path;
  for (;;) {
    const direct = def.field(rest);
    if (direct) {
      if (scope === 'api' && direct.apiAware === false) throw new CriteriaError(`${def.entityName}.${direct.name}: 비밀칸은 api 범위에서 쓸 수 없다`);
      return { hops, definition: def, field: direct };
    }
    const dot = rest.indexOf('.');
    if (dot < 0) throw new CriteriaError(`${def.entityName}: 정의에 없는 칸 '${rest}'`);
    const assocName = rest.slice(0, dot);
    const association = def.association(assocName);
    if (!association) throw new CriteriaError(`${def.entityName}: 정의에 없는 칸 · 연관 '${assocName}'`);
    hops.push({ from: def, association });
    def = registry.get(association.reference);
    rest = rest.slice(dot + 1);
  }
}

/** 연관 경로를 허락하지 않는 곳(정렬 · 집계) */
export function resolveOwnField(registry: EntityRegistry, root: ResolvedEntityDefinition, path: string, scope: 'api' | 'system', at: string): FieldDefinition {
  const r = resolveFieldPath(registry, root, path, scope);
  if (r.hops.length > 0) throw new CriteriaError(`${at}: 연관 칸 '${path}' 으로는 아직 못 한다`);
  return r.field;
}
