import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ASSOCIATION_KEYS,
  APPROVAL_REQUEST_TOOL_NAMES,
  WRITE_PROTECTED_ENTITIES,
  isApprovalAssociationKey,
  isApprovalDecisionToolName,
  isApprovalRequestToolName,
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

  it('isApprovalDecisionToolName — 결정 · 쓰기 낱말이 있거나 화이트리스트(읽기 낱말 · 명사)를 벗어나면 true', () => {
    for (const n of ['market_approval_decide', 'marketApprovalDecide', 'approval', 'cmhaiapproval', 'mcp:s:approvals_set', 'market_approval_holdx', 'approval_hold', 'approval_create']) {
      expect(isApprovalDecisionToolName(n), n).toBe(true);
    }
    for (const n of ['market_approval_pending', 'mcp:cmh-market-mcp:market_approval_pending', 'approval_list', 'browser_api', 'mcp:approval-server:echo_list', 'market_task_done']) {
      expect(isApprovalDecisionToolName(n), n).toBe(false);
    }
  });

  it('검수 9 🟡4 화이트리스트 — 읽기 낱말 하나로는 못 지난다 · 마디를 건너 나뉜 승인 낱말도 막는다', () => {
    for (const n of [
      'approval_status_toggle',
      'approvalStatusFlip',
      'approval_detail_override',
      'approval_view_and_ok',
      'approvalz_vote',
      'approvalflip_list',
      'approval_list_x',
      'market:naver:appro:val_list',
      'aprobacion_approval_list_todo',
    ]) {
      expect(isApprovalDecisionToolName(n), n).toBe(true);
    }
    for (const n of ['approvals_list', 'cmh_ai_approval_list', 'mcp:x:market_approval_status', 'entity:cmh_ai_approval:dal_search', 'entity:cmh-ai-approval:get']) {
      expect(isApprovalDecisionToolName(n), n).toBe(false);
    }
  });

  it('검수 9 🟡1 승인 요청 도구(hold · form_create)는 결정 도구가 아니다 — 정확한 이름 · 게이트웨이 꼴만', () => {
    expect(APPROVAL_REQUEST_TOOL_NAMES).toEqual(['market_approval_hold', 'market_approval_form_create']);
    for (const n of [
      'market_approval_hold',
      'market_approval_form_create',
      'MARKET_APPROVAL_HOLD',
      'mcp:cmh-market-mcp:market_approval_hold',
      'mcp:cmh-gateway-mcp:market__market_approval_hold',
      'mcp:cmh-gateway-mcp:cmh-market-mcp__market_approval_form_create',
    ]) {
      expect(isApprovalRequestToolName(n), n).toBe(true);
      expect(isApprovalDecisionToolName(n), n).toBe(false);
    }
    for (const n of [
      'marketApprovalHold',
      'market_approval_hold_and_decide',
      'mcp:g:approval__market_approval_hold',
      'mcp:g:decide__market_approval_hold',
      'market_approval_pending',
    ]) {
      expect(isApprovalRequestToolName(n), n).toBe(false);
    }
    for (const n of ['marketApprovalHold', 'market_approval_hold_and_decide', 'mcp:g:approval__market_approval_hold', 'mcp:g:decide__market_approval_hold']) {
      expect(isApprovalDecisionToolName(n), n).toBe(true);
    }
  });

  it('isApprovalAssociationKey — 서버 정의의 연관 칸 이름(구분 · 대소문자 변형 포함) · 다른 키는 아니다', () => {
    expect(APPROVAL_ASSOCIATION_KEYS).toEqual(['approvals', 'cmhAiApprovals', 'cmhAiDecidedApprovals']);
    for (const k of ['approvals', 'Approvals', 'cmhAiApprovals', 'cmh_ai_approvals', 'cmhAiDecidedApprovals', 'cmh-ai-decided-approvals']) expect(isApprovalAssociationKey(k), k).toBe(true);
    for (const k of ['approval', 'approvalId', 'tasks', '', 'needsApproval']) expect(isApprovalAssociationKey(k), k).toBe(false);
  });
});
