// R7-b — «에이전트 기본값 위에 작업별 덧씌움»(PLAN R7 §4). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
//
// 규칙(원칙 8 · 촘촘한 제어 — 위험한 일은 사람이 여는 문이 있어야 한다):
//   ①도구: 작업 덧씌움은 «더 조이기»만(allow → ask → deny). 에이전트 기본값이 deny · ask 로 둔 규칙은 작업이 절대 풀지 못한다.
//     evaluateGuard 는 맞는 규칙 «전부» 중 가장 무거운 것을 고르므로(guard-policy.ts evaluateGuard ③), 두 규칙 묶음을 합치고
//     같은 글롭(대소문자 무시)이면 더 무거운 값을 남기면 된다 — 덧씌움의 allow 는 기본값의 deny · ask 규칙에 맞는 도구를 열지 못한다.
//     왜 풀지 못하게 하나: 작업 설정은 에이전트(AI)가 고르거나 작업마다 손쉽게 바뀌는 자리라, 여기서 풀리면 기본값의 deny 가 사람 확인 없이 무너진다.
//   ②defaultMode: 덧씌움이 `full` 을 줄 수 있다 — 단 그 작업 하나만(PLAN R7 §9 «Guard 를 full 로 바꾸는 것은 작업 단위 · 재시작하면 guard»).
//     그래서 합친 결과는 EffectiveGuardPolicy(브랜드 타입) — 저장하면 안 된다: 【AI 임시 결정】 toJSON 이 예외를 던져 SettingsStore.set 같은 JSON 저장이 실패한다.
//     덧씌움이 defaultMode 를 안 주면 에이전트 기본값의 모드 그대로(【AI 임시 결정】 기본값이 full 이어도 guard 로 바꾸지 않는다 — 기본값 저장 쪽 규칙은 이 파일 밖).
//   ③자격증명: 같은 «더 조이기만» 차례 never > ask > whileUnlocked > always.
//     【AI 임시 결정】 기본값에 없는 사이트는 credentialAccessFor 의 기본값 ask 를 기준으로 본다 — 덧씌움이 always · whileUnlocked 로 풀지 못한다(마켓 계정).
//   ④내장 규칙(승인 엔티티 쓰기 deny · target 없는 DAL 쓰기 deny)은 evaluateGuard 안에 있어 어떤 합치기로도 풀리지 않는다.
//
// 검증은 guard-policy.ts parseGuardPolicy 를 그대로 쓴다(덧씌움은 defaultMode 를 빼도 된다는 것만 다르다).

import { credentialAccessFor, parseGuardPolicy, type CredentialAccess, type GuardMode, type GuardPolicy, type ToolDecision } from './guard-policy.js';

/** 작업별 덧씌움(검증된 꼴) */
export interface GuardPolicyOverride {
  readonly defaultMode?: GuardMode;
  readonly tools?: Readonly<Record<string, ToolDecision>>;
  readonly credentials?: Readonly<Record<string, CredentialAccess>>;
}

declare const EFFECTIVE_GUARD_POLICY: unique symbol;

/**
 * 합친 정책 — 그 작업이 도는 동안만 메모리에 산다. 저장 금지(브랜드 + toJSON 예외).
 * `ignoredOverrides` = 덧씌움이 풀려고 했지만 무시된 항목(로그 · 화면 안내용 · `tools:<글롭>` · `credentials:<사이트>`).
 */
export type EffectiveGuardPolicy = GuardPolicy & {
  readonly [EFFECTIVE_GUARD_POLICY]: true;
  readonly ignoredOverrides: readonly string[];
};

const TOOL_SEVERITY: Readonly<Record<ToolDecision, number>> = { allow: 0, ask: 1, deny: 2 };
const CREDENTIAL_STRICTNESS: Readonly<Record<CredentialAccess, number>> = { always: 0, whileUnlocked: 1, ask: 2, never: 3 };

/** 덧씌움 JSON 검증 — parseGuardPolicy 와 같은 규칙(모르는 키 · 깨진 글롭 · 모르는 값은 예외) · defaultMode 는 빼도 된다 */
export function parseGuardPolicyOverride(raw: unknown): GuardPolicyOverride {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('guard policy override: must be an object');
  const hasMode = Object.hasOwn(raw, 'defaultMode');
  // defaultMode 가 없으면 검증용 자리값 'guard' 를 넣어 parseGuardPolicy 를 지나게 한다 — 결과에는 넣지 않는다
  const parsed = parseGuardPolicy({ defaultMode: 'guard', ...(raw as Record<string, unknown>) });
  return hasMode ? { defaultMode: parsed.defaultMode, tools: parsed.tools, credentials: parsed.credentials } : { tools: parsed.tools, credentials: parsed.credentials };
}

/** 에이전트 기본값 + 작업 덧씌움 → 그 작업의 정책(저장 금지) */
export function mergeGuardPolicy(agentDefault: GuardPolicy, taskOverride: GuardPolicyOverride): EffectiveGuardPolicy {
  const ignored: string[] = [];

  // 도구 — 기본값 키 차례를 먼저(같은 무게면 먼저 적힌 규칙이 matchedPattern) · 같은 글롭(소문자)이면 더 무거운 값
  const tools: Record<string, ToolDecision> = Object.create(null) as Record<string, ToolDecision>;
  const keyByLower = new Map<string, string>();
  for (const [pattern, decision] of Object.entries(agentDefault.tools)) {
    const lower = pattern.toLowerCase();
    const existing = keyByLower.get(lower);
    if (existing === undefined) {
      keyByLower.set(lower, pattern);
      tools[pattern] = decision;
    } else if (TOOL_SEVERITY[decision] > TOOL_SEVERITY[tools[existing] ?? 'allow']) {
      tools[existing] = decision;
    }
  }
  for (const [pattern, decision] of Object.entries(taskOverride.tools ?? {})) {
    const lower = pattern.toLowerCase();
    const existing = keyByLower.get(lower);
    if (existing === undefined) {
      keyByLower.set(lower, pattern);
      tools[pattern] = decision;
      continue;
    }
    const current = tools[existing] ?? 'allow';
    if (TOOL_SEVERITY[decision] > TOOL_SEVERITY[current]) tools[existing] = decision;
    else if (TOOL_SEVERITY[decision] < TOOL_SEVERITY[current]) ignored.push(`tools:${pattern}`);
  }

  // 자격증명 — 사이트 이름은 대소문자 · 앞뒤 공백 무시(credentialAccessFor 와 같음) · 키 글자는 기본값 쪽을 남긴다
  const credentials: Record<string, CredentialAccess> = Object.create(null) as Record<string, CredentialAccess>;
  const siteByLower = new Map<string, string>();
  for (const [site, access] of Object.entries(agentDefault.credentials)) {
    siteByLower.set(site.trim().toLowerCase(), site);
    credentials[site] = access;
  }
  for (const [site, access] of Object.entries(taskOverride.credentials ?? {})) {
    const lower = site.trim().toLowerCase();
    const key = siteByLower.get(lower) ?? site;
    const current = credentialAccessFor(agentDefault, lower); // 기본값에 없으면 ask
    if (CREDENTIAL_STRICTNESS[access] > CREDENTIAL_STRICTNESS[current]) credentials[key] = access;
    else {
      if (CREDENTIAL_STRICTNESS[access] < CREDENTIAL_STRICTNESS[current]) ignored.push(`credentials:${site}`);
      if (!siteByLower.has(lower)) credentials[key] = current; // 없던 사이트는 기준값(ask)을 적어 둔다 — 결과가 같다
    }
    siteByLower.set(lower, key);
  }

  const defaultMode: GuardMode = taskOverride.defaultMode ?? agentDefault.defaultMode;
  const effective = { defaultMode, tools, credentials, ignoredOverrides: Object.freeze(ignored) };
  // 저장 금지 — JSON 으로 바꾸려 하면 예외(설정 테이블 · 파일에 실수로 들어가 재시작 뒤에도 full 이 살아남지 않게)
  Object.defineProperty(effective, 'toJSON', {
    enumerable: false,
    value: () => {
      throw new Error('guard policy: EffectiveGuardPolicy is per task and must not be persisted — persist the agent default and the override separately');
    },
  });
  Object.freeze(tools);
  Object.freeze(credentials);
  return Object.freeze(effective) as unknown as EffectiveGuardPolicy;
}
