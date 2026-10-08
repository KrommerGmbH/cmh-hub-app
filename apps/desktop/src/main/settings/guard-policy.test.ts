import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ENTITY_PATTERN,
  DAL_WRITE_WITHOUT_TARGET_PATTERN,
  MARKET_MCP_SERVER_CODES,
  credentialAccessFor,
  evaluateGuard,
  isDalWriteActionName,
  isReadActionName,
  isReadLikeToolName,
  matchToolPattern,
  mcpToolName,
  parseGuardPolicy,
  wildcardMatch,
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
    // 범용 DAL 쓰기는 target 이 없으면 내장 deny(3차 검수 차단 4) — 이 표는 글롭 차례를 보므로 평범한 엔티티 target 을 준다
    expect(evaluateGuard(base, { tool, known, target: { entity: 'product' } })).toEqual(expected);
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

describe('검수 차단 1 — 승인 엔티티 deny 우회', () => {
  const open = policy({ '**': 'allow' }, 'full');
  const denied = result('deny', APPROVAL_ENTITY_PATTERN);

  it('이름 마디에 공백 · 제어문자 · zero-width · 전각 · 비ASCII 가 있으면 deny(matchedPattern null)', () => {
    for (const tool of [
      'entity:cmh_ai_approval :update',
      'entity: cmh_ai_approval:update',
      'entity:cmh_ai_approval​:update',
      'entity:cmh＿ai＿approval:update',
      'entity:cmh_ai_approval\t:update',
      'entity:cmh_ai_approval\u0000:update',
      'market:naver:save ',
      'marKet:naver:save', // Kelvin 기호 — toLowerCase 하면 ASCII k
      'browser:navigaté',
      'x'.repeat(513),
    ]) {
      expect(evaluateGuard(open, { tool, known: true }), JSON.stringify(tool)).toEqual(result('deny', null));
    }
  });

  it('하이픈 꼴 · 대문자 · 이름 안 어느 마디든 승인 엔티티 쓰기는 deny', () => {
    for (const tool of [
      'entity:cmh-ai-approval:update',
      'entity:CMH_AI_APPROVAL:update',
      'plugin:foo:entity:cmh_ai_approval:update',
      'plugin:foo:cmh_ai_approval',
      'mcp:x:cmh_ai_approval_update',
      'mcp:x:cmh_ai_approval:dal_update',
      'mcp:x:cmh-ai-approval:read:more',
    ]) {
      expect(evaluateGuard(open, { tool, known: true }), tool).toEqual(denied);
    }
    // 읽기 꼴로 끝나면 정책대로
    expect(evaluateGuard(open, { tool: 'plugin:foo:entity:cmh_ai_approval:read', known: true })).toEqual(result('allow', '**'));
    expect(evaluateGuard(open, { tool: 'entity:cmh-ai-approval:dal_search', known: true })).toEqual(result('allow', '**'));
  });

  it('target.entity 가 cmh_ai_approval 이면 범용 DAL 쓰기 도구(dal_update · dal_create · dal_delete · dal_upsert · dal_sync)는 deny', () => {
    for (const action of ['dal_update', 'dal_create', 'dal_delete', 'dal_upsert', 'dal_sync', 'dal_write', 'execute']) {
      for (const entity of ['cmh_ai_approval', ' CMH-AI-APPROVAL ', 'Cmh_Ai_Approval']) {
        expect(evaluateGuard(open, { tool: `mcp:cmh-shop-api-mcp:${action}`, known: true, target: { entity } }), `${action} ${entity}`).toEqual(denied);
      }
    }
  });

  it('target.entity 가 cmh_ai_approval 이어도 읽기 꼴 도구(dal_search · dal_get · dal_aggregate · read · list)는 정책대로', () => {
    for (const action of ['dal_search', 'dal_get', 'dal_aggregate', 'read', 'search', 'get', 'list', 'dal-search']) {
      expect(evaluateGuard(open, { tool: `mcp:cmh-shop-api-mcp:${action}`, known: true, target: { entity: 'cmh_ai_approval' } }), action).toEqual(result('allow', '**'));
    }
    expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity: 'product' } })).toEqual(result('allow', '**'));
  });

  it('target.entity 이름이 깨졌으면(전각 · zero-width · 안쪽 공백) deny', () => {
    for (const entity of ['cmh＿ai＿approval', 'cmh_ai_approval​', 'cmh ai approval', '']) {
      expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity } }), JSON.stringify(entity)).toEqual(result('deny', null));
    }
  });

  it('isReadActionName — 읽기 표에 없으면 쓰기', () => {
    for (const a of ['read', 'search', 'get', 'list', 'dal_search', 'dal_get', 'dal_aggregate', 'DAL-GET']) expect(isReadActionName(a), a).toBe(true);
    for (const a of ['update', 'dal_update', 'dal_upsert', 'dal_sync', 'save', 'field_save', 'draft', 'readwrite']) expect(isReadActionName(a), a).toBe(false);
  });
});

describe('검수 차단 2 — 마켓 쓰기 · needsApproval 은 requiresApproval', () => {
  const full = policy({ '**': 'allow' }, 'full');

  it('market:* 은 읽기 동작 목록에 없으면 모두 쓰기(save · send · delete · update · upload · submit · field_save · save:draft · 대문자)', () => {
    for (const tool of [
      'market:naver:save',
      'market:naver:send',
      'market:naver:delete',
      'market:naver:update',
      'market:naver:upload',
      'market:naver:submit',
      'market:naver:field_save',
      'market:naver:save:draft',
      'market:naver:SAVE',
      'market:naver:product:list', // 동작 마디가 전부 읽기 꼴이 아니면 쓰기로 본다(모르면 막는 쪽)
      'market:naver',
    ]) {
      expect(evaluateGuard(full, { tool, known: true }), tool).toEqual(result('allow', '**', true));
    }
    for (const tool of ['market:naver:read', 'market:naver:list', 'market:naver:search', 'market:naver:get', 'market:naver:dal_search']) {
      expect(evaluateGuard(full, { tool, known: true }), tool).toEqual(result('allow', '**'));
    }
  });

  it('needsApproval(cmh_ai_mcp_tool.needs_approval) 은 OR — MCP 마켓 쓰기 도구도 승인 관문', () => {
    // 마켓 MCP 서버(MARKET_MCP_SERVER_CODES)의 쓰기 꼴 도구는 needsApproval 이 false 여도 승인 관문(검수 5 차단 2)
    for (const tool of ['mcp:cmh-camoufox-mcp:browser_field_save', 'mcp:cmh-market-mcp:naver_product_save']) {
      expect(evaluateGuard(full, { tool, known: true, needsApproval: true })).toEqual(result('allow', '**', true));
      expect(evaluateGuard(full, { tool, known: true, needsApproval: false })).toEqual(result('allow', '**', true));
      expect(evaluateGuard(full, { tool, known: true })).toEqual(result('allow', '**', true));
    }
    // 마켓 서버가 아니면 needsApproval 만 본다
    for (const tool of ['mcp:other-mcp:browser_field_save', 'mcp:x:naver_product_save']) {
      expect(evaluateGuard(full, { tool, known: true, needsApproval: true })).toEqual(result('allow', '**', true));
      expect(evaluateGuard(full, { tool, known: true, needsApproval: false })).toEqual(result('allow', '**'));
    }
    // deny 면 승인 관문까지 가지 않는다
    expect(evaluateGuard(policy({ 'mcp:**': 'deny' }), { tool: 'mcp:a:b', known: true, needsApproval: true })).toEqual(result('deny', 'mcp:**'));
    // ask 여도 승인 관문은 따로
    expect(evaluateGuard(policy({}), { tool: 'mcp:a:b', known: false, needsApproval: true })).toEqual(result('ask', null, true));
  });
});

describe('권고 — 글롭 지수 시간 · deny 마디 수 우회 · mcpToolName · credentials 중복', () => {
  it('** 열 개 + 30 마디가 50ms 안에', () => {
    const pattern = Array(10).fill('**').join(':') + ':z';
    const tool = Array(30).fill('a').join(':');
    const t0 = performance.now();
    expect(matchToolPattern(pattern, tool)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(matchToolPattern(pattern, `${tool}:z`)).toBe(true);
  });

  it('*a 열 개 + 60자 마디가 50ms 안에', () => {
    const pattern = '*a'.repeat(10) + '*b';
    const t0 = performance.now();
    expect(matchToolPattern(pattern, 'a'.repeat(60))).toBe(false);
    expect(matchToolPattern(`x:${pattern}`, 'x:' + 'a'.repeat(60))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it.each([
    ['*', '', true],
    ['*', 'abc', true],
    ['a*', 'abc', true],
    ['*c', 'abc', true],
    ['a*c', 'abbbc', true],
    ['a*b*c', 'axbxc', true],
    ['a*b*c', 'axbx', false],
    ['abc', 'abd', false],
    ['**', 'x', true],
    ['dal_*', 'dal_update', true],
  ])('wildcardMatch(%s, %s) → %s', (pattern, text, expected) => {
    expect(wildcardMatch(pattern, text)).toBe(expected);
  });

  it('deny 규칙의 마디 전체 * 는 «한 마디 이상» — mcp:evil:* 가 mcp:evil:a:b 도 막는다 · allow 는 한 마디 그대로', () => {
    const p = policy({ 'mcp:evil:*': 'deny', '**': 'allow' }, 'full');
    expect(evaluateGuard(p, { tool: 'mcp:evil:a', known: true })).toEqual(result('deny', 'mcp:evil:*'));
    expect(evaluateGuard(p, { tool: 'mcp:evil:a:b', known: true })).toEqual(result('deny', 'mcp:evil:*'));
    expect(evaluateGuard(p, { tool: 'mcp:evil', known: true })).toEqual(result('allow', '**'));
    const m = policy({ 'market:*:save': 'deny' }, 'full');
    expect(evaluateGuard(m, { tool: 'market:naver:product:save', known: true })).toEqual(result('deny', 'market:*:save'));
    // allow 규칙은 넓히지 않는다
    const a = policy({ 'browser:*': 'allow' }, 'guard');
    expect(evaluateGuard(a, { tool: 'browser:tab:open', known: true })).toEqual(result('ask', null));
    expect(matchToolPattern('mcp:evil:*', 'mcp:evil:a:b')).toBe(false);
  });

  it('mcpToolName — 서버 code · 도구 이름에 : 가 있으면 예외', () => {
    expect(mcpToolName('cmh-shop-api-mcp', 'dal_update')).toBe('mcp:cmh-shop-api-mcp:dal_update');
    expect(() => mcpToolName('evil', 'a:b')).toThrow(/guard/);
    expect(() => mcpToolName('ev:il', 'a')).toThrow(/guard/);
    expect(() => mcpToolName('evil', 'a b')).toThrow(/guard/);
    expect(() => mcpToolName('', 'a')).toThrow(/guard/);
  });

  it('credentials 대소문자만 다른 중복 → 예외', () => {
    expect(() => parseGuardPolicy({ defaultMode: 'guard', credentials: { Naver: 'never', naver: 'always' } })).toThrow(/duplicate credential/);
    expect(() => parseGuardPolicy({ defaultMode: 'guard', credentials: { naver: 'never', ' naver ': 'always' } })).toThrow(/duplicate credential/);
  });

  it('정책 글롭에 도구 이름에 올 수 없는 글자가 있으면 예외', () => {
    expect(() => parseGuardPolicy({ defaultMode: 'guard', tools: { 'entity:cmh＿ai:*': 'deny' } })).toThrow(/invalid character/);
    expect(() => parseGuardPolicy({ defaultMode: 'guard', tools: { 'a​:*': 'deny' } })).toThrow(/invalid character/);
  });
});

describe('3차 검수 차단 4 — target 없는 범용 DAL 쓰기', () => {
  const open = policy({ '**': 'allow' }, 'full');

  it('guard: target 없는 dal_update·dal_create·dal_delete 는 deny', () => {
    for (const action of ['dal_update', 'dal_create', 'dal_delete', 'dal_upsert', 'dal_sync', 'DAL-UPDATE']) {
      expect(evaluateGuard(open, { tool: `mcp:cmh-shop-api-mcp:${action}`, known: true }), action).toEqual(result('deny', DAL_WRITE_WITHOUT_TARGET_PATTERN));
    }
    // 읽기 꼴 dal_ 은 target 이 없어도 정책대로 · target 이 있으면 지금까지처럼 엔티티로 판정
    expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_search', known: true })).toEqual(result('allow', '**'));
    expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity: 'product' } })).toEqual(result('allow', '**'));
    // dal_ 이 아닌 도구는 이 규칙과 상관없다
    expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:update_price', known: true })).toEqual(result('allow', '**'));
  });

  it('listing:true(모델에게 보일지 정하는 평가)는 target 없는 dal_ 쓰기도 정책대로 — 승인 엔티티 이름은 그래도 deny', () => {
    expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, listing: true })).toEqual(result('allow', '**'));
    expect(evaluateGuard(open, { tool: 'mcp:x:cmh_ai_approval:dal_update', known: true, listing: true })).toEqual(result('deny', APPROVAL_ENTITY_PATTERN));
  });

  it('camelCase · 구분 없는 승인 엔티티 이름(cmhAiApproval · cmhaiapproval)도 승인 엔티티로 본다', () => {
    for (const entity of ['cmhAiApproval', 'CmhAiApproval', 'cmhaiapproval', 'cmh.ai.approval']) {
      expect(evaluateGuard(open, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity } }), entity).toEqual(result('deny', APPROVAL_ENTITY_PATTERN));
    }
    expect(evaluateGuard(open, { tool: 'mcp:x:cmhAiApproval:update', known: true })).toEqual(result('deny', APPROVAL_ENTITY_PATTERN));
  });
});

describe('Guard — camelCase 범용 DAL 쓰기도 target 없으면 deny (2026-10-07 RA 검수 4 남은 것)', () => {
  const policy = parseGuardPolicy({ defaultMode: 'full', tools: { '**': 'allow' } });
  it.each(['mcp:shop:dalUpdate', 'mcp:shop:DalDelete', 'mcp:shop:dal-create', 'mcp:shop:DAL_UPDATE'])('%s 는 target 없으면 deny', (tool) => {
    expect(evaluateGuard(policy, { tool, known: true }).decision).toBe('deny');
  });
  it('camelCase 읽기 꼴 dalSearch 는 target 없어도 정책대로', () => {
    expect(evaluateGuard(policy, { tool: 'mcp:shop:dalSearch', known: true }).decision).toBe('allow');
  });
});

describe('검수 5 차단 1 — 승인 결정 도구 · 승인 엔티티 연관 칸 쓰기는 정책과 상관없이 deny', () => {
  const full = policy({ '**': 'allow' }, 'full');
  it('승인 결정 도구 deny — market_approval_decide · market_approval_hold · form_create · camelCase · 붙인 꼴 · listing 포함', () => {
    for (const tool of [
      'mcp:cmh-market-mcp:market_approval_decide',
      'mcp:cmh-market-mcp:market_approval_hold',
      'mcp:cmh-market-mcp:market_approval_form_create',
      'mcp:x:marketApprovalDecide',
      'mcp:x:MARKET-APPROVAL-DECIDE',
      'mcp:x:approvals_update',
      'mcp:x:approval',
      'mcp:x:marketapprovaldecide', // 구분 없는 이름 — 읽기 낱말을 못 찾으니 막는다
      'market:naver:approval:decide',
      'app:approval_set',
    ]) {
      expect(evaluateGuard(full, { tool, known: true }), tool).toEqual(result('deny', 'builtin:approval-decision-tool'));
      expect(evaluateGuard(full, { tool, known: true, listing: true }).decision, tool).toBe('deny');
    }
  });

  it('승인 읽기 도구(market_approval_pending)와 서버 code 의 낱말은 막지 않는다', () => {
    expect(evaluateGuard(full, { tool: 'mcp:cmh-market-mcp:market_approval_pending', known: true })).toEqual(result('allow', '**'));
    expect(evaluateGuard(full, { tool: 'mcp:approval-sync:product_list', known: true })).toEqual(result('allow', '**'));
  });

  it('target.association(approvals 등)이 있으면 읽기 꼴이 아닌 도구는 deny · 읽기 도구(dal_search)는 정책대로', () => {
    for (const tool of ['mcp:cmh-shop-api-mcp:dal_update', 'mcp:cmh-shop-api-mcp:dal_upsert', 'mcp:x:http_request', 'mcp:x:dal.update']) {
      expect(evaluateGuard(full, { tool, known: true, target: { entity: 'cmh_ai_task', association: 'approvals' } }), tool).toEqual(
        result('deny', 'builtin:approval-association'),
      );
    }
    expect(evaluateGuard(full, { tool: 'mcp:x:http_request', known: true, target: { association: 'cmhAiDecidedApprovals' } })).toEqual(
      result('deny', 'builtin:approval-association'),
    );
    expect(evaluateGuard(full, { tool: 'mcp:cmh-shop-api-mcp:dal_search', known: true, target: { entity: 'cmh_ai_task', association: 'approvals' } })).toEqual(
      result('allow', '**'),
    );
  });
});

describe('검수 5 차단 2 — mcp:<마켓 서버>:* 는 읽기 꼴이 아니면 requiresApproval', () => {
  const full = policy({ '**': 'allow' }, 'full');
  it('camoufox · cmh-market-mcp 의 쓰기 꼴 도구는 needsApproval false 여도 requiresApproval', () => {
    for (const server of ['camoufox', 'cmh-camoufox-mcp', 'cmh-market-mcp', 'CMH-MARKET-MCP']) {
      for (const n of ['browser_api', 'browser_api_patch', 'browser_evaluate', 'browser_click', 'browser_type', 'browser_cookies_import', 'market_task_done', 'market_element_fix', 'talk_send']) {
        expect(evaluateGuard(full, { tool: `mcp:${server}:${n}`, known: true, needsApproval: false }), `${server}:${n}`).toEqual(result('allow', '**', true));
      }
      for (const n of ['browser_snapshot', 'browser_take_screenshot', 'market_product_search', 'market_screen_brief']) {
        expect(evaluateGuard(full, { tool: `mcp:${server}:${n}`, known: true, needsApproval: false }), `${server}:${n}`).toEqual(result('allow', '**'));
      }
    }
  });

  it('마켓 서버 목록은 세 번째 인자로 바꿔 넣을 수 있다(나중에 테이블에서 읽을 자리)', () => {
    expect(MARKET_MCP_SERVER_CODES.has('cmh-market-mcp')).toBe(true);
    const req = { tool: 'mcp:my-market:item_update', known: true, needsApproval: false } as const;
    expect(evaluateGuard(full, req)).toEqual(result('allow', '**'));
    expect(evaluateGuard(full, req, new Set(['My-Market']))).toEqual(result('allow', '**', true));
    expect(evaluateGuard(full, { tool: 'mcp:cmh-market-mcp:market_task_done', known: true }, new Set())).toEqual(result('allow', '**'));
  });

  it('isReadLikeToolName — 쓰기 낱말이 이기고 모르는 이름은 false', () => {
    for (const n of ['browser_snapshot', 'dal_search', 'getPrice', 'market_approval_pending', 'browser_wait_for']) expect(isReadLikeToolName(n), n).toBe(true);
    for (const n of ['browser_api', 'browser_api_patch', 'search_and_delete', 'echo', '', 'getAndUpdate']) expect(isReadLikeToolName(n), n).toBe(false);
  });
});

describe('검수 5 권고 6 — DAL 이름은 [._-] 를 떼고 ^dal 로 본다', () => {
  it('isDalWriteActionName — dal.update · dalupdate 도 쓰기 · dal.search · dalget 은 읽기', () => {
    for (const n of ['dal_update', 'dalUpdate', 'DalDelete', 'dal-update', 'dal.update', 'dalupdate', 'DAL_UPDATE', 'dal', 'dal_upsert']) expect(isDalWriteActionName(n), n).toBe(true);
    for (const n of ['dal_search', 'dal.search', 'dalget', 'DAL-AGGREGATE', 'product_update', 'update']) expect(isDalWriteActionName(n), n).toBe(false);
  });

  it('Guard: target 없는 dal.update · dalupdate 는 deny', () => {
    const full = policy({ '**': 'allow' }, 'full');
    for (const tool of ['mcp:s:dal.update', 'mcp:s:dalupdate']) {
      expect(evaluateGuard(full, { tool, known: true }), tool).toEqual(result('deny', DAL_WRITE_WITHOUT_TARGET_PATTERN));
    }
    expect(evaluateGuard(full, { tool: 'mcp:s:dal.search', known: true })).toEqual(result('allow', '**'));
  });
});
