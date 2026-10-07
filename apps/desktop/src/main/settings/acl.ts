// R7-b — 권한(ACL). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 칸 이름은 Shopware `acl_role`(`id` · `name` · `description` · `privileges`) · `acl_user_role`(`user_id` · `acl_role_id`) 그대로(PLAN R7 §4).
// 권한 키는 서버 어드민 privilege 와 같은 꼴 `<엔티티>:<read|create|update|delete>`(예 `cmh_ai_conversation:read` ·
// CmhCore `src/Service/DataProvider/AclRoleProvider.php:42` 의 `acl_role:read`) — 서버 모드로 바꿔도 권한 뜻이 같다(원칙 6).
//
// 두 모드(PLAN R7 §5):
//   무료(로컬) = 사용자 하나 · 역할 `admin` 하나 · 사용자 admin 깃발이 켜져 있어 모든 권한(Shopware 처럼 admin 깃발 = 전부).
//   서버 모드 = 서버 로그인이 준 역할 목록을 주입받는다(네트워크 코드 없음).
//
// 내장 규칙(합의안 5 · 원칙 8): 승인 엔티티(`approval-entity.ts` 의 WRITE_PROTECTED_ENTITIES) 에 대한 «읽기 말고» 권한은
// 에이전트 신원에게 절대 주지 않는다 — admin 이어도. 사람이 누르는 UI 만(actor 'human') 받는다. Guard 의 같은 규칙과 목록을 같이 쓴다.

import { mentionsWriteProtectedEntity, normalizeEntityName } from './approval-entity.js';
import { isReadActionName } from './guard-policy.js';

export const ACL_OPERATIONS = ['read', 'create', 'update', 'delete'] as const;
export type AclOperation = (typeof ACL_OPERATIONS)[number];

/** Shopware `acl_role` 한 행 */
export interface AclRoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** 권한 키 목록(JSON string[]) */
  readonly privileges: readonly string[];
}

/** Shopware `acl_user_role` 한 행 */
export interface AclUserRoleRow {
  readonly user_id: string;
  readonly acl_role_id: string;
}

/** 사용자. `admin` = Shopware 사용자 admin 깃발(켜지면 역할과 상관없이 모든 권한 — 단 아래 내장 규칙은 예외) */
export interface AclUser {
  readonly id: string;
  readonly admin: boolean;
}

/**
 * 누가 권한을 쓰나. 'human' = 사람이 UI 에서 누른 것(main 의 UI IPC) · 'agent' = AI 에이전트 · 플러그인 · 외부 도구.
 * 【AI 임시 결정】 can() 에서 actor 를 빼면 'agent' 로 본다(모르면 막는 쪽 — Guard 의 listing 기본값과 같은 생각).
 */
export type AclActor = 'human' | 'agent';

export interface AclSource {
  readonly users: readonly AclUser[];
  readonly roles: readonly AclRoleRow[];
  readonly userRoles: readonly AclUserRoleRow[];
}

/** 【AI 임시 결정】 권한 키 길이 상한 */
export const PRIVILEGE_MAX = 255;
/** 권한 키 글자 — ASCII 글자 · 숫자 · `_` `.` `:` `-` (공백 · 비ASCII 금지 · Guard 도구 이름과 같은 생각) */
const PRIVILEGE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** 엔티티 권한 꼴 `<엔티티>:<동작>` */
const ENTITY_PRIVILEGE = /^([a-z0-9_]+):(read|create|update|delete)$/;

/** 엔티티 권한 키를 나눈다. `<snake_case 엔티티>:<read|create|update|delete>` 가 아니면 null */
export function parsePrivilege(privilege: string): { readonly entity: string; readonly operation: AclOperation } | null {
  const m = ENTITY_PRIVILEGE.exec(privilege);
  if (m === null) return null;
  return { entity: m[1] ?? '', operation: m[2] as AclOperation };
}

export function privilegeKey(entity: string, operation: AclOperation): string {
  const key = `${entity}:${operation}`;
  if (parsePrivilege(key) === null) throw new Error(`acl: invalid entity "${entity}" (snake_case ASCII)`);
  return key;
}

function isValidPrivilegeString(privilege: unknown): privilege is string {
  return typeof privilege === 'string' && privilege.length > 0 && privilege.length <= PRIVILEGE_MAX && PRIVILEGE_PATTERN.test(privilege);
}

/**
 * 승인 엔티티의 «읽기 말고» 권한인가(검수 7 🟡3).
 * ①권한 키 «전체» 어딘가에 보호 엔티티 이름이 들어 있지 않으면 false — 첫 `:` 앞만 보지 않는다
 *   (`x:cmh_ai_approval:update` · `entity:cmh_ai_approval:update` 처럼 앞에 마디를 붙여 비껴가지 못하게 · Guard 가 모든 마디를 훑는 것과 같은 생각).
 * ②들어 있으면, 정확히 `<snake_case 엔티티>:read`(parsePrivilege 꼴 · 소문자 그대로)일 때만 읽기 → false. 나머지는 전부 쓰기 → true.
 * 【AI 임시 결정】 읽기는 엔티티 이름을 «정확히» 본다 — `cmh_ai_approval_log:read` 처럼 이름 일부만 겹치는 다른 엔티티의 읽기는 막지 않는다
 *   (읽기는 승인 상태를 바꾸지 못한다). 쓰기는 «포함»으로 넓게 막는다(`cmh_ai_approval_log:create` 도 막힘 · 모르면 막는 쪽).
 *   `CMH_AI_APPROVAL:read` · `cmh_ai_approval:READ` · `cmhAiApproval:read` 처럼 꼴이 어긋난 «읽기»는 쓰기로 본다.
 */
export function isProtectedWritePrivilege(privilege: string): boolean {
  if (!mentionsWriteProtectedEntity(privilege)) return false;
  const parsed = parsePrivilege(privilege);
  return !(parsed !== null && parsed.operation === 'read');
}

/**
 * Guard 도구 동작 이름(`guard-policy.ts` READ_ACTIONS · `dal_` 앞붙이 · `-` · camelCase 맞춤은 isReadActionName 그대로) → ACL 동작(검수 7 🟢8).
 * 읽기 꼴(`search` · `dal_search` · `get` · `list` · `count` · `aggregate` · `find` · `read`)은 `read` 하나로 —
 * 부르는 쪽이 `<엔티티>:search` 같은 없는 권한 키를 만들어 읽기까지 막는 일(over-block)을 없앤다.
 * `create` · `update` · `delete`(앞 `dal_` 떼고)는 그대로. 그 밖(`upsert` · `sync` · `field_save` …)은 null —
 * 【AI 임시 결정】 하나의 ACL 동작으로 정할 수 없으니 부르는 쪽이 권한 없음으로 다룬다(모르면 막는 쪽).
 */
export function aclOperationForAction(action: string): AclOperation | null {
  if (isReadActionName(action)) return 'read';
  const n = normalizeEntityName(action);
  const bare = n.startsWith('dal_') ? n.slice(4) : n;
  return bare === 'create' || bare === 'update' || bare === 'delete' ? bare : null;
}

/** 엔티티 + Guard 동작 이름 → ACL 권한 키(`<엔티티>:<read|create|update|delete>`). 동작을 정할 수 없으면 null · 엔티티가 snake_case 가 아니면 예외(privilegeKey) */
export function privilegeForAction(entity: string, action: string): string | null {
  const operation = aclOperationForAction(action);
  return operation === null ? null : privilegeKey(entity, operation);
}

/** 역할 행 검증(서버가 준 JSON · 테이블 값). 모르는 꼴이면 예외 — 조용히 권한을 빼거나 넣지 않는다 */
export function parseAclRole(raw: unknown): AclRoleRow {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('acl: role must be an object');
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  const name = r['name'];
  const description = r['description'] ?? null;
  const privileges = r['privileges'];
  if (typeof id !== 'string' || id.length === 0) throw new Error('acl: role id must be a non-empty string');
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error(`acl: role "${id}" name must be a non-empty string`);
  if (description !== null && typeof description !== 'string') throw new Error(`acl: role "${id}" description must be a string or null`);
  if (!Array.isArray(privileges)) throw new Error(`acl: role "${id}" privileges must be an array`);
  for (const p of privileges) {
    if (!isValidPrivilegeString(p)) throw new Error(`acl: role "${id}" has an invalid privilege ${JSON.stringify(p)}`);
  }
  return { id, name, description, privileges: Object.freeze([...(privileges as string[])]) };
}

export class Acl {
  private readonly users = new Map<string, AclUser>();
  /** user_id → 그 사용자 역할들의 권한 합집합 */
  private readonly granted = new Map<string, ReadonlySet<string>>();

  constructor(source: AclSource) {
    for (const user of source.users) {
      if (this.users.has(user.id)) throw new Error(`acl: duplicate user "${user.id}"`);
      this.users.set(user.id, user);
    }
    const roles = new Map<string, AclRoleRow>();
    for (const role of source.roles) {
      if (roles.has(role.id)) throw new Error(`acl: duplicate role "${role.id}"`);
      roles.set(role.id, parseAclRole(role));
    }
    const byUser = new Map<string, Set<string>>();
    for (const link of source.userRoles) {
      if (!this.users.has(link.user_id)) throw new Error(`acl: acl_user_role refers to unknown user "${link.user_id}"`);
      const role = roles.get(link.acl_role_id);
      if (role === undefined) throw new Error(`acl: acl_user_role refers to unknown role "${link.acl_role_id}"`);
      const set = byUser.get(link.user_id) ?? new Set<string>();
      for (const p of role.privileges) set.add(p);
      byUser.set(link.user_id, set);
    }
    for (const [userId, set] of byUser) this.granted.set(userId, set);
  }

  /**
   * 권한이 있나. 차례: ①키 모양이 깨졌으면 false ②모르는 사용자 false ③승인 엔티티 «읽기 말고» + actor 가 사람이 아니면 false(admin 이어도)
   * ④admin 깃발 true ⑤역할 권한에 키가 정확히 있으면 true(대소문자 가림 — 서버 privilege 와 같은 글자만).
   */
  can(userId: string, privilege: string, actor: AclActor = 'agent'): boolean {
    if (!isValidPrivilegeString(privilege)) return false;
    const user = this.users.get(userId);
    if (user === undefined) return false;
    if (actor !== 'human' && isProtectedWritePrivilege(privilege)) return false;
    if (user.admin) return true;
    return this.granted.get(userId)?.has(privilege) ?? false;
  }
}

/** 무료(로컬) 모드의 사용자 · 역할 id 【AI 임시 결정】 — 고정 글자(한 PC 한 사용자 · 서버 id 와 섞이지 않는 이름) */
export const LOCAL_ADMIN_USER_ID = 'local-admin';
export const LOCAL_ADMIN_ROLE_ID = 'local-admin-role';
export const LOCAL_ADMIN_ROLE_NAME = 'admin';

/** 무료(로컬) 모드: 사용자 하나(admin 깃발) · 역할 `admin` 하나 */
export function createLocalAcl(): Acl {
  return new Acl({
    users: [{ id: LOCAL_ADMIN_USER_ID, admin: true }],
    roles: [{ id: LOCAL_ADMIN_ROLE_ID, name: LOCAL_ADMIN_ROLE_NAME, description: 'Local single user (all privileges)', privileges: [] }],
    userRoles: [{ user_id: LOCAL_ADMIN_USER_ID, acl_role_id: LOCAL_ADMIN_ROLE_ID }],
  });
}

export interface ServerLogin {
  readonly userId: string;
  readonly admin: boolean;
  /** 서버 로그인 응답의 역할들(검증은 parseAclRole) */
  readonly roles: readonly unknown[];
}

/** 서버 모드: 로그인한 사용자 하나 + 서버가 준 역할들(네트워크는 부르는 쪽이 한다) */
export function createServerAcl(login: ServerLogin): Acl {
  const roles = login.roles.map(parseAclRole);
  return new Acl({
    users: [{ id: login.userId, admin: login.admin }],
    roles,
    userRoles: roles.map((role) => ({ user_id: login.userId, acl_role_id: role.id })),
  });
}
