// R1 — 엔티티 등록 · 조회 · 플러그인 칸 더하기(Shopware EntityExtension 꼴 · 같은 칸 두 번이면 예외)
import { snakeToCamel } from '../naming.js';
import type { AssociationDefinition, EntityDefinition, FieldDefinition } from './types.js';

export class EntityDefinitionError extends Error {
  override readonly name = 'EntityDefinitionError';
}

/** 플러그인 확장 칸 저장 이름 — snake_case 소문자(서버 칸 이름 꼴 · SQL 이름으로 들어가므로 좁게 · 2026-10-07 검수) */
const EXTENSION_FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** 속성(camelCase)·저장(snake_case) 이름으로 칸을 찾는 정의 */
export class ResolvedEntityDefinition implements EntityDefinition {
  readonly entityName: string;
  private readonly fieldList: FieldDefinition[];
  private readonly associationList: AssociationDefinition[];
  private readonly byName = new Map<string, FieldDefinition>();
  private readonly associationByName = new Map<string, AssociationDefinition>();
  readonly uniques: readonly (readonly string[])[];

  constructor(definition: EntityDefinition) {
    this.entityName = definition.entityName;
    this.uniques = definition.uniques ?? [];
    this.fieldList = [];
    this.associationList = [];
    for (const f of definition.fields) this.addField(f);
    for (const a of definition.associations) this.addAssociation(a);
  }

  get fields(): readonly FieldDefinition[] {
    return this.fieldList;
  }

  get associations(): readonly AssociationDefinition[] {
    return this.associationList;
  }

  /** 저장 이름 · 속성 이름 · `<entityName>.` 접두 모두 받는다. 없으면 null */
  field(name: string): FieldDefinition | null {
    const bare = name.startsWith(`${this.entityName}.`) ? name.slice(this.entityName.length + 1) : name;
    return this.byName.get(bare) ?? null;
  }

  association(name: string): AssociationDefinition | null {
    return this.associationByName.get(name) ?? null;
  }

  get primaryKey(): FieldDefinition {
    const pk = this.fieldList.find((f) => f.primaryKey);
    if (!pk) throw new EntityDefinitionError(`${this.entityName}: primary key 없음`);
    return pk;
  }

  /**
   * 새 줄(INSERT)에 값이 있어야 하는 칸 — required 중 PK · created_at(드라이버가 채움) · DEFAULT 있는 칸은 빼되,
   * serverRequired(서버 DAL Required 인데 테이블 DEFAULT 가 있는 칸)는 넣는다.
   */
  get requiredOnInsert(): FieldDefinition[] {
    return this.fieldList.filter(
      (f) => f.required === true && !f.primaryKey && f.name !== 'created_at' && (f.defaultValue === undefined || f.serverRequired === true),
    );
  }

  get hasTranslatedFields(): boolean {
    return this.fieldList.some((f) => f.translated);
  }

  addField(field: FieldDefinition): void {
    const property = snakeToCamel(field.name);
    for (const key of new Set([field.name, property])) {
      if (this.byName.has(key) || this.associationByName.has(key)) {
        throw new EntityDefinitionError(`${this.entityName}: 칸 '${field.name}' 이(가) 이미 있다`);
      }
    }
    if (field.type === 'fk' && field.translated) throw new EntityDefinitionError(`${this.entityName}.${field.name}: fk 는 번역 칸이 될 수 없다`);
    if (field.primaryKey && field.translated) throw new EntityDefinitionError(`${this.entityName}.${field.name}: PK 는 번역 칸이 될 수 없다`);
    this.fieldList.push(field);
    this.byName.set(field.name, field);
    this.byName.set(property, field);
  }

  addAssociation(association: AssociationDefinition): void {
    const key = association.propertyName;
    if (this.associationByName.has(key) || this.byName.has(key)) {
      throw new EntityDefinitionError(`${this.entityName}: 연관 '${key}' 이(가) 이미 있다`);
    }
    this.associationList.push(association);
    this.associationByName.set(key, association);
  }
}

export class EntityRegistry {
  private readonly definitions = new Map<string, ResolvedEntityDefinition>();

  register(definition: EntityDefinition): ResolvedEntityDefinition {
    if (this.definitions.has(definition.entityName)) {
      throw new EntityDefinitionError(`엔티티 '${definition.entityName}' 이(가) 이미 등록됐다`);
    }
    const resolved = new ResolvedEntityDefinition(definition);
    this.definitions.set(definition.entityName, resolved);
    return resolved;
  }

  has(entityName: string): boolean {
    return this.definitions.has(entityName);
  }

  /** 모르는 엔티티면 예외 */
  get(entityName: string): ResolvedEntityDefinition {
    const d = this.definitions.get(entityName);
    if (!d) throw new EntityDefinitionError(`모르는 엔티티 '${entityName}'`);
    return d;
  }

  all(): ResolvedEntityDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * 플러그인이 칸을 더한다(Shopware EntityExtension 꼴). 테이블 칸은 플러그인 자기 Migration 이
   * `SchemaBuilder.addColumn` 으로 만든다 — 여기서는 정의만 바꾼다. 같은 칸이면 예외(조용히 덮지 않는다).
   */
  extendFields(entityName: string, fields: readonly FieldDefinition[]): void {
    const d = this.get(entityName);
    const seen = new Set<string>();
    for (const f of fields) {
      if (typeof f.name !== 'string' || !EXTENSION_FIELD_NAME.test(f.name)) {
        throw new EntityDefinitionError(`${entityName}: 확장 칸 이름 '${String(f.name)}' 은 ${EXTENSION_FIELD_NAME.source} 꼴이어야 한다`);
      }
      if (f.primaryKey) throw new EntityDefinitionError(`${entityName}.${f.name}: 확장 칸은 PK 가 될 수 없다`);
      if (seen.has(f.name)) throw new EntityDefinitionError(`${entityName}: 확장 칸 '${f.name}' 이(가) 두 번 들어왔다`);
      seen.add(f.name);
      if (d.field(f.name) || d.field(snakeToCamel(f.name)) || d.association(snakeToCamel(f.name))) {
        throw new EntityDefinitionError(`${entityName}: 칸 '${f.name}' 이(가) 이미 있다`);
      }
    }
    for (const f of fields) d.addField(f);
  }

  extendAssociations(entityName: string, associations: readonly AssociationDefinition[]): void {
    const d = this.get(entityName);
    for (const a of associations) d.addAssociation(a);
  }
}
