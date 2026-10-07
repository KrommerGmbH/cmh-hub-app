// R7-b — «에이전트 기본값 위에 작업별 덧씌움»(PLAN R7 §4). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
//
// 규칙(원칙 8 · 촘촘한 제어 — 위험한 일은 사람이 여는 문이 있어야 한다):
//   ①도구: 작업 덧씌움은 «더 조이기»만(ask · deny 를 더한다).
//     【AI 임시 결정】 덧씌움은 AI · 에이전트가 쓰는 자리다 → 덧씌움의 `allow` 는 «늘» 버리고 ignoredOverrides 에 적는다.
//     까닭(검수 7 🟡1): evaluateGuard 는 맞는 규칙이 0 일 때만 defaultMode 를 본다(guard → ask). 덧씌움 `{"**":"allow"}` 를 받으면
//     맞는 규칙이 없던 도구가 전부 ask → allow 로 풀려 AI 가 사람 확인을 끈다. 그래서 allow 는 어떤 글롭이든 받지 않는다.
//     ask · deny 는 evaluateGuard 가 맞는 규칙 «전부» 중 가장 무거운 것을 고르므로(guard-policy.ts evaluateGuard ③) 더해도 덜 막히지 않는다.
//   ②defaultMode: 저장된 값(에이전트 기본값 · 작업 덧씌움)은 `guard` 만 된다.
//     【AI 임시 결정】 `full` 은 저장 자리에 절대 들어가지 못한다 — parseAgentGuardPolicy · parseGuardPolicyOverride 가 `full` 을 거부하고,
//     mergeGuardPolicy 는 기본값 · 덧씌움에 `full` 이 들어오면 예외를 던진다. guard 를 푸는 길은 «그 실행 한 번»의 인자
//     `mergeGuardPolicy(def, ov, { fullForThisRun: true })` 하나뿐이다(PLAN R7 §9 «작업 단위 · 재시작하면 guard»).
//     사람이 화면에서 그 실행에 «full» 을 고른 경우에만 부르는 쪽이 이 깃발을 준다 — 저장된 자료로는 켤 수 없다.
//   ③자격증명: 같은 «더 조이기만» 차례 never > ask > whileUnlocked > always.
//     【AI 임시 결정】 기본값에 없는 사이트는 credentialAccessFor 의 기본값 ask 를 기준으로 본다 — 덧씌움이 always · whileUnlocked 로 풀지 못한다(마켓 계정).
//   ④내장 규칙(승인 엔티티 쓰기 deny · target 없는 DAL 쓰기 deny)은 evaluateGuard 안에 있어 어떤 합치기로도 풀리지 않는다.
//
// 합친 결과 EffectiveGuardPolicy 는 그 실행 동안만 메모리에 산다. 「저장되지 않는다」를 지키는 것은 위 ② 의 파서들이다.
// toJSON 예외는 «보조 그물»일 뿐이다 — spread · Object.assign · structuredClone 사본에서는 떨어진다(검수 7 🟡2 실측).
// 그 사본을 SettingsStore 에 넣어도 다시 읽을 때 parseAgentGuardPolicy · parseGuardPolicyOverride 가 `full` 에서 예외를 던진다.
//
// ignoredOverrides(로그 · 화면 안내용 · 【AI 임시 결정】 best effort):
//   - `tools:<글롭>` — 덧씌움 allow 전부 · 같은 글롭(대소문자 무시)의 기본값이 더 무거운 것 ·
//     글롭에 `*` 가 없는 덧씌움(도구 이름 하나)인데 기본값 규칙 · 내장 규칙이 그 이름에 더 무거운 결정을 내는 것.
//   - 한계: `*` 가 든 덧씌움 글롭이 «다른» 기본값 글롭에 덮이는지는 보지 않는다(글롭끼리 포함 관계 계산 — 비용 대비 쓸모가 적다).
//     그런 규칙은 결과에 남아 있지만 evaluateGuard 가 더 무거운 쪽을 고르므로 덜 막히는 일은 없다.
//   - `credentials:<사이트>` — 기준값보다 푸는 덧씌움.
//
// 검증은 guard-policy.ts parseGuardPolicy 를 그대로 쓴다(덧씌움은 defaultMode 를 빼도 된다는 것만 다르다).

import {
  credentialAccessFor,
  evaluateGuard,
  parseGuardPolicy,
  type CredentialAccess,
  type GuardMode,
  type GuardPolicy,
  type ToolDecision,
} from './guard-policy.js';

/** 작업별 덧씌움(검증된 꼴). defaultMode 는 저장 가능한 `guard` 만 */
export interface GuardPolicyOverride {
  readonly defaultMode?: 'guard';
  readonly tools?: Readonly<Record<string, ToolDecision>>;
  readonly credentials?: Readonly<Record<string, CredentialAccess>>;
}

export interface MergeGuardPolicyOptions {
  /**
   * true = 이 실행 한 번만 defaultMode `full`(맞는 규칙 없는 도구를 allow). 저장된 자료에서 오면 안 된다 —
   * 사람이 그 실행에 고른 값만 넘긴다. deny · 내장 규칙 · 처음 보는 도구 ask · requiresApproval 은 그대로다.
   */
  readonly fullForThisRun?: boolean;
}

declare const EFFECTIVE_GUARD_POLICY: unique symbol;

/**
 * 합친 정책 — 그 실행이 도는 동안만 메모리에 산다. 저장하지 않는다(브랜드 타입 · toJSON 예외는 보조 그물 · 정본은 저장용 파서의 full 거부).
 * `ignoredOverrides` = 덧씌움에서 효과가 없거나 버린 항목(`tools:<글롭>` · `credentials:<사이트>` · 머리 주석의 한계 참고).
 */
export type EffectiveGuardPolicy = GuardPolicy & {
  readonly [EFFECTIVE_GUARD_POLICY]: true;
  readonly ignoredOverrides: readonly string[];
};

const TOOL_SEVERITY: Readonly<Record<ToolDecision, number>> = { allow: 0, ask: 1, deny: 2 };
const CREDENTIAL_STRICTNESS: Readonly<Record<CredentialAccess, number>> = { always: 0, whileUnlocked: 1, ask: 2, never: 3 };

const FULL_NOT_STORABLE = 'defaultMode "full" cannot be stored — pass mergeGuardPolicy(…, { fullForThisRun: true }) for one run instead';

/**
 * 에이전트 기본값(저장된 JSON) 검증 — parseGuardPolicy 규칙 + defaultMode 는 `guard` 만.
 * 【AI 임시 결정】 저장 자리에서 `full` 이 살아나지 않게(PLAN R7 §9 «재시작하면 guard»).
 */
export function parseAgentGuardPolicy(raw: unknown): GuardPolicy {
  const parsed = parseGuardPolicy(raw);
  if (parsed.defaultMode !== 'guard') throw new Error(`guard policy (agent default): ${FULL_NOT_STORABLE}`);
  return parsed;
}

/** 덧씌움 JSON 검증 — parseGuardPolicy 와 같은 규칙(모르는 키 · 깨진 글롭 · 모르는 값은 예외) · defaultMode 는 빼도 되고 주면 `guard` 만 */
export function parseGuardPolicyOverride(raw: unknown): GuardPolicyOverride {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('guard policy override: must be an object');
  const hasMode = Object.hasOwn(raw, 'defaultMode');
  if (hasMode && (raw as Record<string, unknown>)['defaultMode'] === 'full') throw new Error(`guard policy override: ${FULL_NOT_STORABLE}`);
  // defaultMode 가 없으면 검증용 자리값 'guard' 를 넣어 parseGuardPolicy 를 지나게 한다 — 결과에는 넣지 않는다
  const parsed = parseGuardPolicy({ defaultMode: 'guard', ...(raw as Record<string, unknown>) });
  return hasMode ? { defaultMode: 'guard', tools: parsed.tools, credentials: parsed.credentials } : { tools: parsed.tools, credentials: parsed.credentials };
}

/** 에이전트 기본값 + 작업 덧씌움 → 그 실행의 정책(저장하지 않는다) */
export function mergeGuardPolicy(agentDefault: GuardPolicy, taskOverride: GuardPolicyOverride, options: MergeGuardPolicyOptions = {}): EffectiveGuardPolicy {
  // 타입을 비껴 들어온 full(캐스트 · parseGuardPolicy 결과를 그대로 넘김)도 막는다 — full 은 options 로만
  if (agentDefault.defaultMode !== 'guard') throw new Error(`guard policy merge: agent default ${FULL_NOT_STORABLE}`);
  const overrideMode: unknown = taskOverride.defaultMode;
  if (overrideMode !== undefined && overrideMode !== 'guard') throw new Error(`guard policy merge: override ${FULL_NOT_STORABLE}`);

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
    // 【AI 임시 결정】 덧씌움 allow 는 늘 버린다(머리 주석 ①)
    if (decision === 'allow') {
      ignored.push(`tools:${pattern}`);
      continue;
    }
    const lower = pattern.toLowerCase();
    const existing = keyByLower.get(lower);
    if (existing !== undefined) {
      const current = tools[existing] ?? 'allow';
      if (TOOL_SEVERITY[decision] > TOOL_SEVERITY[current]) tools[existing] = decision;
      else if (TOOL_SEVERITY[decision] < TOOL_SEVERITY[current]) ignored.push(`tools:${pattern}`);
      continue;
    }
    // best effort(검수 7 🟢7): `*` 없는 글롭 = 도구 이름 하나 → 기본값 규칙 · 내장 규칙이 그 이름에 내는 결정과 견준다.
    // listing: true = target 없는 DAL 쓰기 내장 규칙은 건너뛴다(인자가 없는 평가) · known: true = 처음 보는 도구 ask 는 빼고 본다.
    if (!pattern.includes('*')) {
      const byDefault = evaluateGuard(agentDefault, { tool: pattern, known: true, listing: true });
      if (byDefault.matchedPattern !== null && TOOL_SEVERITY[byDefault.decision] > TOOL_SEVERITY[decision]) {
        ignored.push(`tools:${pattern}`);
        continue; // 그 이름 하나에만 맞는 규칙이라 빼도 결과가 같다
      }
    }
    keyByLower.set(lower, pattern);
    tools[pattern] = decision;
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

  const defaultMode: GuardMode = options.fullForThisRun === true ? 'full' : 'guard';
  const effective = { defaultMode, tools, credentials, ignoredOverrides: Object.freeze(ignored) };
  // 보조 그물 — 이 객체 그대로 JSON 으로 바꾸려 하면 예외. 사본(spread 등)에서는 떨어진다(머리 주석 참고)
  Object.defineProperty(effective, 'toJSON', {
    enumerable: false,
    value: () => {
      throw new Error('guard policy: EffectiveGuardPolicy is per run and must not be persisted — persist the agent default and the override separately');
    },
  });
  Object.freeze(tools);
  Object.freeze(credentials);
  return Object.freeze(effective) as unknown as EffectiveGuardPolicy;
}
