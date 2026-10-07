// R4 — 모델 공급자 한 꼴. 로컬(GGUF · ONNX · Laya) · OpenAI 호환(OpenAI · OpenRouter · 그 밖) · Anthropic · 서버 relay 가 모두 이 꼴로 답한다.
// 요청은 OpenAI chat 꼴(`model` = `cmh_ai_model.code`) · 답은 조각(ChatChunk) 스트림. 스트림이 없는 공급자는 delta + done 두 조각을 한 번에 낸다.
// 약속: chat() 은 예외를 던지지 않고 `error` 조각으로 끝낸다(부르는 쪽이 try 를 잊어도 조용히 실패하지 않게). 중단(AbortSignal)은 `done`(finishReason `aborted`).

export type ProviderKind = 'gguf' | 'onnx' | 'openai-compat' | 'anthropic' | 'server-relay' | 'laya';

/** 이 PC 의 RAM 을 쓰는 공급자 — `ModelRegistry` 가 RAM 예산 · 한 번에 하나 큐를 건다 */
export const LOCAL_PROVIDER_KINDS: readonly ProviderKind[] = ['gguf', 'onnx', 'laya'];

export function isLocalKind(kind: ProviderKind): boolean {
  return LOCAL_PROVIDER_KINDS.includes(kind);
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** assistant 메시지가 낸 도구 호출(OpenAI 꼴) */
export interface ChatToolCallRef {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  /** assistant 가 도구만 부른 차례면 null 일 수 있다(OpenAI 꼴) */
  content: string | null;
  tool_calls?: ChatToolCallRef[];
  /** role `tool` 일 때 어느 호출의 결과인가 */
  tool_call_id?: string;
}

/** OpenAI function 도구 정의 */
export interface ChatToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface ChatRequest {
  /** `cmh_ai_model.code` */
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  /** 생각(reasoning) 세기 — 공급자가 못 바꾸면 무시하고 그 사실을 공급자 주석에 적는다 */
  reasoning?: ReasoningLevel;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}

/** 중단(AbortSignal)으로 끝났을 때의 finishReason */
export const FINISH_ABORTED = 'aborted';

export type ChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; argumentsJson: string }
  /** finishReason 은 공급자가 준 값 그대로(`stop` · `length` · `tool_calls` …) · 중단이면 `aborted` */
  | { type: 'done'; usage?: ChatUsage; finishReason: string }
  | { type: 'error'; message: string };

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  /** 로컬 공급자만 — 적재한 모델을 RAM 에서 내린다(다음 chat 때 다시 적재) */
  unload?(): Promise<void>;
}

export interface CollectedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface CollectedChat {
  text: string;
  reasoning: string;
  toolCalls: CollectedToolCall[];
  usage: ChatUsage | null;
  /** done 조각이 없으면 null */
  finishReason: string | null;
  /** error 조각의 글 — 없으면 null(던지지 않는다 · 부르는 쪽이 본다) */
  error: string | null;
}

/** 조각 스트림을 한 답으로 모은다(작업 큐 · 시험 · 스트림이 필요 없는 곳) */
export async function collectChat(iter: AsyncIterable<ChatChunk>): Promise<CollectedChat> {
  const out: CollectedChat = { text: '', reasoning: '', toolCalls: [], usage: null, finishReason: null, error: null };
  for await (const c of iter) {
    switch (c.type) {
      case 'delta':
        out.text += c.text;
        break;
      case 'reasoning':
        out.reasoning += c.text;
        break;
      case 'tool_call':
        out.toolCalls.push({ id: c.id, name: c.name, argumentsJson: c.argumentsJson });
        break;
      case 'done':
        out.finishReason = c.finishReason;
        out.usage = c.usage ?? null;
        break;
      case 'error':
        out.error = out.error === null ? c.message : `${out.error}\n${c.message}`;
        break;
    }
  }
  return out;
}

/** 예외를 한 줄 글로(Error 가 아니어도) */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
