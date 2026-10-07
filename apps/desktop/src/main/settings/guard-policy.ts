// R7-a — Guard 정책 평가기. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// Aside Guard 꼴(research/01 «Guard»): 작업 단위 모드 guard(기본) / full · 도구 권한 allow / ask / deny · 겹치면 deny 가 이긴다.
// 합의안 5(PLAN «opus 검수 반영»): 승인 엔티티 cmh_ai_approval 쓰기는 main 의 UI IPC(사람 클릭)만 → 여기서는 어떤 정책이든 항상 deny.
// 처음 보는 외부 MCP 도구(known=false)는 최소 ask · 마켓 쓰기는 결과가 allow 여도 승인 관문(cmh_ai_approval)을 따로 거친다(requiresApproval).

export const GUARD_MODES = ['guard', 'full'] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export const TOOL_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

// whileUnlocked 는 Aside 값 — 앱 «잠금» 이 아직 정의되지 않아(합의 ⑨) 기본은 ask
export const CREDENTIAL_ACCESS = ['always', 'whileUnlocked', 'never', 'ask'] as const;
export type CredentialAccess = (typeof CREDENTIAL_ACCESS)[number];

export interface GuardPolicy {
  readonly defaultMode: GuardMode;
  /** 키 = 글롭(`:` 구분 · `*` 한 마디 · `**` 0 마디 이상) · 값 = 결정 */
  readonly tools: Readonly<Record<string, ToolDecision>>;
  /** 키 = 사이트 이름(예 naver) · 값 = 에이전트의 자격증명 접근 */
  readonly credentials: Readonly<Record<string, CredentialAccess>>;
}

export interface GuardRequest {
  /** 예 'mcp:cmh-shop-api-mcp:dal_update' · 'market:naver:save' · 'browser:navigate' · 'skill:<name>:script' */
  readonly tool: string;
  /** 처음 보는 외부 도구면 false */
  readonly known: boolean;
}

export interface GuardResult {
  readonly decision: ToolDecision;
  /** true 면 Guard 를 지나도 cmh_ai_approval 행을 만들고 사람 클릭까지 멈춘다(RA) */
  readonly requiresApproval: boolean;
  /** 결정을 낸 규칙. 정책에 맞는 규칙이 없으면 null · 내장 규칙이면 그 글롭 */
  readonly matchedPattern: string | null;
}

/** 내장 규칙 — 승인 상태 엔티티. 읽기 말고는 정책과 상관없이 deny(합의안 5) */
export const APPROVAL_ENTITY_PATTERN = 'entity:cmh_ai_approval:*';
const APPROVAL_ENTITY_READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'search']);

/** 마켓 쓰기 동작(market:<마켓>:<동작>) — 결과가 allow 여도 승인 관문을 거친다. 늘릴 때는 이 표만 고친다 */
export const MARKET_WRITE_ACTIONS: ReadonlySet<string> = new Set(['save', 'send', 'delete']);

const SEVERITY: Readonly<Record<ToolDecision, number>> = { allow: 0, ask: 1, deny: 2 };

function splitSegments(name: string): string[] {
  return name.toLowerCase().split(':');
}

function isWellFormedTool(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.every((s) => s.length > 0 && !s.includes('*'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 한 마디 글롭: `*` 는 그 마디 안의 아무 글자(빈 것 포함). `*` 만 있으면 아무 마디 하나 */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === segment;
  const source = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`).test(segment);
}

function segmentsMatch(pattern: readonly string[], pi: number, tool: readonly string[], ti: number): boolean {
  if (pi === pattern.length) return ti === tool.length;
  const head = pattern[pi];
  if (head === undefined) return false;
  if (head === '**') {
    // 0 마디부터 남은 마디 전부까지
    for (let k = ti; k <= tool.length; k += 1) {
      if (segmentsMatch(pattern, pi + 1, tool, k)) return true;
    }
    return false;
  }
  const segment = tool[ti];
  if (segment === undefined) return false;
  return segmentMatches(head, segment) && segmentsMatch(pattern, pi + 1, tool, ti + 1);
}

/** 글롭이 도구 이름에 맞나. 대소문자는 가리지 않는다(대문자로 deny 규칙을 비껴가지 못하게) */
export function matchToolPattern(pattern: string, tool: string): boolean {
  const toolSegments = splitSegments(tool);
  if (!isWellFormedTool(toolSegments)) return false;
  return segmentsMatch(splitSegments(pattern), 0, toolSegments, 0);
}

function isApprovalEntityWrite(segments: readonly string[]): boolean {
  if (segments[0] !== 'entity' || segments[1] !== 'cmh_ai_approval') return false;
  const action = segments[2];
  // 동작이 없거나(entity:cmh_ai_approval) 읽기가 아니면 쓰기로 본다 — 모르면 막는 쪽
  return action === undefined || segments.length !== 3 || !APPROVAL_ENTITY_READ_ACTIONS.has(action);
}

function isMarketWrite(segments: readonly string[]): boolean {
  const action = segments[segments.length - 1];
  return segments[0] === 'market' && segments.length >= 3 && action !== undefined && MARKET_WRITE_ACTIONS.has(action);
}

/**
 * 도구 호출 한 번을 평가한다. 차례:
 * ①모양이 깨진 이름 → deny ②승인 엔티티 쓰기 → deny(내장) ③정책 글롭 전부 중 deny > ask > allow
 * ④맞는 규칙 없음 → guard 는 ask · full 은 allow ⑤known=false 면 최소 ask ⑥마켓 쓰기는 deny 가 아니면 requiresApproval
 */
export function evaluateGuard(policy: GuardPolicy, request: GuardRequest): GuardResult {
  const segments = splitSegments(request.tool);
  if (!isWellFormedTool(segments)) return { decision: 'deny', requiresApproval: false, matchedPattern: null };
  if (isApprovalEntityWrite(segments)) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: APPROVAL_ENTITY_PATTERN };
  }

  let decision: ToolDecision | null = null;
  let matchedPattern: string | null = null;
  // 같은 무게면 먼저 적힌 규칙(객체 키 차례)이 matchedPattern 이 된다
  for (const [pattern, value] of Object.entries(policy.tools)) {
    if (!segmentsMatch(splitSegments(pattern), 0, segments, 0)) continue;
    if (decision === null || SEVERITY[value] > SEVERITY[decision]) {
      decision = value;
      matchedPattern = pattern;
    }
  }
  if (decision === null) decision = policy.defaultMode === 'guard' ? 'ask' : 'allow';
  if (!request.known && decision === 'allow') decision = 'ask';

  const requiresApproval = decision !== 'deny' && isMarketWrite(segments);
  return { decision, requiresApproval, matchedPattern };
}

/** 사이트 자격증명 접근. 사이트가 정책에 없으면 ask(합의 ⑨ — 앱 잠금 미정의라 쓸 때마다 사람 확인) */
export function credentialAccessFor(policy: GuardPolicy, site: string): CredentialAccess {
  const key = site.toLowerCase();
  for (const [name, access] of Object.entries(policy.credentials)) {
    if (name.toLowerCase() === key) return access;
  }
  return 'ask';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertToolPattern(pattern: string): void {
  if (pattern.length === 0) throw new Error('guard policy: empty tool pattern');
  for (const segment of pattern.split(':')) {
    if (segment.length === 0) throw new Error(`guard policy: empty segment in pattern "${pattern}"`);
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`guard policy: "**" must be a whole segment in pattern "${pattern}"`);
    }
    if (/\s/.test(segment)) throw new Error(`guard policy: whitespace in pattern "${pattern}"`);
  }
}

/** 정책 JSON(설정 테이블 값) 검증. 모르는 키 · 모르는 값 · 깨진 글롭은 예외 — 고칠 사람은 프로그래머/설정 화면이다 */
export function parseGuardPolicy(raw: unknown): GuardPolicy {
  if (!isPlainObject(raw)) throw new Error('guard policy: must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'defaultMode' && key !== 'tools' && key !== 'credentials') {
      throw new Error(`guard policy: unknown key "${key}"`);
    }
  }
  const mode = raw['defaultMode'];
  if (!(GUARD_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`guard policy: unknown defaultMode ${JSON.stringify(mode)}`);
  }

  // 프로토타입 없는 객체 — 키 "__proto__" 규칙도 잃지 않는다
  const tools: Record<string, ToolDecision> = Object.create(null) as Record<string, ToolDecision>;
  const rawTools = raw['tools'] ?? {};
  if (!isPlainObject(rawTools)) throw new Error('guard policy: tools must be an object');
  for (const [pattern, value] of Object.entries(rawTools)) {
    assertToolPattern(pattern);
    if (!(TOOL_DECISIONS as readonly unknown[]).includes(value)) {
      throw new Error(`guard policy: unknown decision ${JSON.stringify(value)} for "${pattern}"`);
    }
    tools[pattern] = value as ToolDecision;
  }

  const credentials: Record<string, CredentialAccess> = Object.create(null) as Record<string, CredentialAccess>;
  const rawCredentials = raw['credentials'] ?? {};
  if (!isPlainObject(rawCredentials)) throw new Error('guard policy: credentials must be an object');
  for (const [site, value] of Object.entries(rawCredentials)) {
    if (site.trim().length === 0) throw new Error('guard policy: empty credential site');
    if (!(CREDENTIAL_ACCESS as readonly unknown[]).includes(value)) {
      throw new Error(`guard policy: unknown credential access ${JSON.stringify(value)} for "${site}"`);
    }
    credentials[site] = value as CredentialAccess;
  }

  return { defaultMode: mode as GuardMode, tools, credentials };
}
