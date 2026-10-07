// R4 — GGUF 공급자. 기존 W04 `LocalLlmEngine.chatCompletion()`(node-llama-cpp)을 **고치지 않고 감싼다**.
// 지금 엔진은 스트림이 없다(답을 다 만든 뒤 한 번에 돌려줌) → delta 한 조각 + done 한 조각.
// 도구 호출 · 생각 켜기도 없다(엔진이 `budgets.thoughtTokens: 0` 으로 고정 · local-llm-engine.ts 의 chatCompletion 주석).
// 검수 합의 «그대로 옮김 + 스트림·도구 확장»(엔진을 이 폴더로 옮기고 LlamaChatSession onTextChunk · functions 연결)은 다음 차례.
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../worker/local-llm-engine.js';
import { errorText, FINISH_ABORTED, type ChatChunk, type ChatRequest, type ModelProvider } from '../model-provider.js';

/** `LocalLlmEngine` 에서 이 공급자가 쓰는 부분만 — 시험은 가짜를 넣는다 */
export interface GgufChatEngine {
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /** 적재한 모델 · llama 를 내린다(LocalLlmEngine.dispose — 다음 호출 때 다시 올린다) */
  dispose(): Promise<void>;
}

export interface GgufTextProviderOptions {
  id: string;
  engine: GgufChatEngine;
  /**
   * `cmh_ai_model.code` → 엔진이 받는 GGUF URI(`hf:<org>/<repo>:<quant>`).
   * 기본은 그대로 — 지금 서버 작업 큐(W04)가 code 자리에 hf: URI 를 넣어 보낸다(task-worker.ts payload.model).
   */
  modelUri?: (modelCode: string) => string;
}

export class GgufTextProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'gguf' as const;
  private readonly engine: GgufChatEngine;
  private readonly modelUri: (modelCode: string) => string;

  constructor(opts: GgufTextProviderOptions) {
    this.id = opts.id;
    this.engine = opts.engine;
    this.modelUri = opts.modelUri ?? ((code) => code);
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    if (req.tools && req.tools.length > 0) {
      yield { type: 'error', message: 'GGUF 공급자는 아직 도구 호출(tools)을 지원하지 않습니다' };
      return;
    }
    const messages: ChatCompletionRequest['messages'] = [];
    for (const m of req.messages) {
      if (m.role === 'tool' || (m.tool_calls && m.tool_calls.length > 0)) {
        yield { type: 'error', message: 'GGUF 공급자는 아직 도구 호출 메시지(role tool · tool_calls)를 지원하지 않습니다' };
        return;
      }
      messages.push({ role: m.role, content: m.content ?? '' });
    }
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    let res: ChatCompletionResponse;
    try {
      // req.reasoning 은 무시한다 — 엔진이 생각을 늘 끈다(위 머리 주석)
      res = await this.engine.chatCompletion({
        model: this.modelUri(req.model),
        messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      });
    } catch (e) {
      yield { type: 'error', message: errorText(e) };
      return;
    }
    // 엔진은 중간에 멈출 수 없다 — 기다리는 동안 중단됐으면 답을 버린다
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    const choice = res.choices[0];
    if (choice?.message.content) yield { type: 'delta', text: choice.message.content };
    yield {
      type: 'done',
      usage: { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens },
      finishReason: choice?.finish_reason ?? 'stop',
    };
  }

  async unload(): Promise<void> {
    await this.engine.dispose();
  }
}
