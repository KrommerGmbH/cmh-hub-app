// R4 — ONNX 텍스트 공급자. 엔진은 주입받는다(OnnxEngine) — 이 파일은 «적재 · 조각 스트림 · 내리기» 만 맡는다.
// 실제 엔진(`@huggingface/transformers` 4.3.1 · onnxruntime-node — research/02 §3)은 **아직 의존에 없다** → 연결부는 다음 차례(의존 추가 필요 · 사장님 확인).
// 그 전까지 시험은 가짜 엔진으로만. R0 bench(scripts/bench-local-models.mjs)가 사장님 PC 에서 같은 엔진을 먼저 잰다.
// 도구 호출은 아직 없다(transformers.js 채팅 템플릿의 tools 연결 확인 못 함) → tools 가 오면 error 조각.
import { errorText, FINISH_ABORTED, type ChatChunk, type ChatRequest, type ModelProvider, type ReasoningLevel } from '../model-provider.js';

export type OnnxDtype = 'q4' | 'q4f16' | 'int8' | 'fp16' | 'fp32';
export type OnnxDevice = 'cpu' | 'dml';

export interface OnnxMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OnnxGenerateResult {
  text: string;
  reasoningText?: string;
  promptTokens: number;
  completionTokens: number;
}

export interface OnnxEngine {
  load(modelDir: string, opts: { dtype: OnnxDtype; device: OnnxDevice }): Promise<void>;
  /**
   * onToken 은 토큰(글 조각)마다 — channel 을 모르면 'answer'.
   * reasoning `off` 면 엔진이 채팅 템플릿에 생각 끄기를 넘긴다(Qwen3 계열 `enable_thinking: false` · 모델마다 다름).
   */
  generate(
    messages: OnnxMessage[],
    opts: {
      maxNewTokens: number;
      onToken?: (text: string, channel?: 'answer' | 'reasoning') => void;
      temperature?: number;
      reasoning?: ReasoningLevel;
      signal?: AbortSignal;
    },
  ): Promise<OnnxGenerateResult>;
  unload(): Promise<void>;
}

export interface OnnxTextProviderOptions {
  id: string;
  engine: OnnxEngine;
  /** `cmh_ai_model.code` → 모델 폴더(`userData/models/<org>/<name>/`) */
  modelDir: (modelCode: string) => string;
  dtype: OnnxDtype;
  device: OnnxDevice;
  /** max_tokens 가 없을 때 · 【AI 임시 결정】 512(R4 §6 입력 예시 값) */
  defaultMaxNewTokens?: number;
}

export class OnnxTextProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'onnx' as const;
  private readonly opts: OnnxTextProviderOptions;
  /** 지금 적재한 모델 code — 엔진은 한 번에 한 모델 */
  private loadedCode: string | null = null;

  constructor(opts: OnnxTextProviderOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  get loadedModel(): string | null {
    return this.loadedCode;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    if (req.tools && req.tools.length > 0) {
      yield { type: 'error', message: 'ONNX 공급자는 아직 도구 호출(tools)을 지원하지 않습니다' };
      return;
    }
    const messages: OnnxMessage[] = [];
    for (const m of req.messages) {
      if (m.role === 'tool' || (m.tool_calls && m.tool_calls.length > 0)) {
        yield { type: 'error', message: 'ONNX 공급자는 아직 도구 호출 메시지(role tool · tool_calls)를 지원하지 않습니다' };
        return;
      }
      messages.push({ role: m.role, content: m.content ?? '' });
    }
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    try {
      await this.ensureLoaded(req.model);
    } catch (e) {
      yield { type: 'error', message: `ONNX 모델 적재 실패(${req.model}): ${errorText(e)}` };
      return;
    }

    // 엔진의 onToken(동기 콜백)을 조각 큐로 받아 그때그때 낸다
    const queue: ChatChunk[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let streamed = false;
    let result: OnnxGenerateResult | null = null;
    let failure: unknown = null;
    const push = (c: ChatChunk): void => {
      queue.push(c);
      wake?.();
    };
    const maxNewTokens = req.max_tokens ?? this.opts.defaultMaxNewTokens ?? 512;
    void this.opts.engine
      .generate(messages, {
        maxNewTokens,
        onToken: (text, channel) => {
          if (!text) return;
          streamed = true;
          push({ type: channel === 'reasoning' ? 'reasoning' : 'delta', text });
        },
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
        ...(signal ? { signal } : {}),
      })
      .then(
        (r) => {
          result = r;
        },
        (e: unknown) => {
          failure = e;
        },
      )
      .finally(() => {
        finished = true;
        wake?.();
      });

    for (;;) {
      while (queue.length > 0) {
        const c = queue.shift();
        if (c) yield c;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    const r = result as OnnxGenerateResult | null;
    if (failure !== null || r === null) {
      yield { type: 'error', message: `ONNX 생성 실패: ${errorText(failure)}` };
      return;
    }
    if (!streamed) {
      // onToken 을 안 부르는 엔진 — 다 만든 답을 한 번에
      if (r.reasoningText) yield { type: 'reasoning', text: r.reasoningText };
      if (r.text) yield { type: 'delta', text: r.text };
    }
    yield {
      type: 'done',
      usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens },
      finishReason: r.completionTokens >= maxNewTokens ? 'length' : 'stop',
    };
  }

  async unload(): Promise<void> {
    if (this.loadedCode === null) return;
    this.loadedCode = null;
    await this.opts.engine.unload();
  }

  private async ensureLoaded(code: string): Promise<void> {
    if (this.loadedCode === code) return;
    if (this.loadedCode !== null) await this.unload();
    await this.opts.engine.load(this.opts.modelDir(code), { dtype: this.opts.dtype, device: this.opts.device });
    this.loadedCode = code;
  }
}
