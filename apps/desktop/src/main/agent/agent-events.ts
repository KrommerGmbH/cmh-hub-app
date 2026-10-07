// RA — 에이전트 실행 루프가 내는 이벤트 꼴. electron 을 import 하지 않는 순수 모듈.
// R6 챗 pane 이 이 이벤트를 그대로 그린다: delta · reasoning 은 답 글, tool_call ~ tool_result 는 Aside 의 «접히는 도구 줄» 한 줄(callId 로 묶음),
// approval_required 는 승인 버튼(approvalId 로 `decide` IPC), done 은 끝 표시 + 대화 저장(messages).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» 1 · `#### [ ] RA.`
import type { ChatMessage, ChatUsage } from '../models/model-provider.js';
import type { ApprovalOutcome, ApprovalReason } from './approval-gate.js';

/** 끝난 까닭. max_time 은 시간 상한(limits.maxDurationMs) — 브리프의 다섯 + 시간 상한 하나 */
export type AgentDoneReason = 'final' | 'max_steps' | 'max_tokens' | 'max_time' | 'aborted' | 'error' | 'loop_detected';

/** 도구가 안 불린 까닭 — guard(정책 deny · 내장 규칙) · rejected(사람이 거절) · timeout(승인 시간 초과) */
export type ToolDeniedReason = 'guard' | 'rejected' | 'timeout';

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
  readonly callId: string;
  /** Guard 이름(`mcp:<서버>:<도구>` · `app:<이름>` · `browser:<이름>`). 모르는 도구면 모델이 준 이름 그대로 */
  readonly tool: string;
  /** 인자 JSON 요약(비밀 같은 키는 `***` · 글 상한) */
  readonly argsSummary: string;
}

export interface AgentToolDeniedEvent extends EventBase {
  readonly type: 'tool_denied';
  readonly callId: string;
  readonly tool: string;
  readonly reason: ToolDeniedReason;
  /** Guard 가 맞춘 규칙(reason 'guard' 일 때) · 없으면 null */
  readonly matchedPattern: string | null;
}

export interface AgentApprovalRequiredEvent extends EventBase {
  readonly type: 'approval_required';
  /** UI 가 `decide(approvalId, …, 'human-ui')` 로 넘길 값 */
  readonly approvalId: string;
  readonly callId: string;
  readonly tool: string;
  readonly argsSummary: string;
  readonly reason: ApprovalReason;
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
