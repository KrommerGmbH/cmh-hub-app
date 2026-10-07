import { describe, expect, it } from 'vitest';
import { evaluateGuard, parseGuardPolicy, credentialAccessFor, type GuardPolicy } from './guard-policy.js';
import { mergeGuardPolicy, parseGuardPolicyOverride } from './guard-policy-merge.js';
import { InMemorySettingsBackend, SettingsStore } from './settings-store.js';

const agentDefault: GuardPolicy = parseGuardPolicy({
  defaultMode: 'guard',
  tools: {
    'market:*:save': 'deny',
    'mcp:cmh-shop-api-mcp:dal_update': 'ask',
    'browser:navigate': 'allow',
    'mcp:**': 'allow',
  },
  credentials: { naver: 'whileUnlocked', coupang: 'never' },
});

const call = (tool: string, known = true) => ({ tool, known });

describe('mergeGuardPolicy (R7-b · 에이전트 기본값 위에 작업별 덧씌움)', () => {
  it('덧씌움 없음 → 기본값과 같은 결정', () => {
    const merged = mergeGuardPolicy(agentDefault, {});
    for (const tool of ['market:naver:save', 'mcp:cmh-shop-api-mcp:dal_update', 'browser:navigate', 'mcp:x:y', 'app:echo']) {
      expect(evaluateGuard(merged, call(tool))).toEqual(evaluateGuard(agentDefault, call(tool)));
    }
    expect(merged.ignoredOverrides).toEqual([]);
  });

  it('더 조이기는 된다: allow → ask → deny', () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ tools: { 'browser:navigate': 'deny', 'mcp:x:*': 'ask' } }));
    expect(evaluateGuard(merged, call('browser:navigate')).decision).toBe('deny');
    expect(evaluateGuard(merged, call('mcp:x:y')).decision).toBe('ask');
    expect(evaluateGuard(merged, call('mcp:z:y')).decision).toBe('allow');
  });

  it('기본값의 deny · ask 는 같은 글롭(대소문자 무시)으로도 다른 글롭으로도 풀리지 않는다', () => {
    const override = parseGuardPolicyOverride({
      tools: {
        'market:*:save': 'allow',
        'MCP:CMH-SHOP-API-MCP:DAL_UPDATE': 'allow',
        'market:naver:save': 'allow',
        '**': 'allow',
      },
    });
    const merged = mergeGuardPolicy(agentDefault, override);
    expect(evaluateGuard(merged, call('market:naver:save')).decision).toBe('deny');
    expect(evaluateGuard(merged, call('market:naver:save')).matchedPattern).toBe('market:*:save');
    // target 을 줘야 한다 — 없으면 내장 규칙(target 없는 DAL 쓰기)이 먼저 deny
    const dalUpdate = { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity: 'product' } };
    expect(evaluateGuard(merged, dalUpdate).decision).toBe('ask');
    expect(merged.ignoredOverrides).toEqual(['tools:market:*:save', 'tools:MCP:CMH-SHOP-API-MCP:DAL_UPDATE']);
  });

  it('defaultMode full 은 작업 단위로 된다 — 맞는 규칙 없는 도구만 allow · deny 는 그대로', () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ defaultMode: 'full' }));
    expect(merged.defaultMode).toBe('full');
    expect(evaluateGuard(merged, call('app:echo')).decision).toBe('allow');
    expect(evaluateGuard(merged, call('market:naver:save')).decision).toBe('deny');
    expect(evaluateGuard(merged, call('app:echo', false)).decision).toBe('ask'); // 처음 보는 도구는 최소 ask
    expect(agentDefault.defaultMode).toBe('guard'); // 기본값은 바뀌지 않는다
  });

  it('내장 규칙(승인 엔티티 쓰기 · target 없는 DAL 쓰기)은 full + allow 덧씌움으로도 안 풀린다', () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ defaultMode: 'full', tools: { '**': 'allow' } }));
    expect(evaluateGuard(merged, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity: 'cmh_ai_approval' } }).decision).toBe('deny');
    expect(evaluateGuard(merged, call('mcp:cmh-shop-api-mcp:dal_delete')).decision).toBe('deny');
  });

  it('마켓 쓰기는 덧씌움 뒤에도 requiresApproval', () => {
    const base = parseGuardPolicy({ defaultMode: 'guard', tools: { 'market:naver:send': 'ask' }, credentials: {} });
    const merged = mergeGuardPolicy(base, parseGuardPolicyOverride({ defaultMode: 'full', tools: { 'market:naver:send': 'allow' } }));
    expect(evaluateGuard(merged, call('market:naver:send'))).toEqual({ decision: 'ask', requiresApproval: true, matchedPattern: 'market:naver:send' });
  });

  it('자격증명은 더 조이기만: never > ask > whileUnlocked > always · 없는 사이트는 ask 기준', () => {
    const merged = mergeGuardPolicy(
      agentDefault,
      parseGuardPolicyOverride({ credentials: { NAVER: 'never', coupang: 'always', gmarket: 'always', elevenst: 'never' } }),
    );
    expect(credentialAccessFor(merged, 'naver')).toBe('never');
    expect(credentialAccessFor(merged, 'coupang')).toBe('never');
    expect(credentialAccessFor(merged, 'gmarket')).toBe('ask');
    expect(credentialAccessFor(merged, 'elevenst')).toBe('never');
    expect(Object.keys(merged.credentials)).toEqual(['naver', 'coupang', 'gmarket', 'elevenst']); // 대소문자만 다른 키가 둘이 되지 않는다
    expect(merged.ignoredOverrides).toEqual(['credentials:coupang', 'credentials:gmarket']);
    // 합친 결과도 parseGuardPolicy 규칙(대소문자 중복 사이트 금지 등)을 지난다
    expect(() => parseGuardPolicy({ defaultMode: merged.defaultMode, tools: { ...merged.tools }, credentials: { ...merged.credentials } })).not.toThrow();
  });

  it('합친 결과는 저장 금지 — JSON.stringify · SettingsStore.set 이 실패한다', async () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ defaultMode: 'full' }));
    expect(() => JSON.stringify(merged)).toThrow('must not be persisted');
    const store = await SettingsStore.open(new InMemorySettingsBackend());
    // toJSON 은 열거되지 않는 칸이라 SettingsStore 의 보통 객체 검사는 지나고, JSON.stringify 에서 막힌다
    await expect(store.set('cmh.guard.policy', merged)).rejects.toThrow('must not be persisted');
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it('parseGuardPolicyOverride: parseGuardPolicy 와 같은 검증 · defaultMode 는 빼도 된다', () => {
    expect(parseGuardPolicyOverride({})).toEqual({ tools: {}, credentials: {} });
    expect(parseGuardPolicyOverride({ defaultMode: 'full' }).defaultMode).toBe('full');
    expect(() => parseGuardPolicyOverride({ defaultMode: 'yolo' })).toThrow('unknown defaultMode');
    expect(() => parseGuardPolicyOverride({ defaultMode: undefined })).toThrow('unknown defaultMode');
    expect(() => parseGuardPolicyOverride({ tools: { 'a b': 'allow' } })).toThrow('whitespace');
    expect(() => parseGuardPolicyOverride({ tools: { x: 'maybe' } })).toThrow('unknown decision');
    expect(() => parseGuardPolicyOverride({ extra: 1 })).toThrow('unknown key');
    expect(() => parseGuardPolicyOverride(null)).toThrow('must be an object');
  });
});
