import { describe, expect, it } from 'vitest';
import { evaluateGuard, parseGuardPolicy, credentialAccessFor, type GuardPolicy } from './guard-policy.js';
import { mergeGuardPolicy, parseAgentGuardPolicy, parseGuardPolicyOverride } from './guard-policy-merge.js';
import { InMemorySettingsBackend, SettingsStore } from './settings-store.js';

const agentDefault: GuardPolicy = parseAgentGuardPolicy({
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
    // 덧씌움 allow 는 전부 버린다(같은 글롭이든 아니든)
    expect(merged.ignoredOverrides).toEqual(['tools:market:*:save', 'tools:MCP:CMH-SHOP-API-MCP:DAL_UPDATE', 'tools:market:naver:save', 'tools:**']);
  });

  it('검수 7 🟡1: 덧씌움 {"**":"allow"} 는 guard 기본 ask 를 풀지 못한다(맞는 규칙 없는 app:echo)', () => {
    const base = parseAgentGuardPolicy({ defaultMode: 'guard', tools: { 'market:*:save': 'deny' }, credentials: {} });
    expect(evaluateGuard(base, call('app:echo')).decision).toBe('ask');
    const merged = mergeGuardPolicy(base, parseGuardPolicyOverride({ tools: { '**': 'allow', 'app:*': 'allow', 'app:echo': 'allow' } }));
    expect(evaluateGuard(merged, call('app:echo'))).toEqual({ decision: 'ask', requiresApproval: false, matchedPattern: null });
    expect(evaluateGuard(merged, call('mcp:x:dal_search')).decision).toBe('ask');
    expect(merged.defaultMode).toBe('guard');
    expect(Object.keys(merged.tools)).toEqual(['market:*:save']);
    expect(merged.ignoredOverrides).toEqual(['tools:**', 'tools:app:*', 'tools:app:echo']);
  });

  it('검수 7 🟢7: 도구 이름 하나짜리 덧씌움이 기본값의 더 무거운 다른 글롭에 덮이면 ignoredOverrides 에 적는다', () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ tools: { 'market:naver:save': 'ask', 'browser:navigate:x': 'ask', 'market:*:delete': 'ask' } }));
    expect(merged.ignoredOverrides).toEqual(['tools:market:naver:save']); // market:*:save deny 가 덮는다
    expect(Object.keys(merged.tools)).toContain('browser:navigate:x'); // 기본값에서 맞는 규칙 없음 → 남긴다
    expect(Object.keys(merged.tools)).toContain('market:*:delete'); // `*` 가 든 글롭은 견주지 않는다(한계)
    expect(evaluateGuard(merged, call('market:naver:save')).decision).toBe('deny');
  });

  it('defaultMode full 은 실행 인자 fullForThisRun 으로만 — 맞는 규칙 없는 도구만 allow · deny 는 그대로', () => {
    expect(mergeGuardPolicy(agentDefault, {}).defaultMode).toBe('guard');
    const merged = mergeGuardPolicy(agentDefault, {}, { fullForThisRun: true });
    expect(merged.defaultMode).toBe('full');
    expect(evaluateGuard(merged, call('app:echo')).decision).toBe('allow');
    expect(evaluateGuard(merged, call('market:naver:save')).decision).toBe('deny');
    expect(evaluateGuard(merged, call('app:echo', false)).decision).toBe('ask'); // 처음 보는 도구는 최소 ask
    expect(agentDefault.defaultMode).toBe('guard'); // 기본값은 바뀌지 않는다
  });

  it('내장 규칙(승인 엔티티 쓰기 · target 없는 DAL 쓰기)은 full + allow 덧씌움으로도 안 풀린다', () => {
    const merged = mergeGuardPolicy(agentDefault, parseGuardPolicyOverride({ tools: { '**': 'allow' } }), { fullForThisRun: true });
    expect(evaluateGuard(merged, { tool: 'mcp:cmh-shop-api-mcp:dal_update', known: true, target: { entity: 'cmh_ai_approval' } }).decision).toBe('deny');
    expect(evaluateGuard(merged, call('mcp:cmh-shop-api-mcp:dal_delete')).decision).toBe('deny');
  });

  it('마켓 쓰기는 덧씌움 뒤에도 requiresApproval', () => {
    const base = parseGuardPolicy({ defaultMode: 'guard', tools: { 'market:naver:send': 'ask' }, credentials: {} });
    const merged = mergeGuardPolicy(base, parseGuardPolicyOverride({ tools: { 'market:naver:send': 'allow' } }), { fullForThisRun: true });
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

  it('보조 그물: 합친 결과 그대로는 JSON.stringify · SettingsStore.set 이 실패한다', async () => {
    const merged = mergeGuardPolicy(agentDefault, {}, { fullForThisRun: true });
    expect(() => JSON.stringify(merged)).toThrow('must not be persisted');
    const store = await SettingsStore.open(new InMemorySettingsBackend());
    // toJSON 은 열거되지 않는 칸이라 SettingsStore 의 보통 객체 검사는 지나고, JSON.stringify 에서 막힌다
    await expect(store.set('cmh.guard.policy', merged)).rejects.toThrow('must not be persisted');
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it('검수 7 🟡2: spread · Object.assign · structuredClone 사본을 저장해도 full 로 다시 읽히지 않는다', async () => {
    const merged = mergeGuardPolicy(agentDefault, {}, { fullForThisRun: true });
    const copies: Record<string, unknown> = {
      spread: { ...merged },
      assign: Object.assign({}, merged),
      clone: structuredClone(merged),
      stripped: { defaultMode: merged.defaultMode, tools: { ...merged.tools }, credentials: { ...merged.credentials } },
    };
    const store = await SettingsStore.open(new InMemorySettingsBackend());
    for (const [label, copy] of Object.entries(copies)) {
      // 사본에는 toJSON 이 없어 SettingsStore 는 받는다(보조 그물의 한계) — 정본은 읽는 쪽 파서다
      await store.set(`cmh.guard.${label}`, copy);
      expect(() => store.get(`cmh.guard.${label}`, parseAgentGuardPolicy)).toThrow(/defaultMode "full" cannot be stored|unknown key/);
      expect(() => store.get(`cmh.guard.${label}`, parseGuardPolicyOverride)).toThrow(/defaultMode "full" cannot be stored|unknown key/);
    }
    // 머지에 직접 넣어도(타입을 비껴) full 은 받지 않는다
    expect(() => mergeGuardPolicy({ ...merged }, {})).toThrow('cannot be stored');
    expect(() => mergeGuardPolicy(agentDefault, { defaultMode: 'full' } as unknown as Parameters<typeof mergeGuardPolicy>[1])).toThrow('cannot be stored');
  });

  it('parseAgentGuardPolicy: parseGuardPolicy 규칙 + defaultMode 는 guard 만', () => {
    expect(parseAgentGuardPolicy({ defaultMode: 'guard', tools: { 'app:*': 'ask' } }).tools).toEqual({ 'app:*': 'ask' });
    expect(() => parseAgentGuardPolicy({ defaultMode: 'full' })).toThrow('cannot be stored');
    expect(() => parseAgentGuardPolicy({ defaultMode: 'yolo' })).toThrow('unknown defaultMode');
  });

  it('parseGuardPolicyOverride: parseGuardPolicy 와 같은 검증 · defaultMode 는 빼도 된다', () => {
    expect(parseGuardPolicyOverride({})).toEqual({ tools: {}, credentials: {} });
    expect(parseGuardPolicyOverride({ defaultMode: 'guard' }).defaultMode).toBe('guard');
    expect(() => parseGuardPolicyOverride({ defaultMode: 'full' })).toThrow('cannot be stored');
    expect(() => parseGuardPolicyOverride({ defaultMode: 'yolo' })).toThrow('unknown defaultMode');
    expect(() => parseGuardPolicyOverride({ defaultMode: undefined })).toThrow('unknown defaultMode');
    expect(() => parseGuardPolicyOverride({ tools: { 'a b': 'allow' } })).toThrow('whitespace');
    expect(() => parseGuardPolicyOverride({ tools: { x: 'maybe' } })).toThrow('unknown decision');
    expect(() => parseGuardPolicyOverride({ extra: 1 })).toThrow('unknown key');
    expect(() => parseGuardPolicyOverride(null)).toThrow('must be an object');
  });
});
