import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ASSOCIATION_KEYS,
  WRITE_PROTECTED_ENTITIES,
  isApprovalAssociationKey,
  isApprovalDecisionToolName,
  isWriteProtectedEntity,
  mentionsWriteProtectedEntity,
  normalizeEntityName,
  toolNameWords,
} from './approval-entity.js';
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

describe('검수 5 차단 1 — 승인 결정 도구 이름 · 승인 엔티티 연관 칸 표', () => {
  it('toolNameWords — camelCase · 머리글자 · [._-] · 비ASCII 에서 나눈다', () => {
    expect(toolNameWords('marketApprovalDecide')).toEqual(['market', 'approval', 'decide']);
    expect(toolNameWords('HTTPPost_request')).toEqual(['http', 'post', 'request']);
    expect(toolNameWords('dal.update')).toEqual(['dal', 'update']);
    expect(toolNameWords('')).toEqual([]);
  });

  it('isApprovalDecisionToolName — 결정 · 쓰기 낱말이 있거나 읽기 낱말이 없으면 true', () => {
    for (const n of ['market_approval_decide', 'market_approval_hold', 'market_approval_form_create', 'marketApprovalDecide', 'approval', 'cmhaiapproval', 'mcp:s:approvals_set']) {
      expect(isApprovalDecisionToolName(n), n).toBe(true);
    }
    for (const n of ['market_approval_pending', 'mcp:cmh-market-mcp:market_approval_pending', 'approval_list', 'browser_api', 'mcp:approval-server:echo_list', 'market_task_done']) {
      expect(isApprovalDecisionToolName(n), n).toBe(false);
    }
  });

  it('isApprovalAssociationKey — 서버 정의의 연관 칸 이름(구분 · 대소문자 변형 포함) · 다른 키는 아니다', () => {
    expect(APPROVAL_ASSOCIATION_KEYS).toEqual(['approvals', 'cmhAiApprovals', 'cmhAiDecidedApprovals']);
    for (const k of ['approvals', 'Approvals', 'cmhAiApprovals', 'cmh_ai_approvals', 'cmhAiDecidedApprovals', 'cmh-ai-decided-approvals']) expect(isApprovalAssociationKey(k), k).toBe(true);
    for (const k of ['approval', 'approvalId', 'tasks', '', 'needsApproval']) expect(isApprovalAssociationKey(k), k).toBe(false);
  });
});
