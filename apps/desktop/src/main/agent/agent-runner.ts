// RA — 에이전트 실행 루프 뼈대. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» 1·5 · `#### [ ] RA.`
//
// 한 걸음(step) = 모델 호출 한 번:
//   모델 스트림(delta · reasoning 은 그대로 이벤트) → tool_call 모으기 → 도구마다 차례로
//   [되풀이 검사 → Guard(evaluateGuard) → (ask · requiresApproval 이면) 승인 관문 → ToolRouter.call → 결과를 role 'tool' 메시지로 붙임]
//   → 다음 걸음. 도구 호출이 없는 답이 오면 done 'final'.
// 🔴 던지지 않는다 — 모든 실패(모델 error 조각 · 공급자 예외 · 도구 실패 · 승인 관문 실패)는 이벤트 error + 대화에 오류 글.
// 🔴 승인 결정은 여기서 못 한다 — ApprovalGate 인터페이스에는 decide 가 없다(합의안 5 · approval-gate.ts).
// 🔴 멈출 때 답 없는 tool_call 이 남으면 «실행 안 함» tool 메시지로 닫는다 — 저장한 대화를 다시 이어 보낼 때 OpenAI 꼴(모든 tool_call 에 tool 답)이 깨지지 않게.
// ⚠️ 로컬 GGUF · ONNX 공급자는 아직 role 'tool' · tool_calls 메시지를 받으면 error 조각을 낸다(gguf-text-provider.ts:44-45 · onnx-text-provider.ts:75-76)
//    → 지금 도구 루프는 OpenAI 호환 · 서버 relay 공급자에서만 두 걸음 이상 간다.
import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatRequest, ChatToolCallRef, ChatUsage, ModelProvider } from '../models/model-provider.js';
import { errorText } from '../models/model-provider.js';
import { evaluateGuard } from '../settings/guard-policy.js';
import type { GuardPolicy, GuardTarget } from '../settings/guard-policy.js';
import type { AgentDoneEvent, AgentDoneReason, AgentEvent } from './agent-events.js';
import type { ApprovalGate, ApprovalOutcome, ApprovalTicket } from './approval-gate.js';
import type { RoutedTool, ToolRouter } from './tool-router.js';
import { TOOL_DEFINITION_DEFAULTS } from './tool-router.js';

/** 모델 — ModelRegistry.resolve(code) 의 provider 와 modelRow.code */
export interface AgentModel {
  readonly provider: ModelProvider;
  /** `cmh_ai_model.code` — ChatRequest.model */
  readonly code: string;
}

/** AgentRunner 가 쓰는 도구 쪽(ToolRouter 그대로 또는 시험 가짜) */
export type AgentToolbox = Pick<ToolRouter, 'refresh' | 'definitions' | 'lookup' | 'call'>;

export interface AgentLimits {
  /** 모델 호출 수 상한 */
  readonly maxSteps: number;
  /** usage(prompt + completion) 합 상한 — usage 를 안 주는 공급자는 세지 못한다 */
  readonly maxTotalTokens: number;
  /** run 전체 시간 상한(사람 승인 기다림 포함) */
  readonly maxDurationMs: number;
  /** 같은 도구 · 같은 인자 호출이 이 횟수에 닿으면 그 호출은 하지 않고 멈춘다 */
  readonly maxRepeatCalls: number;
  /** 도구 결과를 모델에게 붙일 때 글 상한(원칙 2 토큰 절약 · 1차 «요약» = 앞부분 자르기) */
  readonly maxToolResultChars: number;
  /** 도구 하나 시간 상한 — 없으면 출처 기본값(MCP 는 MCP_DEFAULTS.callTimeoutMs) */
  readonly toolTimeoutMs?: number;
  /** 모델에게 줄 도구 수 · 설명 길이 · 정의 글자 합 상한 */
  readonly maxTools: number;
  readonly maxDescriptionChars: number;
  readonly maxToolDefinitionChars: number;
}

/**
 * maxSteps 12 · maxRepeatCalls 3 은 브리프 값. 나머지는 【임시 기본값 · 근거 없음】 —
 * 다음 차례에 `cmh_ai_agent` 테이블 값(PLAN RA «5. 하는 일»)으로 바꾼다.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxSteps: 12,
  maxTotalTokens: 200_000,
  maxDurationMs: 10 * 60_000,
  maxRepeatCalls: 3,
  maxToolResultChars: 4_000,
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
  readonly approvalGate: ApprovalGate;
  /** 시험용 */
  readonly newRunId?: () => string;
}

/** 모델 · UI 에 보이는 글. 화면 번역(snippet)은 R6 가 붙일 때 이 자리에서 키로 바꾼다 */
export const AGENT_TEXT = {
  denied: (pattern: string | null) => `거부됨: ${pattern ?? '규칙 없음'}`,
  rejected: '거부됨: 사람이 거절함',
  approvalTimeout: '거부됨: 승인 시간 초과',
  toolError: (message: string) => `오류: ${message}`,
  modelError: (message: string) => `[오류] ${message}`,
  unknownTool: (name: string) => `오류: 모르는 도구 "${name}"`,
  badArgs: (message: string) => `오류: 인자 JSON 이 잘못됨 — ${message}`,
  notRun: (reason: AgentDoneReason) => `실행 안 함: run 이 멈춤(${reason})`,
  cut: (cutChars: number) => `\n…(${cutChars}자 잘림)`,
} as const;

const ARGS_SUMMARY_MAX = 500;
/** setTimeout 이 받는 가장 큰 지연(ms) */
const TIMER_MAX_MS = 2_147_483_647;
/** 인자 요약에서 값을 `***` 로 가리는 키 */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential/i;

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

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '***' : maskSecrets(v);
    return out;
  }
  return value;
}

/** UI · 승인 화면에 보일 인자 요약(비밀 같은 키는 가림 · 글 상한) */
export function summarizeArgs(args: Record<string, unknown>): string {
  return capText(JSON.stringify(maskSecrets(args)), ARGS_SUMMARY_MAX).text;
}

export function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, max)}${AGENT_TEXT.cut(text.length - max)}`, cut: true };
}

/** 인자 JSON → 객체. 빈 글은 {} · 객체가 아니면 오류 글 */
export function parseToolArgs(argumentsJson: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (argumentsJson.trim().length === 0) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'arguments must be a JSON object' };
  return { ok: true, args: parsed as Record<string, unknown> };
}

/**
 * Guard target — DAL 꼴 도구(마지막 마디가 `dal_` 로 시작)의 인자 `entity`.
 * Guard 검수 «범용 DAL 우회» 대응: `dal_update({ entity: 'cmh_ai_approval' })` 처럼 이름에 엔티티가 없는 범용 도구도 승인 엔티티 쓰기를 막으려고.
 * entity 가 글이 아니면 JSON 글로 넘긴다 — Guard 가 모양이 깨진 엔티티로 보고 deny 한다(모르면 막는 쪽).
 */
export function guardTargetFor(toolName: string, args: Record<string, unknown>): GuardTarget | undefined {
  const last = toolName.split(':').pop() ?? '';
  if (!/^dal_/i.test(last) || !Object.prototype.hasOwnProperty.call(args, 'entity')) return undefined;
  const entity = args['entity'];
  return { entity: typeof entity === 'string' ? entity : (JSON.stringify(entity) ?? 'undefined') };
}

interface PendingCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export class AgentRunner {
  private readonly approvalGate: ApprovalGate;
  private readonly newRunId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.approvalGate = options.approvalGate;
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
    let step = 0;

    // 바깥 signal · 시간 상한을 하나로. 먼저 온 까닭을 기억한다
    const ctrl = new AbortController();
    const signal = ctrl.signal;
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

    const done = (reason: AgentDoneReason): AgentDoneEvent => ({
      type: 'done',
      runId,
      step,
      reason,
      usage: { ...usage },
      messages: [...messages],
    });
    /** 답 없는 tool_call 을 «실행 안 함» 으로 닫는다 */
    const closeCalls = (calls: readonly PendingCall[], reason: AgentDoneReason): void => {
      for (const c of calls) messages.push({ role: 'tool', tool_call_id: c.id, content: AGENT_TEXT.notRun(reason) });
    };

    try {
      // ---- 도구 목록(한 번) — 출처 실패는 조용히 넘기지 않고 error 이벤트(run 은 이어 간다)
      try {
        const { errors } = await input.tools.refresh();
        for (const message of errors) yield { type: 'error', runId, step, source: 'catalog', message };
      } catch (e) {
        yield { type: 'error', runId, step, source: 'catalog', message: errorText(e) };
      }
      const { policy } = input;
      const definitions = input.tools.definitions({
        maxTools: limits.maxTools,
        maxDescriptionChars: limits.maxDescriptionChars,
        maxTotalChars: limits.maxToolDefinitionChars,
        // 이름만으로 deny 인 도구는 모델에게 보이지 않는다(원칙 2 토큰 절약) — 그래도 불리면 아래 Guard 가 다시 막는다
        filter: (t: RoutedTool) => evaluateGuard(policy, { tool: t.name, known: t.known, needsApproval: t.needsApproval }).decision !== 'deny',
      }).tools;
      const repeats = new Map<string, number>();

      for (;;) {
        if (signal.aborted) {
          yield done(stopCause ?? 'aborted');
          return;
        }
        step += 1;

        // ---- 모델 호출
        const request: ChatRequest = { model: input.model.code, messages: [...messages] };
        if (definitions.length > 0) request.tools = definitions;
        let text = '';
        const calls: PendingCall[] = [];
        let modelError: string | null = null;
        try {
          for await (const c of input.model.provider.chat(request, signal)) {
            switch (c.type) {
              case 'delta':
                text += c.text;
                yield { type: 'delta', runId, step, text: c.text };
                break;
              case 'reasoning':
                yield { type: 'reasoning', runId, step, text: c.text };
                break;
              case 'tool_call':
                calls.push({ id: c.id.length > 0 ? c.id : `call_${step}_${calls.length + 1}`, name: c.name, argumentsJson: c.argumentsJson });
                break;
              case 'done':
                if (c.usage) {
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
        }

        if (signal.aborted) {
          if (text.length > 0) messages.push({ role: 'assistant', content: text });
          yield done(stopCause ?? 'aborted');
          return;
        }
        if (modelError !== null) {
          yield { type: 'error', runId, step, source: 'model', message: modelError };
          messages.push({ role: 'assistant', content: `${text}${text.length > 0 ? '\n' : ''}${AGENT_TEXT.modelError(modelError)}` });
          yield done('error');
          return;
        }
        if (calls.length === 0) {
          messages.push({ role: 'assistant', content: text });
          yield done('final');
          return;
        }

        const refs: ChatToolCallRef[] = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argumentsJson } }));
        messages.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls: refs });

        // ---- 상한 — 도구를 부르기 전에 본다(읽을 모델이 없는 도구 결과를 만들지 않게)
        if (usage.promptTokens + usage.completionTokens >= limits.maxTotalTokens) {
          closeCalls(calls, 'max_tokens');
          yield done('max_tokens');
          return;
        }
        if (step >= limits.maxSteps) {
          closeCalls(calls, 'max_steps');
          yield done('max_steps');
          return;
        }

        // ---- 도구 — 차례로 하나씩(승인 대기가 한 번에 하나가 되게)
        for (let i = 0; i < calls.length; i += 1) {
          const call = calls[i] as PendingCall;
          const rest = calls.slice(i);
          if (signal.aborted) {
            closeCalls(rest, stopCause ?? 'aborted');
            yield done(stopCause ?? 'aborted');
            return;
          }
          const routed = input.tools.lookup(call.name);
          const toolName = routed?.name ?? call.name;
          const parsed = parseToolArgs(call.argumentsJson);
          const argsSummary = parsed.ok ? summarizeArgs(parsed.args) : capText(call.argumentsJson, ARGS_SUMMARY_MAX).text;
          yield { type: 'tool_call', runId, step, callId: call.id, tool: toolName, argsSummary };

          if (routed === null) {
            const message = AGENT_TEXT.unknownTool(call.name);
            messages.push({ role: 'tool', tool_call_id: call.id, content: message });
            yield { type: 'error', runId, step, source: 'tool', callId: call.id, message };
            continue;
          }
          if (!parsed.ok) {
            const message = AGENT_TEXT.badArgs(parsed.error);
            messages.push({ role: 'tool', tool_call_id: call.id, content: message });
            yield { type: 'error', runId, step, source: 'tool', callId: call.id, message };
            continue;
          }

          // 무한 루프 막기 — Guard 앞에서 센다(거부된 호출을 되풀이해도 멈춘다)
          const signature = `${routed.name} ${canonicalJson(parsed.args)}`;
          const seen = (repeats.get(signature) ?? 0) + 1;
          repeats.set(signature, seen);
          if (seen >= limits.maxRepeatCalls) {
            closeCalls(rest, 'loop_detected');
            yield done('loop_detected');
            return;
          }

          const target = guardTargetFor(routed.name, parsed.args);
          const guard = evaluateGuard(policy, {
            tool: routed.name,
            known: routed.known,
            needsApproval: routed.needsApproval,
            ...(target ? { target } : {}),
          });
          if (guard.decision === 'deny') {
            messages.push({ role: 'tool', tool_call_id: call.id, content: AGENT_TEXT.denied(guard.matchedPattern) });
            yield { type: 'tool_denied', runId, step, callId: call.id, tool: routed.name, reason: 'guard', matchedPattern: guard.matchedPattern };
            continue;
          }

          if (guard.decision === 'ask' || guard.requiresApproval) {
            const reason = guard.decision === 'ask' ? 'guard_ask' : 'requires_approval';
            let ticket: ApprovalTicket | null = null;
            let outcome: ApprovalOutcome;
            try {
              ticket = await this.approvalGate.open({ runId, tool: routed.name, argsSummary, reason, signal });
            } catch (e) {
              yield { type: 'error', runId, step, source: 'runner', callId: call.id, message: `approval gate: ${errorText(e)}` };
            }
            if (ticket === null) {
              outcome = 'rejected'; // 관문이 고장 나면 막는 쪽
            } else {
              yield { type: 'approval_required', runId, step, approvalId: ticket.id, callId: call.id, tool: routed.name, argsSummary, reason };
              outcome = await ticket.decision;
              if (signal.aborted) {
                closeCalls(rest, stopCause ?? 'aborted');
                yield done(stopCause ?? 'aborted');
                return;
              }
              yield { type: 'approval_decided', runId, step, approvalId: ticket.id, callId: call.id, decision: outcome };
            }
            if (outcome !== 'approved') {
              const deniedReason = outcome === 'timeout' ? 'timeout' : 'rejected';
              messages.push({ role: 'tool', tool_call_id: call.id, content: deniedReason === 'timeout' ? AGENT_TEXT.approvalTimeout : AGENT_TEXT.rejected });
              yield { type: 'tool_denied', runId, step, callId: call.id, tool: routed.name, reason: deniedReason, matchedPattern: guard.matchedPattern };
              continue;
            }
          }

          const result = await input.tools.call(routed.name, parsed.args, {
            signal,
            ...(limits.toolTimeoutMs !== undefined ? { timeoutMs: limits.toolTimeoutMs } : {}),
          });
          if (signal.aborted) {
            closeCalls(rest, stopCause ?? 'aborted');
            yield done(stopCause ?? 'aborted');
            return;
          }
          if (result.ok) {
            const cut = capText(result.text, limits.maxToolResultChars);
            messages.push({ role: 'tool', tool_call_id: call.id, content: cut.text });
            yield { type: 'tool_result', runId, step, callId: call.id, tool: routed.name, ok: true, summary: cut.text, truncated: result.truncated || cut.cut };
          } else {
            const cut = capText(AGENT_TEXT.toolError(result.error), limits.maxToolResultChars);
            messages.push({ role: 'tool', tool_call_id: call.id, content: cut.text });
            yield { type: 'error', runId, step, source: 'tool', callId: call.id, message: result.error };
            yield { type: 'tool_result', runId, step, callId: call.id, tool: routed.name, ok: false, summary: cut.text, truncated: result.truncated || cut.cut };
          }
        }
      }
    } catch (e) {
      // 여기 오면 runner 자체의 잘못 — 그래도 던지지 않는다
      yield { type: 'error', runId, step, source: 'runner', message: errorText(e) };
      yield done('error');
    } finally {
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
      // 부르는 쪽이 for-await 를 중간에 끊어도 승인 대기 · 모델 스트림 · 도구 호출을 거둔다
      ctrl.abort();
    }
  }
}
