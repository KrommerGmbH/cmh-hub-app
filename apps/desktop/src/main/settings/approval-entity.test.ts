import { describe, expect, it } from 'vitest';

import { WRITE_PROTECTED_ENTITIES, isWriteProtectedEntity, mentionsWriteProtectedEntity, normalizeEntityName } from './approval-entity.js';
import { WRITE_PROTECTED_ENTITIES as FROM_MANIFEST } from '../plugin/plugin-manifest.js';
import { checkEntityAccess } from '../plugin/plugin-permissions.js';

describe('승인 엔티티 목록 한 곳(3차 검수 권고)', () => {
  it('normalizeEntityName — trim · camelCase 경계 · 소문자 · - → _', () => {
    expect(normalizeEntityName('  CMH-AI-APPROVAL ')).toBe('cmh_ai_approval');
    expect(normalizeEntityName('cmhAiApproval')).toBe('cmh_ai_approval');
    expect(normalizeEntityName('Cmh_Ai_Approval')).toBe('cmh_ai_approval');
    expect(normalizeEntityName('dal-search')).toBe('dal_search');
  });

  it('isWriteProtectedEntity — 맞춘 뒤 비교 · 다른 엔티티는 아니다', () => {
    for (const n of ['cmh_ai_approval', 'CMH-AI-APPROVAL', 'cmhAiApproval', 'cmhaiapproval', ' cmh.ai.approval ']) expect(isWriteProtectedEntity(n), n).toBe(true);
    for (const n of ['cmh_ai_agent', 'product', '', 'cmh_ai_approval_log']) expect(isWriteProtectedEntity(n), n).toBe(false);
    expect(mentionsWriteProtectedEntity('cmh_ai_approval_update')).toBe(true);
    expect(mentionsWriteProtectedEntity('product')).toBe(false);
  });

  it('플러그인 매니페스트 · 권한 검사가 같은 목록을 쓴다', () => {
    expect(FROM_MANIFEST).toBe(WRITE_PROTECTED_ENTITIES);
    for (const entity of ['cmh_ai_approval', 'cmhAiApproval', 'CMH-AI-APPROVAL']) {
      expect(checkEntityAccess([{ kind: 'entity', entity, access: 'crud', raw: `entity:${entity}:crud` }], entity, 'write').allowed, entity).toBe(false);
    }
  });
});
