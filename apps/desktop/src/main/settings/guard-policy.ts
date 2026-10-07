// R7-a — Guard 정책 평가기. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// Aside Guard 꼴(research/01 «Guard»): 작업 단위 모드 guard(기본) / full · 도구 권한 allow / ask / deny · 겹치면 deny 가 이긴다.
// 합의안 5(PLAN «opus 검수 반영»): 승인 엔티티 cmh_ai_approval 쓰기는 main 의 UI IPC(사람 클릭)만 → 여기서는 어떤 정책이든 항상 deny.
// 처음 보는 외부 MCP 도구(known=false)는 최소 ask · 마켓 쓰기는 결과가 allow 여도 승인 관문(cmh_ai_approval)을 따로 거친다(requiresApproval).
//
// 도구 이름 규칙(검수 차단 1): `:` 로 나눈 모든 마디가 ASCII `[A-Za-z0-9_.-]+` 여야 한다(소문자로 맞춘 뒤 `^[a-z0-9_.-]+$`).
// 공백 · 제어문자 · zero-width · 전각 · 비ASCII 가 하나라도 있으면 deny — 겉보기만 같은 이름으로 deny 규칙 · 승인 엔티티 검사를 비껴가지 못하게.
// (소문자로 바꾸기 «전에» 검사한다 — Kelvin 기호 U+212A 처럼 toLowerCase 하면 ASCII 'k' 가 되는 글자도 막으려고.)

export const GUARD_MODES = ['guard', 'full'] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export const TOOL_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

// whileUnlocked 는 Aside 값 — 앱 «잠금» 이 아직 정의되지 않아(합의 ⑨) 기본은 ask
export const CREDENTIAL_ACCESS = ['always', 'whileUnlocked', 'never', 'ask'] as const;
export type CredentialAccess = (typeof CREDENTIAL_ACCESS)[number];

export interface GuardPolicy {
  readonly defaultMode: GuardMode;
  /**
   * 키 = 글롭(`:` 구분 · `*` 한 마디 · `**` 0 마디 이상 · 마디 안 `*` 는 그 마디 안 아무 글자) · 값 = 결정.
   * deny 규칙만: 마디 전체가 `*` 이면 «한 마디 이상»으로 넓혀 읽는다(evaluateGuard 주석).
   */
  readonly tools: Readonly<Record<string, ToolDecision>>;
  /** 키 = 사이트 이름(예 naver) · 값 = 에이전트의 자격증명 접근 */
  readonly credentials: Readonly<Record<string, CredentialAccess>>;
}

export interface GuardTarget {
  /** 범용 DAL 도구(dal_update 등)가 건드리는 엔티티 이름(예 'cmh_ai_approval') */
  readonly entity?: string;
}

export interface GuardRequest {
  /** 예 'mcp:cmh-shop-api-mcp:dal_update' · 'market:naver:save' · 'browser:navigate' · 'skill:<name>:script' */
  readonly tool: string;
  /** 처음 보는 외부 도구면 false */
  readonly known: boolean;
  /** 도구 인자에서 꺼낸 대상. entity 가 cmh_ai_approval 이면 읽기 꼴 도구 말고는 deny */
  readonly target?: GuardTarget;
  /** 서버 칸 `cmh_ai_mcp_tool.needs_approval` — true 면 결과가 allow/ask 여도 requiresApproval */
  readonly needsApproval?: boolean;
}

export interface GuardResult {
  readonly decision: ToolDecision;
  /** true 면 Guard 를 지나도 cmh_ai_approval 행을 만들고 사람 클릭까지 멈춘다(RA) */
  readonly requiresApproval: boolean;
  /** 결정을 낸 규칙. 정책에 맞는 규칙이 없으면 null · 내장 규칙이면 그 글롭 */
  readonly matchedPattern: string | null;
}

/** 내장 규칙 — 승인 상태 엔티티. 읽기 말고는 정책과 상관없이 deny(합의안 5) */
export const APPROVAL_ENTITY = 'cmh_ai_approval';
export const APPROVAL_ENTITY_PATTERN = 'entity:cmh_ai_approval:*';

/**
 * 읽기 꼴 동작 이름. 이름을 `-` → `_` 로 맞추고 앞붙이 `dal_` 를 뗀 것이 이 표에 있어야 읽기다.
 * 이 표에 없으면 전부 쓰기로 본다(모르면 막는 쪽) — dal_update · dal_create · dal_delete · dal_upsert · dal_sync · field_save · save:draft …
 * 늘릴 때는 이 표만 고친다.
 */
export const READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'search', 'get', 'list', 'count', 'aggregate', 'find']);

/** 도구 이름 전체 길이 상한 — 이보다 길면 deny(글롭 평가 비용 상한) */
export const TOOL_NAME_MAX = 512;

const SEVERITY: Readonly<Record<ToolDecision, number>> = { allow: 0, ask: 1, deny: 2 };

/** 도구 이름 한 마디(원래 글자 그대로 검사) */
const TOOL_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** 정책 글롭 한 마디 — 도구 마디 글자 + `*` */
const PATTERN_SEGMENT = /^[A-Za-z0-9_.*-]+$/;

/** 모양이 맞으면 소문자 마디 목록 · 틀리면 null(→ deny) */
function toolSegments(name: string): string[] | null {
  if (name.length === 0 || name.length > TOOL_NAME_MAX) return null;
  const raw = name.split(':');
  if (!raw.every((s) => TOOL_SEGMENT.test(s))) return null;
  return raw.map((s) => s.toLowerCase());
}

/** 엔티티 · 동작 이름 맞추기: trim · 소문자 · `-` → `_` */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_');
}

/** 동작 이름이 읽기 꼴인가(`dal_search` · `get` · `list` …) */
export function isReadActionName(action: string): boolean {
  const n = normalizeEntityName(action);
  return READ_ACTIONS.has(n.startsWith('dal_') ? n.slice(4) : n);
}

// ---------------------------------------------------------------- 글롭

type GlobToken =
  | { readonly kind: 'lit'; readonly text: string }
  | { readonly kind: 'seg'; readonly text: string } // 마디 안 `*` 가 있는 한 마디
  | { readonly kind: 'one' } // `*` — 아무 마디 하나
  | { readonly kind: 'many' }; // `**` — 0 마디 이상

/**
 * 글롭 → 토큰. widenStar=true(deny 규칙)면 마디 전체 `*` 를 «한 마디 이상»(`*` + `**`)으로 넓힌다.
 * 이어진 `**` 는 하나로 접는다(평가 비용이 `**` 개수로 늘지 않게).
 */
function compileGlob(pattern: string, widenStar: boolean): GlobToken[] {
  const out: GlobToken[] = [];
  const pushMany = (): void => {
    if (out[out.length - 1]?.kind !== 'many') out.push({ kind: 'many' });
  };
  for (const raw of pattern.toLowerCase().split(':')) {
    if (raw === '**') pushMany();
    else if (raw === '*') {
      out.push({ kind: 'one' });
      if (widenStar) pushMany();
    } else if (raw.includes('*')) out.push({ kind: 'seg', text: raw });
    else out.push({ kind: 'lit', text: raw });
  }
  return out;
}

/**
 * 마디 안 글롭(`*` 만 특수 글자). 정규식 없이 탐욕 + 되돌림 한 칸 —
 * 마지막 `*` 자리 하나만 기억하고 실패하면 거기서 한 글자 더 먹는다. 최악 O(패턴 × 마디) · 지수 시간 없음.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p;
      starT = t;
      p += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function tokenMatchesSegment(token: GlobToken, segment: string): boolean {
  switch (token.kind) {
    case 'lit':
      return token.text === segment;
    case 'seg':
      return wildcardMatch(token.text, segment);
    case 'one':
      return true;
    case 'many':
      return true;
  }
}

/** (토큰 자리, 마디 자리) 메모 — 상태 수 (P+1)(T+1) 을 넘지 않는다 */
function globMatches(tokens: readonly GlobToken[], segments: readonly string[]): boolean {
  const width = segments.length + 1;
  const memo = new Uint8Array((tokens.length + 1) * width); // 0 모름 · 1 맞음 · 2 안 맞음
  const go = (pi: number, ti: number): boolean => {
    const slot = pi * width + ti;
    const known = memo[slot];
    if (known === 1) return true;
    if (known === 2) return false;
    let ok: boolean;
    const token = tokens[pi];
    if (token === undefined) ok = ti === segments.length;
    else if (token.kind === 'many') ok = go(pi + 1, ti) || (ti < segments.length && go(pi, ti + 1));
    else {
      const segment = segments[ti];
      ok = segment !== undefined && tokenMatchesSegment(token, segment) && go(pi + 1, ti + 1);
    }
    memo[slot] = ok ? 1 : 2;
    return ok;
  };
  return go(0, 0);
}

/** 글롭이 도구 이름에 맞나(allow 꼴 — `*` 는 한 마디). 대소문자는 가리지 않는다(대문자로 deny 규칙을 비껴가지 못하게) */
export function matchToolPattern(pattern: string, tool: string): boolean {
  const segments = toolSegments(tool);
  if (segments === null) return false;
  return globMatches(compileGlob(pattern, false), segments);
}

// ---------------------------------------------------------------- 내장 규칙

/** 이름 안 어느 마디에 승인 엔티티가 있으면 쓰기인가. 읽기는 `…:cmh_ai_approval:<읽기 동작>` 으로 끝날 때뿐 */
function isApprovalEntityWrite(segments: readonly string[]): boolean {
  for (let i = 0; i < segments.length; i += 1) {
    const s = normalizeEntityName(segments[i] ?? '');
    if (!s.includes(APPROVAL_ENTITY)) continue;
    // 마디 일부(cmh_ai_approval_update 등)는 동작을 가려낼 수 없어 쓰기로 본다
    if (s !== APPROVAL_ENTITY) return true;
    const action = segments[i + 1];
    // 동작이 없거나(entity:cmh_ai_approval) · 마지막 마디가 아니거나 · 읽기 꼴이 아니면 쓰기
    if (action === undefined || i + 2 !== segments.length || !isReadActionName(action)) return true;
  }
  return false;
}

/** target.entity 검사. 엔티티 이름이 깨졌으면(공백 안 · 비ASCII 등) 'malformed' */
function approvalTargetWrite(target: GuardTarget | undefined, segments: readonly string[]): 'malformed' | boolean {
  const entity = target?.entity;
  if (entity === undefined) return false;
  const n = normalizeEntityName(entity);
  if (!/^[a-z0-9_.]+$/.test(n)) return 'malformed';
  if (!n.includes(APPROVAL_ENTITY)) return false;
  const action = segments[segments.length - 1];
  return action === undefined || !isReadActionName(action);
}

/** 마켓(market:<마켓>:<동작…>) 쓰기 — 동작 마디가 전부 읽기 꼴일 때만 읽기 · 나머지는 모두 쓰기 */
function isMarketWrite(segments: readonly string[]): boolean {
  if (segments[0] !== 'market') return false;
  const actions = segments.slice(2);
  return actions.length === 0 || !actions.every(isReadActionName);
}

/**
 * 도구 호출 한 번을 평가한다. 차례:
 * ①모양이 깨진 이름 · 깨진 target.entity → deny ②승인 엔티티 쓰기(이름 어느 마디든 · target.entity) → deny(내장)
 * ③정책 글롭 전부 중 deny > ask > allow ④맞는 규칙 없음 → guard 는 ask · full 은 allow ⑤known=false 면 최소 ask
 * ⑥deny 가 아니면 마켓 쓰기 · needsApproval 은 requiresApproval
 *
 * deny 규칙의 마디 전체 `*` 는 «한 마디 이상»으로 넓혀 읽는다(allow · ask 는 그대로 한 마디):
 * `mcp:evil:*` deny 를 `mcp:evil:a:b` 처럼 마디를 하나 더 붙여 비껴가지 못하게(검수 1-3). 막는 쪽만 넓히면 잘못 넓어도 덜 열린다.
 */
export function evaluateGuard(policy: GuardPolicy, request: GuardRequest): GuardResult {
  const segments = toolSegments(request.tool);
  if (segments === null) return { decision: 'deny', requiresApproval: false, matchedPattern: null };
  const targetWrite = approvalTargetWrite(request.target, segments);
  if (targetWrite === 'malformed') return { decision: 'deny', requiresApproval: false, matchedPattern: null };
  if (targetWrite || isApprovalEntityWrite(segments)) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: APPROVAL_ENTITY_PATTERN };
  }

  let decision: ToolDecision | null = null;
  let matchedPattern: string | null = null;
  // 같은 무게면 먼저 적힌 규칙(객체 키 차례)이 matchedPattern 이 된다
  for (const [pattern, value] of Object.entries(policy.tools)) {
    if (!globMatches(compileGlob(pattern, value === 'deny'), segments)) continue;
    if (decision === null || SEVERITY[value] > SEVERITY[decision]) {
      decision = value;
      matchedPattern = pattern;
    }
  }
  if (decision === null) decision = policy.defaultMode === 'guard' ? 'ask' : 'allow';
  if (!request.known && decision === 'allow') decision = 'ask';

  const requiresApproval = decision !== 'deny' && (isMarketWrite(segments) || request.needsApproval === true);
  return { decision, requiresApproval, matchedPattern };
}

/**
 * MCP 도구의 Guard 이름 `mcp:<서버 code>:<도구 이름>`. 어느 쪽이든 `:` 가 들어 있거나 마디 글자 규칙을 어기면 예외 —
 * 도구 이름의 `:` 가 마디를 늘려 `mcp:<서버>:*` 규칙을 비껴가지 못하게(MCP 규격 도구 이름은 `[A-Za-z0-9_.-]`).
 */
export function mcpToolName(serverCode: string, toolName: string): string {
  for (const [label, value] of [['server code', serverCode], ['tool name', toolName]] as const) {
    if (value.includes(':')) throw new Error(`guard: MCP ${label} must not contain ":"`);
    if (!TOOL_SEGMENT.test(value)) throw new Error(`guard: MCP ${label} must match ${TOOL_SEGMENT.source}`);
  }
  return `mcp:${serverCode}:${toolName}`;
}

/** 사이트 자격증명 접근. 사이트가 정책에 없으면 ask(합의 ⑨ — 앱 잠금 미정의라 쓸 때마다 사람 확인) */
export function credentialAccessFor(policy: GuardPolicy, site: string): CredentialAccess {
  const key = site.trim().toLowerCase();
  for (const [name, access] of Object.entries(policy.credentials)) {
    if (name.trim().toLowerCase() === key) return access;
  }
  return 'ask';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertToolPattern(pattern: string): void {
  if (pattern.length === 0) throw new Error('guard policy: empty tool pattern');
  if (pattern.length > TOOL_NAME_MAX) throw new Error(`guard policy: pattern longer than ${TOOL_NAME_MAX}`);
  for (const segment of pattern.split(':')) {
    if (segment.length === 0) throw new Error(`guard policy: empty segment in pattern "${pattern}"`);
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`guard policy: "**" must be a whole segment in pattern "${pattern}"`);
    }
    if (/\s/.test(segment)) throw new Error(`guard policy: whitespace in pattern "${pattern}"`);
    // 도구 이름에 올 수 없는 글자(비ASCII 등)는 어떤 도구에도 맞지 않는다 — 조용히 죽은 규칙이 되지 않게 거부
    if (!PATTERN_SEGMENT.test(segment)) throw new Error(`guard policy: invalid character in pattern "${pattern}"`);
  }
}

/** 정책 JSON(설정 테이블 값) 검증. 모르는 키 · 모르는 값 · 깨진 글롭 · 대소문자만 다른 사이트 중복은 예외 — 고칠 사람은 프로그래머/설정 화면이다 */
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
  const seenSites = new Set<string>();
  for (const [site, value] of Object.entries(rawCredentials)) {
    const key = site.trim().toLowerCase();
    if (key.length === 0) throw new Error('guard policy: empty credential site');
    // credentialAccessFor 는 대소문자를 가리지 않는다 — 'Naver' · 'naver' 가 둘 다 있으면 어느 값이 이길지 모른다
    if (seenSites.has(key)) throw new Error(`guard policy: duplicate credential site "${site}" (case-insensitive)`);
    seenSites.add(key);
    if (!(CREDENTIAL_ACCESS as readonly unknown[]).includes(value)) {
      throw new Error(`guard policy: unknown credential access ${JSON.stringify(value)} for "${site}"`);
    }
    credentials[site] = value as CredentialAccess;
  }

  return { defaultMode: mode as GuardMode, tools, credentials };
}
