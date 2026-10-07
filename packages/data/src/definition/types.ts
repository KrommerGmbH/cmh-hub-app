// R1 — 엔티티 정의 꼴(Shopware EntityDefinition 을 줄인 것 · 2026-10-07)
// 이름(entityName · 칸 저장 이름)은 서버 CmhAiAgent Definition 과 같아야 한다(research/05-cmhaiagent-entities.md).

export type FieldType = 'id' | 'string' | 'text' | 'int' | 'float' | 'bool' | 'json' | 'datetime' | 'date' | 'fk';

export type OnDelete = 'cascade' | 'set null' | 'restrict';

export interface FieldDefinition {
  /** 저장 이름(snake_case) — 속성 이름은 camelCase 로 만든다 */
  readonly name: string;
  readonly type: FieldType;
  readonly required?: boolean;
  /**
   * 서버 DAL 이 `Required` 로 요구하는데 테이블에 DEFAULT 가 있는 칸(2026-10-07 검수). 로컬은 DEFAULT 로 그냥 채워 주지만
   * 서버 sync 는 새 줄에 이 칸이 없으면 거절한다 → 로컬도 새 줄(INSERT)에서 값을 요구해 같은 곳에서 막는다. required 와 같이 쓴다.
   */
  readonly serverRequired?: boolean;
  readonly primaryKey?: boolean;
  /** false = 비밀칸(서버 `removeFlag(ApiAware)`) — api 범위 읽기 · 필터에서 빠진다. 기본 true */
  readonly apiAware?: boolean;
  /** true = `<entity>_translation` 테이블에 산다 */
  readonly translated?: boolean;
  /** fk 대상 엔티티 이름. 로컬에 없는 Shopware 코어 테이블(user · customer · media …)은 비워 둔다 → FK 제약 없이 id 칸만 */
  readonly reference?: string;
  /** fk 대상이 지워질 때(서버 CascadeDelete · SetNullOnDelete 에 맞춤) */
  readonly onDelete?: OnDelete;
  /** 서버 String(n) 의 n — 로컬 SQLite 는 길이를 강제하지 않는다(기록용) */
  readonly maxLength?: number;
  /** 서버 테이블 `NOT NULL DEFAULT x` 를 따라 한다 — 값이 있으면 칸은 NOT NULL 이고 안 주면 이 값 */
  readonly defaultValue?: string | number | boolean;
}

export interface ManyToOneAssociation {
  readonly kind: 'manyToOne';
  readonly propertyName: string;
  /** 이 엔티티 쪽 fk 칸 저장 이름 */
  readonly storageName: string;
  readonly reference: string;
}

export interface OneToManyAssociation {
  readonly kind: 'oneToMany';
  readonly propertyName: string;
  readonly reference: string;
  /** 대상 엔티티 쪽 fk 칸 저장 이름 */
  readonly referenceField: string;
}

export interface ManyToManyAssociation {
  readonly kind: 'manyToMany';
  readonly propertyName: string;
  readonly reference: string;
  /** 중간 테이블 이름(엔티티로 등록하지 않아도 된다) */
  readonly mappingTable: string;
  /** 중간 테이블에서 이 엔티티를 가리키는 칸 */
  readonly mappingLocalColumn: string;
  /** 중간 테이블에서 대상 엔티티를 가리키는 칸 */
  readonly mappingReferenceColumn: string;
}

export type AssociationDefinition = ManyToOneAssociation | OneToManyAssociation | ManyToManyAssociation;

export interface EntityDefinition {
  readonly entityName: string;
  readonly fields: readonly FieldDefinition[];
  readonly associations: readonly AssociationDefinition[];
  /** 서버 `UNIQUE KEY` 와 같은 칸 묶음(저장 이름) */
  readonly uniques?: readonly (readonly string[])[];
}

/** 응답 한 줄 — Shopware 처럼 camelCase 속성 객체 */
export type Entity = { id: string } & Record<string, unknown>;
