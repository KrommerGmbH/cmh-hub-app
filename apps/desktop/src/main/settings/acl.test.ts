import { describe, expect, it } from 'vitest';
import {
  Acl,
  LOCAL_ADMIN_USER_ID,
  createLocalAcl,
  createServerAcl,
  isProtectedWritePrivilege,
  parseAclRole,
  parsePrivilege,
  privilegeKey,
} from './acl.js';

describe('parsePrivilege · privilegeKey (R7-b · Shopware privilege 꼴)', () => {
  it.each([
    ['cmh_ai_conversation:read', { entity: 'cmh_ai_conversation', operation: 'read' }],
    ['acl_role:delete', { entity: 'acl_role', operation: 'delete' }],
    ['cmh_ai_conversation:upsert', null],
    ['CmhAi:read', null],
    ['cmh_ai_conversation', null],
    ['a:b:read', null],
  ])('%s', (privilege, expected) => {
    expect(parsePrivilege(privilege)).toEqual(expected);
  });

  it('privilegeKey 는 snake_case ASCII 엔티티만', () => {
    expect(privilegeKey('cmh_ai_conversation', 'read')).toBe('cmh_ai_conversation:read');
    expect(() => privilegeKey('Cmh Ai', 'read')).toThrow('invalid entity');
  });
});

describe('isProtectedWritePrivilege (승인 엔티티 · approval-entity.ts 목록)', () => {
  it.each([
    ['cmh_ai_approval:read', false],
    ['cmh_ai_approval:create', true],
    ['cmh_ai_approval:update', true],
    ['cmh_ai_approval:delete', true],
    ['cmh_ai_approval:approve', true], // CRUD 밖 동작도 쓰기로
    ['CMH_AI_APPROVAL:create', true], // 대소문자로 비껴가기
    ['cmhAiApproval:update', true], // camelCase 로 비껴가기
    ['cmh.ai.approval:delete', true], // 구분 글자로 비껴가기
    ['cmh_ai_approval_line:read', true], // 이름 일부 — 모르면 막는 쪽(Guard 와 같음)
    ['cmh_ai_approval', true],
    ['cmh_ai_conversation:create', false],
  ])('%s → %s', (privilege, expected) => {
    expect(isProtectedWritePrivilege(privilege)).toBe(expected);
  });
});

describe('Acl.can (R7-b)', () => {
  it('로컬 모드: 사용자 하나 · admin 깃발 → 모든 권한(사람 · 에이전트)', () => {
    const acl = createLocalAcl();
    expect(acl.can(LOCAL_ADMIN_USER_ID, 'cmh_ai_conversation:read')).toBe(true);
    expect(acl.can(LOCAL_ADMIN_USER_ID, 'cmh_ai_mcp_server:delete', 'human')).toBe(true);
    expect(acl.can('someone-else', 'cmh_ai_conversation:read', 'human')).toBe(false);
  });

  it('승인 엔티티 쓰기는 admin 이어도 에이전트에게 절대 안 준다 · 사람 UI 만', () => {
    const acl = createLocalAcl();
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(acl.can(LOCAL_ADMIN_USER_ID, `cmh_ai_approval:${op}`)).toBe(false); // actor 빼면 agent
      expect(acl.can(LOCAL_ADMIN_USER_ID, `cmh_ai_approval:${op}`, 'agent')).toBe(false);
      expect(acl.can(LOCAL_ADMIN_USER_ID, `cmh_ai_approval:${op}`, 'human')).toBe(true);
    }
    expect(acl.can(LOCAL_ADMIN_USER_ID, 'cmh_ai_approval:read', 'agent')).toBe(true);
  });

  it('서버 모드: 주입받은 역할의 권한만 · 정확한 글자 · 승인 엔티티 쓰기는 역할에 있어도 에이전트 거부', () => {
    const acl = createServerAcl({
      userId: 'u1',
      admin: false,
      roles: [
        { id: 'r1', name: 'operator', description: null, privileges: ['cmh_ai_conversation:read', 'cmh_ai_conversation:create'] },
        { id: 'r2', name: 'approver', description: 'humans approve', privileges: ['cmh_ai_approval:read', 'cmh_ai_approval:update'] },
      ],
    });
    expect(acl.can('u1', 'cmh_ai_conversation:read')).toBe(true);
    expect(acl.can('u1', 'cmh_ai_conversation:create')).toBe(true);
    expect(acl.can('u1', 'cmh_ai_conversation:delete')).toBe(false);
    expect(acl.can('u1', 'CMH_AI_CONVERSATION:read')).toBe(false); // 서버 privilege 와 같은 글자만
    expect(acl.can('u1', 'cmh_ai_approval:update', 'human')).toBe(true);
    expect(acl.can('u1', 'cmh_ai_approval:update', 'agent')).toBe(false);
    expect(acl.can('u1', 'cmh_ai_approval:read', 'agent')).toBe(true);
  });

  it('서버 모드 admin 깃발 → 역할이 없어도 모든 권한(승인 엔티티 쓰기 에이전트 거부는 그대로)', () => {
    const acl = createServerAcl({ userId: 'boss', admin: true, roles: [] });
    expect(acl.can('boss', 'cmh_ai_model:delete')).toBe(true);
    expect(acl.can('boss', 'cmh_ai_approval:create')).toBe(false);
  });

  it.each(['', ' cmh_ai_conversation:read', 'cmh_ai_conversation:read​', 'cmh_ai_conversation:읽기', 'x'.repeat(300)])(
    '깨진 권한 키 %j 는 admin 이어도 false',
    (privilege) => {
      expect(createLocalAcl().can(LOCAL_ADMIN_USER_ID, privilege, 'human')).toBe(false);
    },
  );

  it('역할 검증: 깨진 행 · 모르는 참조 · 중복은 예외', () => {
    expect(() => parseAclRole(null)).toThrow('object');
    expect(() => parseAclRole({ id: 'r', name: 'n', privileges: 'x' })).toThrow('array');
    expect(() => parseAclRole({ id: 'r', name: 'n', privileges: ['ok:read', 'bad key'] })).toThrow('invalid privilege');
    expect(() => parseAclRole({ id: '', name: 'n', privileges: [] })).toThrow('id');
    expect(parseAclRole({ id: 'r', name: 'n', privileges: ['a:read'] })).toEqual({ id: 'r', name: 'n', description: null, privileges: ['a:read'] });
    expect(
      () => new Acl({ users: [{ id: 'u', admin: false }], roles: [], userRoles: [{ user_id: 'u', acl_role_id: 'missing' }] }),
    ).toThrow('unknown role');
    expect(
      () => new Acl({ users: [], roles: [{ id: 'r', name: 'n', description: null, privileges: [] }], userRoles: [{ user_id: 'ghost', acl_role_id: 'r' }] }),
    ).toThrow('unknown user');
    expect(() => new Acl({ users: [{ id: 'u', admin: false }, { id: 'u', admin: true }], roles: [], userRoles: [] })).toThrow('duplicate user');
    expect(() => createServerAcl({ userId: 'u', admin: false, roles: [{ id: 'r', name: 'n', privileges: [] }, { id: 'r', name: 'm', privileges: [] }] })).toThrow(
      'duplicate role',
    );
  });
});
