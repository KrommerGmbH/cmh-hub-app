import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../worker/local-llm-engine.js';
import { collectChat, type ChatChunk } from '../model-provider.js';
import { GgufTextProvider, type GgufChatEngine } from './gguf-text-provider.js';
import { OnnxTextProvider, type OnnxEngine } from './onnx-text-provider.js';
import { ServerRelayProvider, type RelayTransport } from './server-relay-provider.js';
import { ModelRegistry } from '../model-registry.js';

async function all(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

function fakeGguf(answer = '베를린'): GgufChatEngine & { calls: ChatCompletionRequest[]; disposed: number } {
  const e = {
    calls: [] as ChatCompletionRequest[],
    disposed: 0,
    async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      e.calls.push(req);
      return {
        id: 'local-x',
        object: 'chat.completion',
        created: 0,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
    },
    async dispose(): Promise<void> {
      e.disposed += 1;
    },
  };
  return e;
}

describe('GgufTextProvider — LocalLlmEngine 감쌈', () => {
  it('delta + done 두 조각 · 요청을 엔진 꼴로(null content → 빈 글)', async () => {
    const engine = fakeGguf();
    const p = new GgufTextProvider({ id: 'g', engine });
    const chunks = await all(
      p.chat({ model: 'hf:a/b:Q4_K_M', messages: [{ role: 'system', content: 'S' }, { role: 'assistant', content: null }, { role: 'user', content: 'Q' }], max_tokens: 9, temperature: 0 }),
    );
    expect(chunks).toEqual([
      { type: 'delta', text: '베를린' },
      { type: 'done', usage: { promptTokens: 4, completionTokens: 2 }, finishReason: 'stop' },
    ]);
    expect(engine.calls[0]).toEqual({
      model: 'hf:a/b:Q4_K_M',
      messages: [{ role: 'system', content: 'S' }, { role: 'assistant', content: '' }, { role: 'user', content: 'Q' }],
      max_tokens: 9,
      temperature: 0,
    });
  });

  it('modelUri 로 code → hf: URI', async () => {
    const engine = fakeGguf();
    await all(new GgufTextProvider({ id: 'g', engine, modelUri: (c) => `hf:org/${c}:Q4` }).chat({ model: 'gemma', messages: [{ role: 'user', content: 'x' }] }));
    expect(engine.calls[0]?.model).toBe('hf:org/gemma:Q4');
  });

  it('tools · tool 메시지는 명시적 error(엔진을 부르지 않음)', async () => {
    const engine = fakeGguf();
    const p = new GgufTextProvider({ id: 'g', engine });
    const a = await all(p.chat({ model: 'hf:a', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't' } }] }));
    expect(a).toEqual([{ type: 'error', message: expect.stringMatching(/도구 호출/) }]);
    const b = await all(p.chat({ model: 'hf:a', messages: [{ role: 'tool', content: '{}', tool_call_id: 'c1' }, { role: 'user', content: 'x' }] }));
    expect(b[0]?.type).toBe('error');
    expect(engine.calls).toHaveLength(0);
  });

  it('엔진 예외(예: validateRequest) → error 조각 · unload → engine.dispose', async () => {
    const engine = fakeGguf();
    engine.chatCompletion = () => Promise.reject(new Error('model 은 hf: GGUF URI 여야 합니다'));
    const p = new GgufTextProvider({ id: 'g', engine });
    expect(await collectChat(p.chat({ model: 'x', messages: [{ role: 'user', content: 'q' }] }))).toMatchObject({ error: 'model 은 hf: GGUF URI 여야 합니다', finishReason: null });
    await p.unload();
    expect(engine.disposed).toBe(1);
  });

  it('기다리는 동안 abort 되면 답을 버리고 done(aborted)', async () => {
    const engine = fakeGguf();
    const ctrl = new AbortController();
    const orig = engine.chatCompletion.bind(engine);
    engine.chatCompletion = async (r) => {
      ctrl.abort();
      return orig(r);
    };
    const chunks = await all(new GgufTextProvider({ id: 'g', engine }).chat({ model: 'hf:a', messages: [{ role: 'user', content: 'q' }] }, ctrl.signal));
    expect(chunks).toEqual([{ type: 'done', finishReason: 'aborted' }]);
  });
});

function fakeOnnx(opts: { stream?: boolean } = {}): OnnxEngine & { loads: string[]; unloads: number } {
  const e = {
    loads: [] as string[],
    unloads: 0,
    async load(dir: string): Promise<void> {
      e.loads.push(dir);
    },
    async generate(_m: unknown, o: { maxNewTokens: number; onToken?: (t: string, ch?: 'answer' | 'reasoning') => void }) {
      if (opts.stream !== false) {
        for (const [t, ch] of [['생각', 'reasoning'], ['답', 'answer'], ['!', undefined]] as const) {
          await new Promise((r) => setTimeout(r, 1));
          o.onToken?.(t, ch);
        }
      }
      return { text: '답!', reasoningText: '생각', promptTokens: 5, completionTokens: 3 };
    },
    async unload(): Promise<void> {
      e.unloads += 1;
    },
  };
  return e;
}

describe('OnnxTextProvider — 주입 엔진', () => {
  const base = { id: 'o', modelDir: (c: string) => `/models/${c}`, dtype: 'q4' as const, device: 'cpu' as const };

  it('onToken 을 조각으로 흘린다(reasoning · delta) · 처음 한 번만 적재', async () => {
    const engine = fakeOnnx();
    const p = new OnnxTextProvider({ ...base, engine });
    const r1 = await all(p.chat({ model: 'qwen', messages: [{ role: 'user', content: 'q' }] }));
    expect(r1).toEqual([
      { type: 'reasoning', text: '생각' },
      { type: 'delta', text: '답' },
      { type: 'delta', text: '!' },
      { type: 'done', usage: { promptTokens: 5, completionTokens: 3 }, finishReason: 'stop' },
    ]);
    await all(p.chat({ model: 'qwen', messages: [{ role: 'user', content: 'q' }] }));
    expect(engine.loads).toEqual(['/models/qwen']);
    // 다른 모델이면 내리고 다시 적재
    await all(p.chat({ model: 'gemma', messages: [{ role: 'user', content: 'q' }] }));
    expect(engine.loads).toEqual(['/models/qwen', '/models/gemma']);
    expect(engine.unloads).toBe(1);
    expect(p.loadedModel).toBe('gemma');
  });

  it('onToken 을 안 부르는 엔진은 끝에 한 번에 · max_tokens 에 닿으면 length', async () => {
    const p = new OnnxTextProvider({ ...base, engine: fakeOnnx({ stream: false }) });
    const r = await collectChat(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 3 }));
    expect(r).toMatchObject({ text: '답!', reasoning: '생각', finishReason: 'length' });
  });

  it('적재 실패 · 생성 실패 · tools → error', async () => {
    const e1 = fakeOnnx();
    e1.load = () => Promise.reject(new Error('파일 없음'));
    expect((await collectChat(new OnnxTextProvider({ ...base, engine: e1 }).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }))).error).toMatch(/적재 실패\(m\): 파일 없음/);
    const e2 = fakeOnnx();
    e2.generate = () => Promise.reject(new Error('OOM'));
    expect((await collectChat(new OnnxTextProvider({ ...base, engine: e2 }).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }))).error).toMatch(/생성 실패: OOM/);
    const r3 = await collectChat(new OnnxTextProvider({ ...base, engine: fakeOnnx() }).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', function: { name: 't' } }] }));
    expect(r3.error).toMatch(/도구 호출/);
  });

  it('signal 을 엔진에 넘기고 중단되면 done(aborted)', async () => {
    const engine = fakeOnnx();
    const spy = vi.fn();
    const ctrl = new AbortController();
    engine.generate = async (_m, o) => {
      spy(o.signal?.aborted);
      ctrl.abort();
      spy(o.signal?.aborted); // 엔진은 안쪽 signal 을 받는다 — 바깥 중단이 그대로 전해진다
      return { text: '', promptTokens: 0, completionTokens: 0 };
    };
    const r = await all(new OnnxTextProvider({ ...base, engine }).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }, ctrl.signal));
    expect(spy.mock.calls).toEqual([[false], [true]]);
    expect(r).toEqual([{ type: 'done', finishReason: 'aborted' }]);
  });

  it('onnx: break(return) 하면 엔진 generate 를 멈추고 줄을 그 뒤에 푼다', async () => {
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const engine: OnnxEngine = {
      async load() {},
      async unload() {},
      async generate(_m, o) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push('generate:start');
        try {
          for (let i = 0; i < 50; i++) {
            if (o.signal?.aborted) {
              events.push(`generate:aborted@${i}`);
              break;
            }
            o.onToken?.(`t${i}`);
            await new Promise((r) => setTimeout(r, 10));
          }
          return { text: '', promptTokens: 1, completionTokens: 1 };
        } finally {
          // 멈춘 뒤에도 정리에 시간이 걸리는 엔진
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
          events.push('generate:end');
        }
      },
    };
    const reg = new ModelRegistry({
      providers: [{ id: 'o', code: 'o', name: 'o', kind: 'onnx' }],
      models: [{ providerId: 'o', code: 'q', estimatedRamMB: 10 }],
      factories: { onnx: () => new OnnxTextProvider({ ...base, engine }) },
      decryptSecret: (b) => b,
      ramBudgetMB: 100,
    });
    const { provider } = await reg.resolve('q');
    for await (const c of provider.chat({ model: 'q', messages: [{ role: 'user', content: 'q' }] })) {
      if (c.type === 'delta') break; // 부르는 쪽이 signal 없이 «그만»
    }
    // break 가 끝난 시점에 엔진은 이미 멈췄다(줄은 그 뒤에 풀렸다)
    expect(active).toBe(0);
    expect(events).toEqual(['generate:start', 'generate:aborted@1', 'generate:end']);
    const second = await collectChat(provider.chat({ model: 'q', messages: [{ role: 'user', content: 'q' }], max_tokens: 2 }));
    expect(second.error).toBeNull();
    expect(maxActive).toBe(1);
    expect(reg.loadedLocalModels()).toEqual([{ code: 'q', ramMB: 10 }]);
  });

  it('isLoaded — 적재 실패면 false · 성공하면 true', async () => {
    const e1 = fakeOnnx();
    e1.load = () => Promise.reject(new Error('파일 없음'));
    const p1 = new OnnxTextProvider({ ...base, engine: e1 });
    await all(p1.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(p1.isLoaded()).toBe(false);
    const p2 = new OnnxTextProvider({ ...base, engine: fakeOnnx() });
    await all(p2.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(p2.isLoaded()).toBe(true);
  });
});

describe('ServerRelayProvider — AppSession.call 꼴 transport', () => {
  const ok = (data: unknown): RelayTransport => async () => ({ status: 200, data, appError: null });

  it('경로 · stream:false 본문 · OpenAI 응답 → 조각', async () => {
    const calls: Array<[string, unknown]> = [];
    const transport: RelayTransport = async (path, body) => {
      calls.push([path, body]);
      return {
        status: 200,
        appError: null,
        data: {
          choices: [{ message: { content: '답', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
      };
    };
    const p = new ServerRelayProvider({ id: 's', transport, path: '/api/_action/relay-test' });
    const chunks = await all(p.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'q' }], max_tokens: 5 }));
    expect(calls).toEqual([['/api/_action/relay-test', { model: 'gpt-x', messages: [{ role: 'user', content: 'q' }], stream: false, max_tokens: 5 }]]);
    expect(chunks).toEqual([
      { type: 'delta', text: '답' },
      { type: 'tool_call', id: 'c1', name: 'f', argumentsJson: '{}' },
      { type: 'done', usage: { promptTokens: 3, completionTokens: 1 }, finishReason: 'tool_calls' },
    ]);
  });

  it('로그인 전(null) · HTTP 오류 · 꼴 틀림 · 예외 → error', async () => {
    const run = async (t: RelayTransport) => (await collectChat(new ServerRelayProvider({ id: 's', transport: t, path: '/p' }).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }))).error;
    expect(await run(async () => null)).toMatch(/로그인 전/);
    expect(await run(async () => ({ status: 403, data: { message: '권한 없음' }, appError: 'unknown-installation' }))).toBe('서버 relay HTTP 403 (unknown-installation): 권한 없음');
    expect(await run(ok({ nope: 1 }))).toMatch(/choices\[0\]\.message 가 없습니다/);
    expect(await run(() => Promise.reject(new Error('net down')))).toBe('서버 relay 실패: net down');
  });
});
