// RA — 에이전트 실행 루프 뼈대. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» 1·5 · `#### [ ] RA.` · 검수 4(research/10-review-code-ra.md)
//
// 한 걸음(step) = 모델 호출 한 번:
//   (토큰 어림 사전 검사) → 모델 스트림(delta · reasoning 은 그대로 이벤트) → tool_call 모으기(한 걸음 상한) →
//   도구마다 차례로 [tool_call 이벤트 → 되풀이 검사 → Guard(evaluateToolCall) → (ask · requiresApproval 이면) 승인 관문(인자 전문) →
//   ToolRouter.call → 결과를 role 'tool' 메시지로 붙임] → 다음 걸음. 도구 호출이 없는 답이 오면 done 'final'.
// 🔴 던지지 않는다 — 모든 실패(모델 error 조각 · 공급자 예외 · 도구 실패 · 승인 관문 실패)는 이벤트 error + 대화에 오류 글.
// 🔴 승인 결정은 여기서 못 한다 — 생성자가 받은 관문을 restrictGate 로 감싸 open/requestApproval 만 쥔다(합의안 5 · 권고 7).
// 🔴 멈출 때 답 없는 tool_call 이 남으면 «실행 안 함» tool 메시지로 닫는다(예외 길 포함) — 저장한 대화를 다시 보낼 때 OpenAI 꼴이 깨지지 않게.
// 🔴 이벤트 약속(agent-events.ts 머리말): tool_call 마다 닫는 이벤트 하나 · done 은 정확히 한 번 · callId 는 runner 가 만든다.
// 🔴 시간 상한 · 취소는 도구 · 관문 · 모델이 signal 을 따르지 않아도 걸린다 — 기다리는 약속을 abort 약속과 Promise.race 한다.
// ⚠️ 로컬 GGUF · ONNX 공급자는 아직 role 'tool' · tool_calls 메시지를 받으면 error 조각을 낸다(gguf-text-provider.ts · onnx-text-provider.ts)
//    → 지금 도구 루프는 OpenAI 호환 · 서버 relay 공급자에서만 두 걸음 이상 간다.
import { randomUUID } from 'node:crypto';

import type { ChatChunk, ChatMessage, ChatRequest, ChatToolCallRef, ChatToolDefinition, ChatUsage, ModelProvider } from '../models/model-provider.js';
import { errorText } from '../models/model-provider.js';
import { isApprovalAssociationKey, mentionsWriteProtectedEntity } from '../settings/approval-entity.js';
import { DAL_WRITE_WITHOUT_TARGET_PATTERN, evaluateGuard, isDalWriteActionName } from '../settings/guard-policy.js';
import type { GuardPolicy, GuardResult, GuardTarget } from '../settings/guard-policy.js';
import type { AgentDoneEvent, AgentDoneReason, AgentEvent, ToolDeniedReason } from './agent-events.js';
import { APPROVAL_ARGS_MAX_BYTES, restrictGate } from './approval-gate.js';
import type { ApprovalGate, ApprovalOutcome, ApprovalTicket } from './approval-gate.js';
import type { RoutedTool, ToolCallResult, ToolRouter } from './tool-router.js';
import { TOOL_DEFINITION_DEFAULTS } from './tool-router.js';

/** 모델 — ModelRegistry.resolve(code) 의 provider 와 modelRow.code */
export interface AgentModel {
  readonly provider: ModelProvider;
  /** `cmh_ai_model.code` — ChatRequest.model */
  readonly code: string;
}

/**
 * AgentRunner 가 쓰는 도구 쪽(ToolRouter 그대로 또는 시험 가짜).
 * 찾기는 `definitions().byName`(이번 run 에 보여 준 도구만 · run 마다 고정)으로만 한다. byName 을 안 주는 옛 꼴이면
 * 보여 준 정의 이름을 그때 lookup 해 같은 고정 표를 만든다(보여 주지 않은 도구는 어느 쪽이든 못 부른다).
 */
export type AgentToolbox = Pick<ToolRouter, 'refresh' | 'definitions' | 'lookup' | 'call'>;

export interface AgentLimits {
  /** 모델 호출 수 상한 */
  readonly maxSteps: number;
  /**
   * 토큰 상한 — 걸음마다 usage(prompt + completion) 합. usage 를 안 주는 공급자는 글자 수 ÷ 3 으로 어림해 센다.
   * 모델을 부르기 «전에» 지금까지 쓴 양 + 이번 요청 어림(대화 · 도구 정의 글자 ÷ 3)이 넘으면 부르지 않고 멈춘다.
   */
  readonly maxTotalTokens: number;
  /** run 전체 시간 상한(사람 승인 기다림 포함) */
  readonly maxDurationMs: number;
  /** 같은 도구 · 같은 인자 호출이 이 횟수에 닿으면 그 호출은 하지 않고 멈춘다 */
  readonly maxRepeatCalls: number;
  /** 도구 결과를 모델에게 붙일 때 글 상한(원칙 2 토큰 절약 · 1차 «요약» = 앞부분 자르기) */
  readonly maxToolResultChars: number;
  /** 한 걸음에서 실행하는 tool_call 수 상한 — 넘는 호출은 «실행 안 함» 으로 닫는다 */
  readonly maxToolCallsPerStep: number;
  /** 도구 인자 JSON 글 상한 — 넘으면 풀지 않고 깨진 인자로 닫는다(대화에는 생략 표시만 남긴다) */
  readonly maxToolArgsChars: number;
  /** 도구 하나 시간 상한 — 없으면 출처 기본값(MCP 는 MCP_DEFAULTS.callTimeoutMs) */
  readonly toolTimeoutMs?: number;
  /** 모델에게 줄 도구 수 · 설명 길이 · 정의 글자 합 상한 */
  readonly maxTools: number;
  readonly maxDescriptionChars: number;
  readonly maxToolDefinitionChars: number;
}

/**
 * maxSteps 12 · maxRepeatCalls 3 은 브리프 값 · maxToolCallsPerStep 8 은 검수 4 권고 4 의 예시 값.
 * 나머지는 【임시 기본값 · 근거 없음】 — 다음 차례에 `cmh_ai_agent` 테이블 값(PLAN RA «5. 하는 일»)으로 바꾼다.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxSteps: 12,
  maxTotalTokens: 200_000,
  maxDurationMs: 10 * 60_000,
  maxRepeatCalls: 3,
  maxToolResultChars: 4_000,
  maxToolCallsPerStep: 8,
  maxToolArgsChars: APPROVAL_ARGS_MAX_BYTES,
  maxTools: TOOL_DEFINITION_DEFAULTS.maxTools,
  maxDescriptionChars: TOOL_DEFINITION_DEFAULTS.maxDescriptionChars,
  maxToolDefinitionChars: TOOL_DEFINITION_DEFAULTS.maxTotalChars,
};

export interface AgentRunInput {
  readonly messages: readonly ChatMessage[];
  readonly model: AgentModel;
  readonly tools: AgentToolbox;
  readonly policy: GuardPolicy;
  readonly limits?: Partial<AgentLimits>;
  readonly signal?: AbortSignal;
  /** 없으면 새 UUID */
  readonly runId?: string;
}

export interface AgentRunnerOptions {
  /** 생성자가 restrictGate 로 감싼다 — runner 는 decide 에 닿지 못한다 */
  readonly approvalGate: ApprovalGate;
  /** 시험용 */
  readonly newRunId?: () => string;
}

/** 모델 · UI 에 보이는 글. 화면 번역(snippet)은 R6 가 붙일 때 이 자리에서 키로 바꾼다 */
export const AGENT_TEXT = {
  denied: (pattern: string | null) => `거부됨: ${pattern ?? '규칙 없음'}`,
  rejected: '거부됨: 사람이 거절함',
  approvalTimeout: '거부됨: 승인 시간 초과',
  argsTooLarge: '거부됨: 인자가 너무 커 사람이 확인할 수 없음',
  toolError: (message: string) => `오류: ${message}`,
  modelError: (message: string) => `[오류] ${message}`,
  unknownTool: (name: string) => `오류: 모르는 도구 "${name}"`,
  badArgs: (message: string) => `오류: 인자 JSON 이 잘못됨 — ${message}`,
  argsOverLimit: (chars: number, max: number) => `인자 글이 상한을 넘음(${chars}자 · 상한 ${max}자)`,
  argsOmitted: (chars: number) => `${chars}자 인자 생략(상한 넘음)`,
  loop: '실행 안 함: 같은 도구 · 같은 인자 되풀이',
  callLimit: (max: number) => `실행 안 함: 한 걸음 도구 호출 상한(${max}) 넘음`,
  callLimitNotice: (max: number, skipped: number, dropped: number) =>
    `한 걸음 도구 호출 상한 ${max} — ${skipped}개 실행 안 함${dropped > 0 ? ` · ${dropped}개는 기록도 안 함` : ''}`,
  notRun: (reason: AgentDoneReason) => `실행 안 함: run 이 멈춤(${reason})`,
  cut: (cutChars: number) => `\n…(${cutChars}자 잘림)`,
} as const;

const ARGS_SUMMARY_MAX = 500;
/** error 이벤트 · 대화 오류 글 상한 */
const ERROR_TEXT_MAX = 2_000;
/** 모르는 도구 이름 · 대화에 남기는 도구 이름 상한 */
const TOOL_NAME_TEXT_MAX = 200;
/** 모델이 준 call id 를 그대로 쓰는 길이 상한(넘으면 runner 가 새로 만든다) */
const CALL_ID_MAX = 128;
/** 한 걸음에서 «기록» 하는 tool_call 수 상한 — 실행 상한(maxToolCallsPerStep)을 넘는 것도 여기까지는 «실행 안 함» 으로 닫고, 그 뒤는 버린다 */
const TOOL_CALLS_RECORD_MAX = 64;
/** 인자 JSON 의 중첩 깊이 상한(되부름으로 도는 canonicalJson · 가림의 스택 보호) */
const ARGS_DEPTH_MAX = 64;
/** 가린 키 경로 목록 상한 */
const MASKED_KEYS_MAX = 100;
/** 승인 엔티티 언급을 찾는 인자 훑기 상한 — 깊이 · 글자 값(키 포함) 수. 넘으면 다 못 봤으므로 막는 쪽 */
export const ARGS_SCAN_MAX_DEPTH = 8;
export const ARGS_SCAN_MAX_VALUES = 2_000;
/**
 * 【AI 임시 결정】 글자 값 하나를 풀어(퍼센트 · JSON 이스케이프) 다시 보는 상한 — 이보다 긴 글은 다 못 본 것(막는 쪽).
 * 인자 전체 상한(maxToolArgsChars 기본 = APPROVAL_ARGS_MAX_BYTES)과 같게 둬서 보통 호출은 걸리지 않는다.
 */
export const ARGS_SCAN_DECODE_MAX_CHARS = APPROVAL_ARGS_MAX_BYTES;
/** 【AI 임시 결정】 퍼센트 · JSON 이스케이프 풀기를 되풀이하는 횟수 상한(`%252D` 같은 겹 인코딩) */
const ARGS_SCAN_DECODE_ROUNDS = 3;
/** 훑기를 다 못 했을 때 Guard 에 넘기는 target — 모양이 깨진 엔티티 이름이라 Guard 가 deny 한다 */
export const ARGS_SCAN_INCOMPLETE_ENTITY = '?args-scan-limit';
/** 훑기를 다 못 해 막은 경우의 matchedPattern(evaluateToolCall) */
export const ARGS_SCAN_LIMIT_PATTERN = 'builtin:args-scan-limit';
/** 글자 수 → 토큰 어림(검수 4 권고 5: 글자/3) */
const CHARS_PER_TOKEN = 3;
/** setTimeout 이 받는 가장 큰 지연(ms) */
const TIMER_MAX_MS = 2_147_483_647;
/** 인자 요약에서 값을 `***(N자)` 로 가리는 키 */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential/i;
/** 이름과 상관없이 Guard target 으로 넘기는 인자 키 */
const ENTITY_KEYS = ['entity', 'entityName', 'entity_name'] as const;

/** 같은 인자면 같은 글 — 키 차례를 정렬한 JSON */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function maskInto(value: unknown, path: string, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => maskInto(v, `${path}[${i}]`, keys));
  if (value !== null && typeof value === 'object') {
    // 프로토타입 없는 객체 — 키 "__proto__" 가 요약에서 사라지지 않게
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path.length > 0 ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k)) {
        if (keys.length < MASKED_KEYS_MAX) keys.push(p);
        out[k] = `***(${typeof v === 'string' ? v.length : canonicalJson(v).length}자)`;
      } else {
        out[k] = maskInto(v, p, keys);
      }
    }
    return out;
  }
  return value;
}

/** 비밀 같은 키 값을 `***(N자)` 로 바꾼 사본과 가린 키 경로(`a.b` · `items[0].token`) */
export function maskArgs(args: Record<string, unknown>): { masked: unknown; maskedKeys: string[] } {
  const maskedKeys: string[] = [];
  return { masked: maskInto(args, '', maskedKeys), maskedKeys };
}

/** 도구 줄에 보일 인자 요약(비밀 같은 키는 `***(N자)` · 500자 상한). 🔴 승인 판단용이 아니다 — 승인 화면은 argsFull */
export function summarizeArgs(args: Record<string, unknown>): string {
  return capText(JSON.stringify(maskArgs(args).masked), ARGS_SUMMARY_MAX).text;
}

export function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, max)}${AGENT_TEXT.cut(text.length - max)}`, cut: true };
}

function capError(message: string): string {
  return capText(message, ERROR_TEXT_MAX).text;
}

/** 중첩 깊이가 max 를 넘나(되부름 깊이도 max 로 묶인다) */
function deeperThan(value: unknown, max: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (max <= 0) return true;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((v) => deeperThan(v, max - 1));
}

/** 인자 JSON → 객체. 빈 글은 {} · 객체가 아니거나 너무 깊으면 오류 글 */
export function parseToolArgs(argumentsJson: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (argumentsJson.trim().length === 0) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch (e) {
    return { ok: false, error: capError(errorText(e)) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'arguments must be a JSON object' };
  if (deeperThan(parsed, ARGS_DEPTH_MAX)) return { ok: false, error: `arguments nested deeper than ${ARGS_DEPTH_MAX}` };
  return { ok: true, args: parsed as Record<string, unknown> };
}

/** 보이지 않거나 글자 순서를 뒤집는 글자 — 훑기 전에 뗀다(`cmh_ai_appro\u200Bval`) · 승인 화면 표시는 revealHiddenChars 가 보이게 바꾼다 */
const HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** `%XX` 를 글자로(바이트 하나 = 글자 하나 · 깨진 꼴은 그대로). 엔티티 이름은 ASCII 라 UTF-8 여러 바이트를 다시 묶지 않아도 된다 */
function percentDecode(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** JSON · JS 이스케이프(`\u0076` · `\x76` · `\/`)를 글자로 */
function unescapeJsonLike(text: string): string {
  return text
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

/**
 * 글자 꾸미기를 푼 꼴(검수 5 E3) — 퍼센트 · JSON 이스케이프를 바뀌지 않을 때까지(최대 ARGS_SCAN_DECODE_ROUNDS) 풀고 NFKC(전각 → ASCII) · 보이지 않는 글자 떼기.
 * 정규식은 모두 고정 길이 꼴이라 길이에 선형이다(ReDoS 없음).
 * 🔴 base64 · rot13 · 압축처럼 «사람이 정한 아무 꼴» 로 바꾼 글은 여기서 못 푼다 — 클라이언트 글자 훑기로는 원리상 닫을 수 없다.
 *    진짜 막기는 서버 몫: `CmhAiApprovalController` decide 와 `cmh_ai_approval` PreWrite 가 사람 Admin 세션이 아닌 쓰기를 거부해야 한다(검수 5 차단 1).
 */
export function deobfuscateText(text: string): string {
  let cur = text;
  for (let i = 0; i < ARGS_SCAN_DECODE_ROUNDS; i += 1) {
    const next = unescapeJsonLike(percentDecode(cur));
    if (next === cur) break;
    cur = next;
  }
  return cur.normalize('NFKC').replace(HIDDEN_CHARS, '');
}

/** 글자 값 하나가 승인 엔티티를 언급하나 — 원래 글 · 푼 글 · 푼 글의 구분 글자(`/` · 공백 등)를 `_` 로 맞춘 글 차례. 맞은 꼴을 돌려준다 */
function protectedMentionIn(raw: string, decoded: string): string | null {
  if (mentionsWriteProtectedEntity(raw)) return raw;
  if (decoded !== raw && mentionsWriteProtectedEntity(decoded)) return decoded;
  // `/api/_action/cmh-ai/approval/x/decide` 처럼 `/` 로 나뉜 이름 — 영숫자 아닌 글자 덩이를 `_` 로 맞춰 다시 본다
  const joined = decoded.replace(/[^A-Za-z0-9]+/g, '_');
  return mentionsWriteProtectedEntity(joined) ? joined : null;
}

/** JSON 처럼 생긴 글이면 풀어 본다(`body: '{"entity":"cmh_ai_task","data":{"approvals":[…]}}'`). 아니면 undefined */
function parseJsonLike(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export interface ProtectedEntityScan {
  /** 승인 엔티티를 언급한 첫 글(원래 글 · 또는 푼 꼴) */
  readonly hit: string | null;
  /** 승인 엔티티로 가는 연관 칸 키(approval-entity.ts APPROVAL_ASSOCIATION_KEYS)를 처음 만난 키 */
  readonly association: string | null;
  /** false = 상한(깊이 · 값 수 · 풀기 글 길이)에 걸려 다 못 봤다 */
  readonly complete: boolean;
}

/**
 * 인자 안 모든 글자 값(객체 키 포함)을 깊이 훑어 ①쓰기 보호 엔티티(cmh_ai_approval)를 언급하는 첫 값 ②승인 엔티티 연관 칸 키를 찾는다.
 * 글자 값은 원래 꼴과 푼 꼴(deobfuscateText — 퍼센트 · JSON 이스케이프 · 전각 · 보이지 않는 글자)을 둘 다 보고,
 * JSON 처럼 생긴 글(원래 꼴 · 푼 꼴)은 풀어서 그 안의 키 · 값도 훑는다(깊이 하나 더).
 * 깊이 ARGS_SCAN_MAX_DEPTH · 값 ARGS_SCAN_MAX_VALUES · 글 길이 ARGS_SCAN_DECODE_MAX_CHARS 상한 — 넘으면 complete false(다 못 봤다).
 */
export function scanProtectedEntityMention(args: unknown): ProtectedEntityScan {
  const stack: Array<{ v: unknown; d: number; key: boolean }> = [{ v: args, d: 0, key: false }];
  let values = 0;
  let association: string | null = null;
  const incomplete = (): ProtectedEntityScan => ({ hit: null, association, complete: false });
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { v, d, key } = top;
    if (typeof v === 'string') {
      values += 1;
      if (values > ARGS_SCAN_MAX_VALUES) return incomplete();
      if (v.length > ARGS_SCAN_DECODE_MAX_CHARS) return incomplete();
      if (key && association === null && isApprovalAssociationKey(v)) association = v;
      const decoded = deobfuscateText(v);
      if (key && association === null && decoded !== v && isApprovalAssociationKey(decoded)) association = decoded;
      const hit = protectedMentionIn(v, decoded);
      if (hit !== null) return { hit, association, complete: true };
      if (!key) {
        const inner = parseJsonLike(v) ?? (decoded !== v ? parseJsonLike(decoded) : undefined);
        if (inner !== undefined && inner !== null && typeof inner === 'object') {
          if (d >= ARGS_SCAN_MAX_DEPTH) return incomplete();
          stack.push({ v: inner, d: d + 1, key: false });
        }
      }
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    const entries: Array<[string | null, unknown]> = Array.isArray(v)
      ? v.map((x): [null, unknown] => [null, x])
      : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) continue;
    if (d >= ARGS_SCAN_MAX_DEPTH) return incomplete();
    for (const [k, x] of entries) {
      if (k !== null) stack.push({ v: k, d: d + 1, key: true });
      stack.push({ v: x, d: d + 1, key: false });
    }
  }
  return { hit: null, association, complete: true };
}

/** 승인 화면에 보일 때 보이지 않는 글자를 `\u{…}` 글로 바꾼 꼴과 바꾼 글자 수(검수 5 권고 5 · E8). 🔴 표시용 — 실행 인자(argsFull)는 바꾸지 않는다 */
export function revealHiddenChars(text: string): { text: string; hiddenChars: number } {
  let hiddenChars = 0;
  const out = text.replace(HIDDEN_CHARS, (ch) => {
    hiddenChars += 1;
    return `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`;
  });
  return { text: out, hiddenChars };
}

/**
 * Guard target — 도구 이름과 상관없이(RA 검수 4 차단 1 · 검수 5 차단 1):
 * ①인자 어디든(중첩 `operations[].entity` · 객체 키 · JSON 글 안 · 퍼센트/JSON 이스케이프를 푼 꼴 포함) 승인 엔티티를 언급하는 글자 값이 있으면 그 값
 * ②다 못 훑었으면(깊이 · 값 수 · 글 길이 상한) 모양이 깨진 이름(ARGS_SCAN_INCOMPLETE_ENTITY) → Guard deny(모르면 막는 쪽)
 * ③인자에 `entity` · `entityName` · `entity_name` 이 있으면 그 값(글이 아니면 JSON 글 — Guard 가 모양이 깨진 엔티티로 보고 deny)
 * + 인자 어디든 승인 엔티티 연관 칸 키(approvals 등)가 있으면 association — Guard 가 읽기 꼴 도구가 아니면 deny.
 * 아무것도 없으면 undefined. 이름 판별(범용 DAL)은 evaluateToolCall 이 한다.
 */
export function guardTargetFor(_toolName: string, args: Record<string, unknown>): GuardTarget | undefined {
  const scan = scanProtectedEntityMention(args);
  if (scan.hit !== null) return { entity: scan.hit };
  if (!scan.complete) return { entity: ARGS_SCAN_INCOMPLETE_ENTITY };
  const association = scan.association !== null ? { association: scan.association } : {};
  for (const key of ENTITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const entity = args[key];
    return { entity: typeof entity === 'string' ? entity : (JSON.stringify(entity) ?? 'undefined'), ...association };
  }
  return scan.association !== null ? { association: scan.association } : undefined;
}

/**
 * 범용 DAL 쓰기 이름인가 — 마지막 마디를 Guard 와 같은 isDalWriteActionName 으로 본다(`[._-]` 를 떼고 `^dal` · 뒤가 읽기 동작이 아니면 쓰기).
 * `dalUpdate` · `dal-update` · `dal.update` · `dalupdate` · `DAL_UPDATE` 모두 잡는다(검수 5 권고 6).
 * Guard(evaluateGuard)도 원래 글자 마지막 마디로 같은 판별을 한다 — runner 는 target 을 꺼낸 바로 그 자리에서 한 번 더 본다.
 */
export function isDalWriteToolName(toolName: string): boolean {
  return isDalWriteActionName(toolName.split(':').pop() ?? '');
}

/** 도구 호출 한 번의 Guard 평가(실제 호출 · listing 아님): target 꺼내기 + target 없는 범용 DAL 쓰기 deny + evaluateGuard */
export function evaluateToolCall(
  policy: GuardPolicy,
  tool: Pick<RoutedTool, 'name' | 'known' | 'needsApproval'>,
  args: Record<string, unknown>,
): GuardResult {
  const target = guardTargetFor(tool.name, args);
  if (target?.entity === ARGS_SCAN_INCOMPLETE_ENTITY) return { decision: 'deny', requiresApproval: false, matchedPattern: ARGS_SCAN_LIMIT_PATTERN };
  // 연관 칸(association)이 있으면 Guard 가 그 규칙(builtin:approval-association)으로 먼저 막는다 — 더 알맞은 matchedPattern
  if (target?.entity === undefined && target?.association === undefined && isDalWriteToolName(tool.name)) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: DAL_WRITE_WITHOUT_TARGET_PATTERN };
  }
  return evaluateGuard(policy, { tool: tool.name, known: tool.known, needsApproval: tool.needsApproval, ...(target ? { target } : {}) });
}

/** 글자 수 → 토큰 어림 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const ABORTED: unique symbol = Symbol('aborted');

/** p 와 abort 약속 중 먼저 온 것. abort 가 먼저면 ABORTED — 상대가 signal 을 따르지 않아도 멈춘다(검수 4 권고 1) */
function raceAbort<T>(p: Promise<T>, aborted: Promise<void>): Promise<T | typeof ABORTED> {
  return Promise.race([p, aborted.then((): typeof ABORTED => ABORTED)]);
}

/** 기다리지 않고 이터레이터를 거둔다(공급자가 signal 을 무시해 멈춰 있어도 run 은 끝난다) */
function releaseIterator(it: AsyncIterator<unknown>): void {
  try {
    const r = it.return?.();
    if (r) void Promise.resolve(r).catch(() => undefined);
  } catch {
    // 거두기 실패는 run 결과와 무관
  }
}

interface PendingCall {
  /** 이벤트 callId — `${runId}-${step}-${차례}` */
  readonly eventId: string;
  /** 대화 tool_call_id — 고유하게 맞춘 모델 id */
  readonly messageId: string;
  /** 모델이 준 이름(TOOL_NAME_TEXT_MAX 로 자름) */
  readonly name: string;
  readonly argumentsJson: string;
  /** argumentsJson 이 maxToolArgsChars 를 넘음 */
  readonly argsOverLimit: boolean;
}

interface RawCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export class AgentRunner {
  private readonly approvalGate: ApprovalGate;
  private readonly newRunId: () => string;

  constructor(options: AgentRunnerOptions) {
    // 받은 객체가 InMemoryApprovalGate 여도 decide 에 닿지 못하게 겉객체만 쥔다(검수 4 권고 7)
    this.approvalGate = restrictGate(options.approvalGate);
    this.newRunId = options.newRunId ?? randomUUID;
  }

  run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.loop(input);
  }

  private async *loop(input: AgentRunInput): AsyncGenerator<AgentEvent, void, undefined> {
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...input.limits };
    const runId = input.runId ?? this.newRunId();
    const messages: ChatMessage[] = input.messages.map((m) => (m.tool_calls ? { ...m, tool_calls: [...m.tool_calls] } : { ...m }));
    const usage: ChatUsage = { promptTokens: 0, completionTokens: 0 };
    /** 걸음마다 usage 합(usage 없는 걸음은 글자 어림) — maxTotalTokens 비교 값 */
    let spentTokens = 0;
    let step = 0;
    let doneSent = false;

    // 대화에 이미 있는 tool_call id — 모델이 앞 걸음 id 를 다시 써도 겹치지 않게(검수 4 차단 3)
    const usedCallIds = new Set<string>();
    for (const m of messages) {
      for (const r of m.tool_calls ?? []) usedCallIds.add(r.id);
      if (m.tool_call_id !== undefined) usedCallIds.add(m.tool_call_id);
    }
    const uniqueCallId = (raw: string, i: number): string => {
      const base = raw.length > 0 && raw.length <= CALL_ID_MAX ? raw : `call_${step}_${i}`;
      let id = base;
      for (let n = 2; usedCallIds.has(id); n += 1) id = `${base}_${n}`;
      usedCallIds.add(id);
      return id;
    };

    // 바깥 signal · 시간 상한을 하나로. 먼저 온 까닭을 기억한다
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    let stopCause: 'aborted' | 'max_time' | null = null;
    const onExternalAbort = (): void => {
      stopCause ??= 'aborted';
      ctrl.abort();
    };
    if (input.signal?.aborted) onExternalAbort();
    else input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    // Node setTimeout 은 2^31-1 ms 를 넘거나 Infinity 면 1ms 로 바꿔 곧바로 부른다 — 그런 값은 «시간 상한 없음» 으로 읽는다
    const timer =
      Number.isFinite(limits.maxDurationMs) && limits.maxDurationMs <= TIMER_MAX_MS
        ? setTimeout(() => {
            stopCause ??= 'max_time';
            ctrl.abort();
          }, limits.maxDurationMs)
        : null;

    /** 이번 걸음에서 대화에 아직 답(role tool)을 안 단 호출 */
    let unanswered: PendingCall[] = [];
    /** tool_call 이벤트를 냈지만 닫는 이벤트를 아직 안 낸 호출 */
    let openCall: { readonly eventId: string; readonly tool: string } | null = null;

    const answer = (call: PendingCall, content: string): void => {
      messages.push({ role: 'tool', tool_call_id: call.messageId, content });
      unanswered = unanswered.filter((c) => c !== call);
    };
    const done = (reason: AgentDoneReason): AgentDoneEvent => ({
      type: 'done',
      runId,
      step,
      reason,
      usage: { ...usage },
      messages: [...messages],
    });
    /** 멈춤: 열린 도구 줄을 닫고 · 답 없는 tool_call 을 «실행 안 함» 으로 닫고 · done 한 번 */
    const stopEvents = (reason: AgentDoneReason): AgentEvent[] => {
      if (doneSent) return [];
      const out: AgentEvent[] = [];
      if (openCall !== null) {
        out.push({
          type: 'tool_denied',
          runId,
          step,
          callId: openCall.eventId,
          tool: openCall.tool,
          reason: 'stopped',
          matchedPattern: null,
          message: AGENT_TEXT.notRun(reason),
        });
        openCall = null;
      }
      for (const c of [...unanswered]) answer(c, AGENT_TEXT.notRun(reason));
      out.push(done(reason));
      doneSent = true;
      return out;
    };
    const stopReason = (): AgentDoneReason => stopCause ?? 'aborted';

    try {
      // ---- 도구 목록(한 번) — 출처 실패는 조용히 넘기지 않고 error 이벤트(run 은 이어 간다)
      // 출처가 끝나지 않아도(브라우저 다리 · MCP 저장 행 읽기 등) 시간 상한 · 취소로 멈춘다(검수 5 권고 1 · E6)
      try {
        const refreshed = await raceAbort(
          Promise.resolve().then(() => input.tools.refresh()),
          aborted,
        );
        if (refreshed === ABORTED) {
          yield* stopEvents(stopReason());
          return;
        }
        for (const message of refreshed.errors) yield { type: 'error', runId, step, source: 'catalog', message: capError(message) };
      } catch (e) {
        yield { type: 'error', runId, step, source: 'catalog', message: capError(errorText(e)) };
      }
      const { policy } = input;
      const defSet = input.tools.definitions({
        maxTools: limits.maxTools,
        maxDescriptionChars: limits.maxDescriptionChars,
        maxTotalChars: limits.maxToolDefinitionChars,
        // 이름만으로 deny 인 도구는 모델에게 보이지 않는다(원칙 2 토큰 절약) — 그래도 불리면 아래 Guard 가 다시 막는다.
        // listing: true — 인자가 아직 없으므로 «target 없는 범용 DAL 쓰기 deny» 는 실제 호출 때 본다(검수 4 차단 4)
        filter: (t: RoutedTool) => evaluateGuard(policy, { tool: t.name, known: t.known, needsApproval: t.needsApproval, listing: true }).decision !== 'deny',
      });
      const definitions: ChatToolDefinition[] = defSet.tools;
      // 이번 run 의 고정 이름 표 — 보여 준 도구만(검수 4 권고 3 · 10)
      const offered: ReadonlyMap<string, RoutedTool> = defSet.byName instanceof Map ? defSet.byName : offeredFromLookup(definitions, input.tools);
      const definitionChars = definitions.length > 0 ? JSON.stringify(definitions).length : 0;
      const repeats = new Map<string, number>();

      for (;;) {
        if (signal.aborted) {
          yield* stopEvents(stopReason());
          return;
        }
        // ---- 토큰 사전 검사 — 모델을 부르기 전에(검수 4 권고 5)
        const promptEstimate = estimateTokens(JSON.stringify(messages).length + definitionChars);
        if (spentTokens + promptEstimate > limits.maxTotalTokens) {
          yield* stopEvents('max_tokens');
          return;
        }
        step += 1;

        // ---- 모델 호출
        const request: ChatRequest = { model: input.model.code, messages: [...messages] };
        if (definitions.length > 0) request.tools = definitions;
        let text = '';
        const rawCalls: RawCall[] = [];
        let droppedCalls = 0;
        let stepUsage: ChatUsage | null = null;
        let modelError: string | null = null;
        let iterator: AsyncIterator<ChatChunk> | null = null;
        let finished = false;
        try {
          iterator = input.model.provider.chat(request, signal)[Symbol.asyncIterator]();
          for (;;) {
            const r = await raceAbort(iterator.next(), aborted);
            if (r === ABORTED) break;
            if (r.done === true) {
              finished = true;
              break;
            }
            const c = r.value;
            switch (c.type) {
              case 'delta':
                text += c.text;
                yield { type: 'delta', runId, step, text: c.text };
                break;
              case 'reasoning':
                yield { type: 'reasoning', runId, step, text: c.text };
                break;
              case 'tool_call':
                if (rawCalls.length < TOOL_CALLS_RECORD_MAX) rawCalls.push({ id: c.id, name: c.name, argumentsJson: c.argumentsJson });
                else droppedCalls += 1;
                break;
              case 'done':
                if (c.usage) {
                  stepUsage = c.usage;
                  usage.promptTokens += c.usage.promptTokens;
                  usage.completionTokens += c.usage.completionTokens;
                  if (c.usage.reasoningTokens !== undefined) usage.reasoningTokens = (usage.reasoningTokens ?? 0) + c.usage.reasoningTokens;
                }
                break;
              case 'error':
                modelError = modelError === null ? c.message : `${modelError}\n${c.message}`;
                break;
            }
          }
        } catch (e) {
          // 공급자 약속(chat 은 던지지 않음)을 어긴 경우도 같은 길로
          modelError = modelError === null ? errorText(e) : `${modelError}\n${errorText(e)}`;
          finished = true;
        } finally {
          if (!finished && iterator !== null) releaseIterator(iterator);
        }
        const argsChars = rawCalls.reduce((n, c) => n + c.name.length + c.argumentsJson.length, 0);
        spentTokens += stepUsage
          ? stepUsage.promptTokens + stepUsage.completionTokens
          : promptEstimate + estimateTokens(text.length + argsChars);

        if (signal.aborted) {
          if (text.length > 0) messages.push({ role: 'assistant', content: text });
          yield* stopEvents(stopReason());
          return;
        }
        if (modelError !== null) {
          const message = capError(modelError);
          yield { type: 'error', runId, step, source: 'model', message };
          messages.push({ role: 'assistant', content: `${text}${text.length > 0 ? '\n' : ''}${AGENT_TEXT.modelError(message)}` });
          yield* stopEvents('error');
          return;
        }
        if (rawCalls.length === 0) {
          messages.push({ role: 'assistant', content: text });
          yield* stopEvents('final');
          return;
        }

        // ---- 호출 정리: 이벤트 id 는 runner 가 · 대화 id 는 겹치면 고유하게(검수 4 차단 3) · 인자 글 상한
        const calls: PendingCall[] = rawCalls.map((c, i) => ({
          eventId: `${runId}-${step}-${i + 1}`,
          messageId: uniqueCallId(c.id, i + 1),
          name: c.name.slice(0, TOOL_NAME_TEXT_MAX),
          argumentsJson: c.argumentsJson,
          argsOverLimit: c.argumentsJson.length > limits.maxToolArgsChars,
        }));
        const refs: ChatToolCallRef[] = calls.map((c) => ({
          id: c.messageId,
          type: 'function',
          function: {
            name: c.name,
            arguments: c.argsOverLimit ? JSON.stringify({ _omitted: AGENT_TEXT.argsOmitted(c.argumentsJson.length) }) : c.argumentsJson,
          },
        }));
        messages.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls: refs });
        unanswered = [...calls];

        // ---- 상한 — 도구를 부르기 전에 본다(읽을 모델이 없는 도구 결과를 만들지 않게)
        if (spentTokens >= limits.maxTotalTokens) {
          yield* stopEvents('max_tokens');
          return;
        }
        if (step >= limits.maxSteps) {
          yield* stopEvents('max_steps');
          return;
        }

        // ---- 한 걸음 도구 호출 상한(검수 4 권고 4) — 넘는 호출은 이벤트 없이 «실행 안 함» 으로 닫는다(아래 걸음 끝에서)
        const runCalls = calls.slice(0, Math.max(0, limits.maxToolCallsPerStep));
        const skippedCalls = calls.slice(runCalls.length);
        if (skippedCalls.length > 0 || droppedCalls > 0) {
          yield {
            type: 'error',
            runId,
            step,
            source: 'runner',
            message: AGENT_TEXT.callLimitNotice(limits.maxToolCallsPerStep, skippedCalls.length, droppedCalls),
          };
        }

        // ---- 도구 — 차례로 하나씩(승인 대기가 한 번에 하나가 되게)
        for (const call of runCalls) {
          if (signal.aborted) {
            yield* stopEvents(stopReason());
            return;
          }
          const routed = offered.get(call.name) ?? null;
          const toolName = routed?.name ?? call.name;
          const parsed: ReturnType<typeof parseToolArgs> = call.argsOverLimit
            ? { ok: false, error: AGENT_TEXT.argsOverLimit(call.argumentsJson.length, limits.maxToolArgsChars) }
            : parseToolArgs(call.argumentsJson);
          const argsSummary = parsed.ok ? summarizeArgs(parsed.args) : capText(call.argumentsJson, ARGS_SUMMARY_MAX).text;
          yield { type: 'tool_call', runId, step, callId: call.eventId, toolCallId: call.messageId, tool: toolName, argsSummary };
          openCall = { eventId: call.eventId, tool: toolName };

          const deny = (reason: ToolDeniedReason, content: string, matchedPattern: string | null): AgentEvent => {
            answer(call, content);
            openCall = null;
            return { type: 'tool_denied', runId, step, callId: call.eventId, tool: toolName, reason, matchedPattern, message: content };
          };

          if (routed === null) {
            const message = AGENT_TEXT.unknownTool(call.name);
            yield { type: 'error', runId, step, source: 'tool', callId: call.eventId, message };
            yield deny('unknown_tool', message, null);
            continue;
          }
          if (!parsed.ok) {
            const message = AGENT_TEXT.badArgs(parsed.error);
            yield { type: 'error', runId, step, source: 'tool', callId: call.eventId, message };
            yield deny('bad_args', message, null);
            continue;
          }

          // 무한 루프 막기 — Guard 앞에서 센다(거부된 호출을 되풀이해도 멈춘다)
          const signature = `${routed.name} ${canonicalJson(parsed.args)}`;
          const seen = (repeats.get(signature) ?? 0) + 1;
          repeats.set(signature, seen);
          if (seen >= limits.maxRepeatCalls) {
            yield deny('loop', AGENT_TEXT.loop, null);
            yield* stopEvents('loop_detected');
            return;
          }

          const guard = evaluateToolCall(policy, routed, parsed.args);
          if (guard.decision === 'deny') {
            yield deny('guard', AGENT_TEXT.denied(guard.matchedPattern), guard.matchedPattern);
            continue;
          }

          if (guard.decision === 'ask' || guard.requiresApproval) {
            const reason = guard.decision === 'ask' ? 'guard_ask' : 'requires_approval';
            // 사람이 볼 인자 전문 — 자르지 않고 가리지 않는다(검수 4 차단 2). 상한을 넘으면 승인을 열지 않는다
            const argsFull = canonicalJson(parsed.args);
            // 보이지 않는 글자(RTL override · zero-width 등) 수 — R6 승인 화면이 revealHiddenChars 로 보이게 그리고 경고한다(검수 5 권고 5)
            const { hiddenChars } = revealHiddenChars(argsFull);
            if (Buffer.byteLength(argsFull, 'utf8') > APPROVAL_ARGS_MAX_BYTES) {
              yield deny('args_too_large', AGENT_TEXT.argsTooLarge, guard.matchedPattern);
              continue;
            }
            const { maskedKeys } = maskArgs(parsed.args);
            let ticket: ApprovalTicket | null = null;
            try {
              const opened = await raceAbort(
                Promise.resolve().then(() =>
                  this.approvalGate.open({ runId, tool: routed.name, argsSummary, argsFull, maskedKeys, matchedPattern: guard.matchedPattern, reason, signal }),
                ),
                aborted,
              );
              if (opened === ABORTED) {
                yield* stopEvents(stopReason());
                return;
              }
              ticket = opened;
            } catch (e) {
              yield { type: 'error', runId, step, source: 'runner', callId: call.eventId, message: capError(`approval gate: ${errorText(e)}`) };
            }
            let outcome: ApprovalOutcome;
            if (ticket === null) {
              outcome = 'rejected'; // 관문이 고장 나면 막는 쪽
            } else {
              yield {
                type: 'approval_required',
                runId,
                step,
                approvalId: ticket.id,
                callId: call.eventId,
                tool: routed.name,
                argsSummary,
                argsFull,
                maskedKeys,
                matchedPattern: guard.matchedPattern,
                reason,
                ...(hiddenChars > 0 ? { argsHiddenChars: hiddenChars } : {}),
                ...(typeof ticket.expiresAt === 'number' ? { expiresAt: ticket.expiresAt } : {}),
              };
              // decision 이 reject 되면 바깥 catch 로 — 남은 호출을 닫고 done error(검수 4 권고 2)
              const decided = await raceAbort(Promise.resolve(ticket.decision), aborted);
              if (decided === ABORTED || signal.aborted) {
                yield* stopEvents(stopReason());
                return;
              }
              outcome = decided;
              yield { type: 'approval_decided', runId, step, approvalId: ticket.id, callId: call.eventId, decision: outcome };
            }
            if (outcome !== 'approved') {
              const deniedReason = outcome === 'timeout' ? 'timeout' : 'rejected';
              yield deny(deniedReason, deniedReason === 'timeout' ? AGENT_TEXT.approvalTimeout : AGENT_TEXT.rejected, guard.matchedPattern);
              continue;
            }
          }

          // 도구가 약속(던지지 않음)을 어겨도 실패 결과로 받는다
          const called = await raceAbort(
            Promise.resolve()
              .then(() =>
                input.tools.call(routed.name, parsed.args, {
                  signal,
                  ...(limits.toolTimeoutMs !== undefined ? { timeoutMs: limits.toolTimeoutMs } : {}),
                }),
              )
              .catch((e: unknown): ToolCallResult => ({ ok: false, error: `${routed.name}: ${errorText(e)}`, truncated: false })),
            aborted,
          );
          if (called === ABORTED || signal.aborted) {
            yield* stopEvents(stopReason());
            return;
          }
          const result = called;
          if (result.ok) {
            const cut = capText(result.text, limits.maxToolResultChars);
            answer(call, cut.text);
            openCall = null;
            yield { type: 'tool_result', runId, step, callId: call.eventId, tool: routed.name, ok: true, summary: cut.text, truncated: result.truncated || cut.cut };
          } else {
            const cut = capText(AGENT_TEXT.toolError(result.error), limits.maxToolResultChars);
            answer(call, cut.text);
            openCall = null;
            yield { type: 'error', runId, step, source: 'tool', callId: call.eventId, message: capError(result.error) };
            yield { type: 'tool_result', runId, step, callId: call.eventId, tool: routed.name, ok: false, summary: cut.text, truncated: result.truncated || cut.cut };
          }
        }
        for (const c of skippedCalls) answer(c, AGENT_TEXT.callLimit(limits.maxToolCallsPerStep));
      }
    } catch (e) {
      // 여기 오면 runner 자체의 잘못(또는 관문 decision 의 reject) — 그래도 던지지 않고 답 없는 호출을 닫는다
      if (!doneSent) {
        yield { type: 'error', runId, step, source: 'runner', message: capError(errorText(e)) };
        yield* stopEvents('error');
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
      // 부르는 쪽이 for-await 를 중간에 끊어도 승인 대기 · 모델 스트림 · 도구 호출을 거둔다
      ctrl.abort();
    }
  }
}

/** byName 을 안 주는 toolbox — 보여 준 정의 이름만 lookup 해 고정 표를 만든다(키 = 모델 이름 · Guard 이름) */
function offeredFromLookup(definitions: readonly ChatToolDefinition[], tools: AgentToolbox): ReadonlyMap<string, RoutedTool> {
  const out = new Map<string, RoutedTool>();
  for (const d of definitions) {
    const t = tools.lookup(d.function.name);
    if (t === null) continue;
    out.set(t.modelName, t);
    out.set(t.name, t);
  }
  return out;
}
