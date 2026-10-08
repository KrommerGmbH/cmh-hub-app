// RA — 에이전트 실행 루프가 내는 이벤트 꼴. electron 을 import 하지 않는 순수 모듈.
// R6 챗 pane 이 이 이벤트를 그대로 그린다: delta · reasoning 은 답 글, tool_call ~ (tool_result | tool_denied) 는 Aside 의 «접히는 도구 줄» 한 줄(callId 로 묶음),
// approval_required 는 승인 버튼(approvalId 로 `decide` IPC · 승인 화면은 argsFull 전문을 보여 준다), done 은 끝 표시 + 대화 저장(messages).
// 약속(RA 검수 4 · 시험 «모든 tool_call 이벤트에 닫는 이벤트가 하나»):
//   ①tool_call 이벤트 하나마다 닫는 이벤트(tool_result 또는 tool_denied)가 정확히 하나 · 같은 callId 로 온다. error(callId 있음)는 덧붙는 알림이지 닫는 이벤트가 아니다.
//   ②done 은 어느 길로 끝나든 정확히 한 번 · 마지막 이벤트다. done 이 오면 R6 은 남은 승인 버튼을 거둔다.
//   ③callId 는 runner 가 만든 `${runId}-${step}-${차례}` — 모델이 준 id 가 겹쳐도 고유하다. 대화(messages)의 tool_call_id 는 toolCallId.
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» 1 · `#### [ ] RA.`
import type { ChatMessage, ChatUsage } from '../models/model-provider.js';
import type { ApprovalOutcome, ApprovalReason } from './approval-gate.js';

/** 끝난 까닭. max_time 은 시간 상한(limits.maxDurationMs) — 브리프의 다섯 + 시간 상한 하나 */
export type AgentDoneReason = 'final' | 'max_steps' | 'max_tokens' | 'max_time' | 'aborted' | 'error' | 'loop_detected';

/**
 * 도구가 안 불렸거나 결과 없이 닫힌 까닭 —
 * guard(정책 deny · 내장 규칙) · rejected(사람이 거절 · 관문 고장) · timeout(승인 시간 초과) ·
 * args_too_large(인자가 승인 화면 상한을 넘어 사람이 확인할 수 없음) · loop(같은 도구 · 같은 인자 되풀이 — 곧 done loop_detected) ·
 * unknown_tool(이번 run 에 보여 주지 않은 이름) · bad_args(깨진 인자 JSON · 인자 글 상한 넘음) ·
 * stopped(run 이 멈춤 — 취소 · 시간 상한 · 오류. 도구가 이미 시작됐을 수도 있다)
 */
export type ToolDeniedReason = 'guard' | 'rejected' | 'timeout' | 'args_too_large' | 'loop' | 'unknown_tool' | 'bad_args' | 'stopped';

/** 오류가 난 곳 — model(error 조각 · 공급자 예외) · tool(도구 실패 · 모르는 도구 · 깨진 인자) · catalog(도구 목록 가져오기 실패) · runner(루프 자체) */
export type AgentErrorSource = 'model' | 'tool' | 'catalog' | 'runner';

interface EventBase {
  readonly runId: string;
  /** 모델 호출 차례(1부터). 첫 모델 호출 전 이벤트는 0 */
  readonly step: number;
}

export interface AgentDeltaEvent extends EventBase {
  readonly type: 'delta';
  readonly text: string;
}

export interface AgentReasoningEvent extends EventBase {
  readonly type: 'reasoning';
  readonly text: string;
}

export interface AgentToolCallEvent extends EventBase {
  readonly type: 'tool_call';
  /** UI 묶음 열쇠 — runner 가 만든 `${runId}-${step}-${차례}`(모델 id 와 무관 · run 안에서 고유) */
  readonly callId: string;
  /** 대화(messages)의 tool_call_id — 모델 id 가 비었거나 겹치면 runner 가 고유하게 바꾼 값 */
  readonly toolCallId: string;
  /** Guard 이름(`mcp:<서버>:<도구>` · `app:<이름>` · `browser:<이름>`). 모르는 도구면 모델이 준 이름(200자 상한) */
  readonly tool: string;
  /** 도구 줄용 인자 요약(비밀 같은 키 값은 `***(N자)` · 500자 상한) — 승인 판단에 쓰지 않는다(approval_required.argsFull) */
  readonly argsSummary: string;
}

export interface AgentToolDeniedEvent extends EventBase {
  readonly type: 'tool_denied';
  readonly callId: string;
  readonly tool: string;
  readonly reason: ToolDeniedReason;
  /** Guard 가 맞춘 규칙(reason 'guard' 일 때) · 없으면 null */
  readonly matchedPattern: string | null;
  /** 모델에게 돌려준 글(대화의 tool 메시지와 같음) */
  readonly message?: string;
}

export interface AgentApprovalRequiredEvent extends EventBase {
  readonly type: 'approval_required';
  /** UI 가 `decide(approvalId, …, 'human-ui')` 로 넘길 값 */
  readonly approvalId: string;
  readonly callId: string;
  readonly tool: string;
  /** 도구 줄용 요약(가림 · 500자) — 승인 화면에는 argsFull 을 보인다 */
  readonly argsSummary: string;
  /**
   * 실행될 인자 전문 — 자르지 않고 가리지 않은 canonical JSON(키 정렬 · 최대 256KB). 🔴 사람은 이 글에 승인한다(RA 검수 4 차단 2).
   * 256KB 를 넘는 인자는 승인을 열지 않고 tool_denied args_too_large 로 닫는다.
   */
  readonly argsFull: string;
  /** 비밀처럼 보이는 키 경로(`password` · `nested.apiKey` · `items[0].token`). 비어 있지 않으면 R6 은 승인 화면에 경고를 띄운다(값은 argsFull 에 그대로 있다) */
  readonly maskedKeys: readonly string[];
  /** Guard 가 맞춘 규칙 · 없으면 null */
  readonly matchedPattern: string | null;
  readonly reason: ApprovalReason;
  /**
   * argsFull 안 보이지 않는 글자(RTL override U+202E · zero-width 등) 수 — 있을 때만(1 이상). R6 승인 화면은 이때 경고를 띄우고
   * `revealHiddenChars(argsFull).text`(agent-runner.ts)로 그 글자를 `\u{…}` 로 보이게 그린다(검수 5 권고 5 · E8).
   */
  readonly argsHiddenChars?: number;
  /** 이 때(ms · epoch)가 지나면 'timeout' — 관문이 알려 줄 때만 */
  readonly expiresAt?: number;
}

export interface AgentApprovalDecidedEvent extends EventBase {
  readonly type: 'approval_decided';
  readonly approvalId: string;
  readonly callId: string;
  readonly decision: ApprovalOutcome;
}

export interface AgentToolResultEvent extends EventBase {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly tool: string;
  readonly ok: boolean;
  /** 모델에게 붙인 글(글 상한으로 자른 것) */
  readonly summary: string;
  /** 도구가 잘랐거나 runner 가 글 상한으로 잘랐으면 true */
  readonly truncated: boolean;
}

export interface AgentErrorEvent extends EventBase {
  readonly type: 'error';
  readonly source: AgentErrorSource;
  readonly message: string;
  /** 도구 호출 하나의 오류면 그 callId */
  readonly callId?: string;
}

export interface AgentDoneEvent extends EventBase {
  readonly type: 'done';
  readonly reason: AgentDoneReason;
  /** 이 run 의 모델 usage 합(usage 를 안 주는 공급자는 0 으로 남는다) */
  readonly usage: ChatUsage;
  /** 끝났을 때의 대화 전체(입력 메시지 + assistant · tool · 오류 글) — R6 가 `cmh_ai_conversation_message` 로 저장할 몫 */
  readonly messages: ChatMessage[];
}

export type AgentEvent =
  | AgentDeltaEvent
  | AgentReasoningEvent
  | AgentToolCallEvent
  | AgentToolDeniedEvent
  | AgentApprovalRequiredEvent
  | AgentApprovalDecidedEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentDoneEvent;

export type AgentEventType = AgentEvent['type'];
