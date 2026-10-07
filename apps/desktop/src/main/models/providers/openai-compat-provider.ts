// R4 — OpenAI 호환 공급자(OpenAI · OpenRouter 직접 · 그 밖 OpenAI 호환 서버). `POST {baseUrl}/v1/chat/completions` · `stream: true` · SSE.
// OpenRouter 는 baseUrl `https://openrouter.ai/api` 로 같은 꼴(사장님 규칙상 이 세션에서 실제 호출 0 — 시험은 로컬 가짜 서버만).
// 🔴 API 키는 로그 · 예외 · error 조각 어디에도 나가지 않는다: 키는 JS private 필드(#apiKey · JSON/console 에 안 보임) · 서버가 돌려준 글은 redactSecret 로 가린다.
// SSE: `data: {json}` 줄 · 빈 줄로 한 사건 끝 · `:` 로 시작하는 줄은 주석(OpenRouter 의 «PROCESSING» 등) · `data: [DONE]` 이 끝 · 빈 data 는 건너뜀 ·
//   줄 끝은 CRLF · LF · CR 모두 · 조각 사이 상한(idleTimeoutMs) · 사건 · 도구 인자 바이트 상한(각 1MB).
// url · extraHeaders 도 private 필드(#) — 쿼리 키(Azure `?api-key=`)나 덧 헤더가 JSON/inspect · 오류 글에 나가지 않게(오류 글은 origin 만).
import { errorText, FINISH_ABORTED, type ChatChunk, type ChatRequest, type ChatUsage, type ModelProvider } from '../model-provider.js';
import { completionToChunks, parseOpenAiUsage } from './openai-response.js';

/** 생각 세기를 어떤 요청 칸으로 보내나 — 서버마다 다르고 모르는 칸을 거절하는 서버도 있어 기본은 안 보냄 */
export type ReasoningParamStyle = 'none' | 'openai' | 'openrouter';

export interface OpenAiCompatProviderOptions {
  id: string;
  /** 예 `https://api.openai.com` · `https://openrouter.ai/api` · `http://127.0.0.1:8080` — 경로 뒤에 `/v1/chat/completions` 를 붙인다(쿼리는 그 뒤에 남긴다) */
  baseUrl: string;
  /** 복호화한 키(레지스트리가 decryptSecret 로 푼 값) — 없으면 Authorization 을 안 보낸다 */
  apiKey?: string | null;
  /** 요청을 보낸 뒤 첫 바이트(헤더 + 본문 첫 조각)까지 기다리는 상한(ms) — 없으면 상한 없음 */
  firstByteTimeoutMs?: number;
  /** 첫 바이트 뒤 조각과 조각 사이 상한(ms) · 기본 60000 — 서버가 멈추면 signal 없이도 끝난다 */
  idleTimeoutMs?: number;
  reasoningParam?: ReasoningParamStyle;
  /** `stream_options.include_usage` 를 보낼지(기본 true) — 모르는 칸을 거절하는 서버면 false */
  streamUsage?: boolean;
  /** OpenRouter `HTTP-Referer` · `X-Title` 같은 덧 헤더 — private 필드에 두고 값(8자 이상)은 오류 글에서 가린다 */
  extraHeaders?: Record<string, string>;
  /** 시험용 — 기본은 Node 내장 fetch */
  fetch?: typeof fetch;
}

/** 오류 글에 나가는 서버 본문 길이 상한 */
const ERROR_BODY_MAX = 300;
/** 조각 사이 기본 상한(ms) */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** 아직 끝나지 않은 SSE 사건(줄 buffer + data 줄) 바이트 상한 — 줄 없이 끝없이 오는 본문 막기 */
export const SSE_EVENT_MAX_BYTES = 1024 * 1024;
/** 도구 호출 하나의 arguments 바이트 상한 */
export const TOOL_ARGS_MAX_BYTES = 1024 * 1024;
/** 이보다 짧은 값은 가리지 않는다(흔한 낱말까지 *** 로 바뀌지 않게) */
const REDACT_MIN_LENGTH = 8;

/** 글 안의 키를 가린다 — 키 전체 · 키 앞/뒤 8자(서버가 «sk-abcd…wxyz» 처럼 일부만 되돌려 주는 경우) */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret) return text;
  let out = text.split(secret).join('***');
  if (secret.length >= 16) {
    out = out.split(secret.slice(0, 8)).join('***').split(secret.slice(-8)).join('***');
  }
  return out;
}

/** baseUrl → 요청 주소 · origin. 쿼리(`?api-key=…` 같은 Azure 꼴)는 경로 뒤에 남기고 #조각은 버린다 */
function buildChatUrl(baseUrl: string): { url: string; origin: string; queryValues: string[] } {
  try {
    const u = new URL(baseUrl);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
    u.hash = '';
    return { url: u.toString(), origin: u.origin, queryValues: [...u.searchParams.values()] };
  } catch {
    // 주소가 아니면 fetch 가 실패한다 — 오류 글에는 원문 대신 이 표시만
    return { url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, origin: '(잘못된 주소)', queryValues: [] };
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  /** arguments 누적 바이트(상한 검사용) — 없으면 0 */
  argsBytes?: number;
}

export interface StreamState {
  finishReason: string | null;
  usage: ChatUsage | null;
  tools: Map<number, PendingToolCall>;
  /** index 없이 오는 tool_calls 가 이어 붙을 칸(마지막으로 쓴 index) */
  lastToolIndex?: number;
}

export class OpenAiCompatProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'openai-compat' as const;
  // 비밀이 들 수 있는 것은 모두 JS private 필드 — JSON.stringify · util.inspect 에 안 보인다
  readonly #apiKey: string | null;
  readonly #url: string;
  readonly #origin: string;
  readonly #extraHeaders: Record<string, string>;
  /** 오류 글에서 가릴 값(키 · 덧 헤더 값 · 주소 쿼리 값) */
  readonly #secrets: string[];
  private readonly firstByteTimeoutMs: number | null;
  private readonly idleTimeoutMs: number;
  private readonly reasoningParam: ReasoningParamStyle;
  private readonly streamUsage: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatProviderOptions) {
    this.id = opts.id;
    this.#apiKey = opts.apiKey ?? null;
    const built = buildChatUrl(opts.baseUrl);
    this.#url = built.url;
    this.#origin = built.origin;
    this.#extraHeaders = { ...(opts.extraHeaders ?? {}) };
    this.#secrets = [...Object.values(this.#extraHeaders), ...built.queryValues].filter((v) => v.length >= REDACT_MIN_LENGTH);
    this.firstByteTimeoutMs = opts.firstByteTimeoutMs ?? null;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reasoningParam = opts.reasoningParam ?? 'none';
    this.streamUsage = opts.streamUsage ?? true;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** 오류 글 가리기 — 요청 주소 전체는 origin 으로 · 키 · 덧 헤더 값 · 쿼리 값은 *** */
  #redact(text: string): string {
    let out = text.split(this.#url).join(this.#origin);
    out = redactSecret(out, this.#apiKey);
    for (const v of this.#secrets) out = out.split(v).join('***');
    return out;
  }

  /** 서버에 보낼 본문(시험에서 꼴을 본다) */
  buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
    if (this.streamUsage) body['stream_options'] = { include_usage: true };
    if (req.tools && req.tools.length > 0) body['tools'] = req.tools;
    if (req.max_tokens !== undefined) body['max_tokens'] = req.max_tokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    // 【AI 임시 결정】 칸 이름은 기억에 기댄 것(OpenAI `reasoning_effort` · OpenRouter `reasoning.effort`/`enabled`) — 이 세션에서 두 문서를 확인 못 함
    if (req.reasoning !== undefined && this.reasoningParam === 'openai' && req.reasoning !== 'off') {
      body['reasoning_effort'] = req.reasoning;
    }
    if (req.reasoning !== undefined && this.reasoningParam === 'openrouter') {
      body['reasoning'] = req.reasoning === 'off' ? { enabled: false } : { effort: req.reasoning };
    }
    return body;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    const ctrl = new AbortController();
    const onOuterAbort = (): void => ctrl.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    let timedOut: 'first-byte' | 'idle' | null = null;
    let timer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const armTimer = (kind: 'first-byte' | 'idle', ms: number): void => {
      clearTimer();
      timer = setTimeout(() => {
        timedOut = kind;
        ctrl.abort();
      }, ms);
      timer.unref?.();
    };
    if (this.firstByteTimeoutMs !== null) armTimer('first-byte', this.firstByteTimeoutMs);
    /** 중단 · 시간초과 · 그 밖 오류를 한 조각으로(주소는 origin 만) */
    const failure = (e: unknown): ChatChunk => {
      if (timedOut === 'first-byte') return { type: 'error', message: `첫 바이트 시간초과(${this.firstByteTimeoutMs}ms): ${this.#origin}` };
      if (timedOut === 'idle') return { type: 'error', message: `조각 사이 시간초과(${this.idleTimeoutMs}ms): ${this.#origin}` };
      if (signal?.aborted) return { type: 'done', finishReason: FINISH_ABORTED };
      return { type: 'error', message: this.#redact(`요청 실패: ${errorText(e)}`) };
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.#url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...this.#extraHeaders,
            ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
          },
          body: JSON.stringify(this.buildBody(req)),
          signal: ctrl.signal,
        });
      } catch (e) {
        yield failure(e);
        return;
      }

      if (!res.ok) {
        clearTimer();
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '';
        }
        const snippet = this.#redact(text).slice(0, ERROR_BODY_MAX).trim();
        yield { type: 'error', message: `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}` };
        return;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // stream 을 무시하고 한 번에 답하는 서버 — 같은 꼴로 바꿔 낸다
        clearTimer();
        let data: unknown;
        try {
          data = await res.json();
        } catch (e) {
          yield failure(e);
          return;
        }
        yield* completionToChunks(data, 'OpenAI 호환');
        return;
      }

      if (!res.body) {
        clearTimer();
        yield { type: 'error', message: '응답 본문이 없습니다' };
        return;
      }
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const state: StreamState = { finishReason: null, usage: null, tools: new Map() };
      let buffer = '';
      let dataLines: string[] = [];
      let dataBytes = 0;
      let sawDone = false;

      /** 사건 하나(data 줄 모음)를 조각으로 — [DONE] 이면 true */
      const dispatch = (out: ChatChunk[]): boolean | 'error' => {
        if (dataLines.length === 0) return false;
        const payload = dataLines.join('\n');
        dataLines = [];
        dataBytes = 0;
        // 빈 data(keep-alive 로 `data:` 만 보내는 서버)는 건너뛴다
        if (payload.trim() === '') return false;
        if (payload.trim() === '[DONE]') return true;
        let json: unknown;
        try {
          json = JSON.parse(payload);
        } catch {
          out.push({ type: 'error', message: `SSE 조각이 JSON 이 아닙니다: ${this.#redact(payload.slice(0, 2_000)).slice(0, 120)}` });
          return 'error';
        }
        const err = (json as { error?: { message?: unknown } | string }).error;
        if (err !== undefined && err !== null) {
          const msg = typeof err === 'string' ? err : typeof err.message === 'string' ? err.message : JSON.stringify(err);
          out.push({ type: 'error', message: this.#redact(`스트림 오류: ${msg}`).slice(0, ERROR_BODY_MAX) });
          return 'error';
        }
        const before = out.length;
        applyStreamEvent(json, state, out);
        return out.slice(before).some((c) => c.type === 'error') ? 'error' : false;
      };
      /** 줄 하나 — 빈 줄이면 사건 끝 */
      const takeLine = (line: string, out: ChatChunk[]): boolean | 'error' => {
        if (line === '') return dispatch(out);
        if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '');
          dataLines.push(data);
          dataBytes += Buffer.byteLength(data, 'utf8') + 1;
        }
        // `:` 주석 · event: · id: · retry: 줄은 쓰지 않는다
        return false;
      };

      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          yield failure(e);
          return;
        }
        clearTimer();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // 줄 끝은 CRLF · LF · CR(SSE 규격) — 조각 끝의 외톨이 CR 은 다음 조각의 LF 와 이어질 수 있어 남긴다
        let tail = '';
        if (buffer.endsWith('\r')) {
          tail = '\r';
          buffer = buffer.slice(0, -1);
        }
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = (lines.pop() ?? '') + tail;
        const out: ChatChunk[] = [];
        let stop: boolean | 'error' = false;
        for (const line of lines) {
          stop = takeLine(line, out);
          if (stop) break;
        }
        if (!stop && dataBytes + Buffer.byteLength(buffer, 'utf8') > SSE_EVENT_MAX_BYTES) {
          out.push({ type: 'error', message: `SSE 사건이 너무 큽니다(${SSE_EVENT_MAX_BYTES} 바이트 초과)` });
          stop = 'error';
        }
        yield* out;
        if (stop === 'error') return;
        if (stop === true) {
          sawDone = true;
          break;
        }
        // 첫 바이트 뒤로는 조각 사이 상한
        armTimer('idle', this.idleTimeoutMs);
      }
      if (!sawDone) {
        // 끝에 빈 줄 없이 끊긴 마지막 사건(남은 줄을 마저 읽고 사건을 닫는다)
        buffer += decoder.decode();
        const out: ChatChunk[] = [];
        let stop: boolean | 'error' = false;
        for (const line of [...buffer.split(/\r\n|\r|\n/), '']) {
          stop = takeLine(line, out);
          if (stop) break;
        }
        yield* out;
        if (stop === 'error') return;
        sawDone = stop === true;
      }
      if (!sawDone) {
        yield { type: 'error', message: '스트림이 [DONE] 없이 끊겼습니다' };
        return;
      }
      yield* flushToolCalls(state);
      yield { type: 'done', ...(state.usage ? { usage: state.usage } : {}), finishReason: state.finishReason ?? 'stop' };
    } finally {
      clearTimer();
      signal?.removeEventListener('abort', onOuterAbort);
      if (reader) {
        // 부르는 쪽이 중간에 그만 읽었으면 연결을 닫는다
        reader.cancel().catch(() => undefined);
      }
      ctrl.abort();
    }
  }
}

/** SSE 사건 하나(OpenAI chat.completion.chunk) → delta · reasoning 조각 / 도구 호출 · 끝 이유 · usage 는 state 에 모은다 */
export function applyStreamEvent(json: unknown, state: StreamState, out: ChatChunk[]): void {
  const ev = json as {
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
        tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
      };
      finish_reason?: unknown;
    }>;
    usage?: unknown;
  };
  const choice = ev.choices?.[0];
  const d = choice?.delta;
  if (d) {
    // 생각 글 칸 이름이 서버마다 다르다(DeepSeek·vLLM `reasoning_content` · OpenRouter `reasoning`)
    const r = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
    if (r) out.push({ type: 'reasoning', text: r });
    if (typeof d.content === 'string' && d.content) out.push({ type: 'delta', text: d.content });
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const id = typeof tc.id === 'string' && tc.id ? tc.id : null;
        let index: number;
        if (typeof tc.index === 'number') {
          index = tc.index;
        } else {
          // index 없이 보내는 서버 — 지금 칸에 이어 붙이되, 다른 id 가 오면 새 칸
          const last = state.lastToolIndex;
          const lastCall = last === undefined ? undefined : state.tools.get(last);
          if (last === undefined || !lastCall) index = state.tools.size === 0 ? 0 : Math.max(...state.tools.keys()) + 1;
          else if (id !== null && lastCall.id !== '' && lastCall.id !== id) index = Math.max(...state.tools.keys()) + 1;
          else index = last;
        }
        state.lastToolIndex = index;
        const cur = state.tools.get(index) ?? { id: '', name: '', args: '', argsBytes: 0 };
        if (id !== null) cur.id = id;
        // name 은 비어 있을 때만(조각마다 name 을 다시 보내는 서버에서 «foofoo» 가 되지 않게)
        if (typeof tc.function?.name === 'string' && tc.function.name && !cur.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          cur.argsBytes = (cur.argsBytes ?? 0) + Buffer.byteLength(tc.function.arguments, 'utf8');
          if (cur.argsBytes > TOOL_ARGS_MAX_BYTES) {
            out.push({ type: 'error', message: `도구 호출 인자가 너무 큽니다(${TOOL_ARGS_MAX_BYTES} 바이트 초과)` });
            return;
          }
          cur.args += tc.function.arguments;
        }
        state.tools.set(index, cur);
      }
    }
  }
  if (typeof choice?.finish_reason === 'string') state.finishReason = choice.finish_reason;
  const usage = parseOpenAiUsage(ev.usage);
  if (usage) state.usage = usage;
}

function* flushToolCalls(state: StreamState): Iterable<ChatChunk> {
  const indexes = [...state.tools.keys()].sort((a, b) => a - b);
  for (const i of indexes) {
    const t = state.tools.get(i);
    if (t) yield { type: 'tool_call', id: t.id, name: t.name, argumentsJson: t.args };
  }
}
