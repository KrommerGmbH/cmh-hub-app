import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ENTITY_PATTERN,
  credentialAccessFor,
  evaluateGuard,
  matchToolPattern,
  parseGuardPolicy,
  type GuardPolicy,
  type GuardResult,
} from './guard-policy.js';

const policy = (tools: Record<string, string>, defaultMode = 'guard', credentials: Record<string, string> = {}): GuardPolicy =>
  parseGuardPolicy({ defaultMode, tools, credentials });

const result = (decision: GuardResult['decision'], matchedPattern: string | null, requiresApproval = false): GuardResult => ({
  decision,
  requiresApproval,
  matchedPattern,
});

describe('matchToolPattern (R7-a 글롭 · `:` 구분)', () => {
  it.each([
    ['browser:navigate', 'browser:navigate', true],
    ['browser:*', 'browser:navigate', true],
    ['browser:*', 'browser:tab:open', false], // * 는 한 마디
    ['browser:**', 'browser:tab:open', true], // ** 는 여러 마디
    ['browser:**', 'browser', true], // ** 는 0 마디도
    ['mcp:*:dal_update', 'mcp:cmh-shop-api-mcp:dal_update', true],
    ['mcp:cmh-shop-api-mcp:dal_*', 'mcp:cmh-shop-api-mcp:dal_update', true],
    ['mcp:cmh-shop-api-mcp:dal_*', 'mcp:cmh-shop-api-mcp:frosh_status', false],
    ['**:save', 'market:naver:save', true],
    ['market:*:save', 'market:naver:product:save', false],
    ['MARKET:*:SAVE', 'market:Naver:save', true], // 대소문자 무시
    ['browser:navigate', 'browser:navigate:extra', false],
    ['*', 'browser::navigate', false], // 빈 마디는 깨진 이름
  ])('%s ~ %s → %s', (pattern, tool, expected) => {
    expect(matchToolPattern(pattern, tool)).toBe(expected);
  });
});

describe('evaluateGuard (R7-a 표)', () => {
  const base = policy({
    'mcp:cmh-shop-api-mcp:dal_update': 'ask',
    'market:*:save': 'deny',
    'browser:navigate': 'allow',
    'mcp:**': 'allow',
    'mcp:cmh-shop-api-mcp:*': 'ask',
    'mcp:cmh-shop-api-mcp:dal_delete': 'deny',
    'market:naver:send': 'allow',
  });

  it.each<[string, boolean, GuardResult]>([
    ['browser:navigate', true, result('allow', 'browser:navigate')],
    // 겹치면 deny > ask > allow
    ['mcp:cmh-shop-api-mcp:dal_update', true, result('ask', 'mcp:cmh-shop-api-mcp:dal_update')],
    ['mcp:cmh-shop-api-mcp:dal_delete', true, result('deny', 'mcp:cmh-shop-api-mcp:dal_delete')],
    ['mcp:cmh-shop-api-mcp:frosh_status', true, result('ask', 'mcp:cmh-shop-api-mcp:*')],
    ['mcp:other-mcp:tool', true, result('allow', 'mcp:**')],
    // 처음 보는 외부 도구는 allow 규칙에 맞아도 최소 ask
    ['mcp:other-mcp:tool', false, result('ask', 'mcp:**')],
    // 마켓 쓰기: deny 면 승인 필요 없음 · allow 여도 승인 관문
    ['market:naver:save', true, result('deny', 'market:*:save')],
    ['market:naver:send', true, result('allow', 'market:naver:send', true)],
    // 규칙 없음 + guard → ask
    ['browser:click', true, result('ask', null)],
    ['market:coupang:delete', true, result('ask', null, true)],
  ])('%s (known=%s)', (tool, known, expected) => {
    expect(evaluateGuard(base, { tool, known })).toEqual(expected);
  });

  it('규칙 차례와 상관없이 deny 가 이긴다', () => {
    const allowLast = policy({ 'browser:*': 'deny', 'browser:navigate': 'allow' });
    const denyLast = policy({ 'browser:navigate': 'allow', 'browser:*': 'deny' });
    expect(evaluateGuard(allowLast, { tool: 'browser:navigate', known: true })).toEqual(result('deny', 'browser:*'));
    expect(evaluateGuard(denyLast, { tool: 'browser:navigate', known: true })).toEqual(result('deny', 'browser:*'));
    const askAndAllow = policy({ 'skill:**': 'allow', 'skill:*:script': 'ask' });
    expect(evaluateGuard(askAndAllow, { tool: 'skill:pdf:script', known: true })).toEqual(result('ask', 'skill:*:script'));
  });

  it('기본 모드 둘: 맞는 규칙이 없으면 guard 는 ask · full 은 allow', () => {
    const req = { tool: 'browser:click', known: true };
    expect(evaluateGuard(policy({}, 'guard'), req)).toEqual(result('ask', null));
    expect(evaluateGuard(policy({}, 'full'), req)).toEqual(result('allow', null));
    // full 이어도 deny 규칙은 그대로
    expect(evaluateGuard(policy({ 'browser:*': 'deny' }, 'full'), req)).toEqual(result('deny', 'browser:*'));
  });

  it('처음 보는 외부 MCP 도구(known=false)는 full 모드에서도 최소 ask · deny 는 그대로', () => {
    const tool = 'mcp:new-server:run';
    expect(evaluateGuard(policy({}, 'full'), { tool, known: false })).toEqual(result('ask', null));
    expect(evaluateGuard(policy({ 'mcp:**': 'deny' }, 'full'), { tool, known: false })).toEqual(result('deny', 'mcp:**'));
  });

  it('마켓 쓰기(save · send · delete)는 allow 여도 requiresApproval · 읽기는 아니다', () => {
    const full = policy({ 'market:**': 'allow' }, 'full');
    for (const action of ['save', 'send', 'delete']) {
      expect(evaluateGuard(full, { tool: `market:naver:${action}`, known: true })).toEqual(result('allow', 'market:**', true));
    }
    expect(evaluateGuard(full, { tool: 'market:naver:read', known: true })).toEqual(result('allow', 'market:**'));
    expect(evaluateGuard(full, { tool: 'market:naver:product:save', known: true }).requiresApproval).toBe(true);
  });

  it('승인 엔티티(cmh_ai_approval) 쓰기는 allow 정책 · full 모드에서도 항상 deny · 읽기는 정책대로', () => {
    const open = policy({ '**': 'allow', 'entity:cmh_ai_approval:write': 'allow' }, 'full');
    for (const tool of [
      'entity:cmh_ai_approval:write',
      'entity:cmh_ai_approval:update',
      'entity:cmh_ai_approval:delete',
      'entity:cmh_ai_approval:upsert',
      'ENTITY:CMH_AI_APPROVAL:WRITE',
      'entity:cmh_ai_approval',
      'entity:cmh_ai_approval:read:decision',
    ]) {
      expect(evaluateGuard(open, { tool, known: true })).toEqual(result('deny', APPROVAL_ENTITY_PATTERN));
    }
    expect(evaluateGuard(open, { tool: 'entity:cmh_ai_approval:read', known: true })).toEqual(result('allow', '**'));
    expect(evaluateGuard(open, { tool: 'entity:cmh_ai_conversation:write', known: true }).decision).toBe('allow');
  });

  it('깨진 도구 이름(빈 마디 · * 들어감)은 deny', () => {
    const open = policy({ '**': 'allow' }, 'full');
    for (const tool of ['', 'browser:', ':navigate', 'browser:*']) {
      expect(evaluateGuard(open, { tool, known: true })).toEqual(result('deny', null));
    }
  });
});

describe('credentialAccessFor (자격증명 · 합의 ⑨)', () => {
  it('사이트가 있으면 그 값 · 없으면 ask', () => {
    const p = policy({}, 'guard', { naver: 'whileUnlocked', Coupang: 'never' });
    expect(credentialAccessFor(p, 'naver')).toBe('whileUnlocked');
    expect(credentialAccessFor(p, 'coupang')).toBe('never');
    expect(credentialAccessFor(p, 'gmarket')).toBe('ask');
  });
});

describe('parseGuardPolicy (정책 JSON 검증)', () => {
  it('PLAN R7 본보기 JSON 을 받는다 · tools/credentials 는 빠져도 된다', () => {
    const p = parseGuardPolicy({
      defaultMode: 'guard',
      tools: { 'mcp:cmh-shop-api-mcp:dal_update': 'ask', 'market:*:save': 'deny', 'browser:navigate': 'allow' },
      credentials: { naver: 'whileUnlocked' },
    });
    expect(p.defaultMode).toBe('guard');
    expect(Object.keys(p.tools)).toHaveLength(3);
    expect(parseGuardPolicy({ defaultMode: 'full' })).toEqual({ defaultMode: 'full', tools: {}, credentials: {} });
  });

  it.each<[string, unknown]>([
    ['객체가 아님', null],
    ['배열', []],
    ['모르는 defaultMode', { defaultMode: 'auto' }],
    ['defaultMode 없음', { tools: {} }],
    ['모르는 최상위 키', { defaultMode: 'guard', extra: 1 }],
    ['모르는 도구 결정', { defaultMode: 'guard', tools: { 'browser:*': 'maybe' } }],
    ['도구 결정이 문자열 아님', { defaultMode: 'guard', tools: { 'browser:*': true } }],
    ['빈 글롭', { defaultMode: 'guard', tools: { '': 'allow' } }],
    ['빈 마디', { defaultMode: 'guard', tools: { 'browser::x': 'allow' } }],
    ['** 가 마디 일부', { defaultMode: 'guard', tools: { 'browser:nav**': 'allow' } }],
    ['글롭에 공백', { defaultMode: 'guard', tools: { 'browser: navigate': 'allow' } }],
    ['tools 가 배열', { defaultMode: 'guard', tools: [] }],
    ['모르는 자격증명 값', { defaultMode: 'guard', credentials: { naver: 'sometimes' } }],
    ['빈 사이트 이름', { defaultMode: 'guard', credentials: { ' ': 'ask' } }],
  ])('%s → 예외', (_label, raw) => {
    expect(() => parseGuardPolicy(raw)).toThrow(/guard policy/);
  });

  it('JSON 키 "__proto__" 규칙도 잃지 않는다', () => {
    const p = parseGuardPolicy(JSON.parse('{"defaultMode":"full","tools":{"__proto__":"deny"}}'));
    expect(Object.keys(p.tools)).toEqual(['__proto__']);
  });
});
