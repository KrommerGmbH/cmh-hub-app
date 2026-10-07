import { describe, expect, it, vi } from 'vitest';
import { collectChat, type ChatChunk, type ChatRequest, type ModelProvider, type ProviderKind } from './model-provider.js';
import { ModelRegistry, type ModelRow, type ProviderFactoryInput, type ProviderRow } from './model-registry.js';

/** 가짜 공급자 — 부른 차례(log)를 남기고 gate 가 풀릴 때까지 답을 붙든다 */
function fakeProvider(id: string, kind: ProviderKind, log: string[], gate?: Promise<void>): ModelProvider & { unloads: number } {
  const p = {
    id,
    kind,
    unloads: 0,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      log.push(`start:${req.model}`);
      if (gate) await gate;
      yield { type: 'delta', text: `${req.model}-답` };
      log.push(`end:${req.model}`);
      yield { type: 'done', finishReason: 'stop' };
    },
    async unload(): Promise<void> {
      p.unloads += 1;
      log.push(`unload:${id}`);
    },
  };
  return p;
}

const providers: ProviderRow[] = [
  { id: 'p-local', code: 'local-onnx', name: '로컬', kind: 'onnx' },
  { id: 'p-gguf', code: 'local-gguf', name: 'GGUF', kind: 'gguf' },
  { id: 'p-or', code: 'openrouter', name: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api', apiKeyEnc: 'BLOB-1' },
  { id: 'p-off', code: 'off', name: '꺼짐', kind: 'openai-compat', active: false },
];
const models: ModelRow[] = [
  { providerId: 'p-local', code: 'qwen-0.8b', estimatedRamMB: 1000 },
  { providerId: 'p-local', code: 'qwen-2b', estimatedRamMB: 2000 },
  { providerId: 'p-gguf', code: 'gemma-e2b', estimatedRamMB: 3500 },
  { providerId: 'p-local', code: 'giant', estimatedRamMB: 99_000 },
  { providerId: 'p-local', code: 'no-ram' },
  { providerId: 'p-or', code: 'gpt-x' },
  { providerId: 'p-or', code: 'gpt-y' },
  { providerId: 'p-or', code: 'gpt-off', active: false },
  { providerId: 'p-off', code: 'on-off-provider' },
  { providerId: 'p-missing', code: 'orphan' },
];

function setup(budget = 4000) {
  const log: string[] = [];
  const made: Record<string, ModelProvider & { unloads: number }> = {};
  const inputs: ProviderFactoryInput[] = [];
  const decryptSecret = vi.fn(async (blob: string) => `plain-of-${blob}`);
  const local = (input: ProviderFactoryInput) => {
    inputs.push(input);
    const p = fakeProvider(input.model.code, input.provider.kind, log);
    made[input.model.code] = p;
    return p;
  };
  const onUnload = vi.fn();
  const reg = new ModelRegistry({
    providers,
    models,
    factories: {
      onnx: local,
      gguf: local,
      'openai-compat': (input) => {
        inputs.push(input);
        return fakeProvider(input.provider.code, 'openai-compat', log);
      },
    },
    decryptSecret,
    ramBudgetMB: budget,
    onUnload,
  });
  return { reg, log, made, inputs, decryptSecret, onUnload };
}

describe('ModelRegistry.resolve', () => {
  it('모델 code → 공급자 + 모델 행 · 원격 공급자는 공급자 행마다 하나', async () => {
    const { reg, inputs } = setup();
    const a = await reg.resolve('gpt-x');
    const b = await reg.resolve('gpt-y');
    expect(a.modelRow.code).toBe('gpt-x');
    expect(a.provider).toBe(b.provider);
    expect(inputs).toHaveLength(1);
    expect((await collectChat(a.provider.chat({ model: 'gpt-x', messages: [] }))).text).toBe('gpt-x-답');
  });

  it('모르는 모델 · 꺼진 모델 · 꺼진 공급자 · 공급자 행 없음 · 공장 없음 · RAM 값 없음 → 예외', async () => {
    const { reg } = setup();
    await expect(reg.resolve('nope')).rejects.toThrow('모르는 모델입니다: nope');
    await expect(reg.resolve('gpt-off')).rejects.toThrow(/꺼진 모델/);
    await expect(reg.resolve('on-off-provider')).rejects.toThrow(/꺼진 공급자/);
    await expect(reg.resolve('orphan')).rejects.toThrow(/공급자 행이 없습니다/);
    await expect(reg.resolve('no-ram')).rejects.toThrow(/estimatedRamMB/);
    const r2 = new ModelRegistry({ providers, models, factories: {}, decryptSecret: (b) => b, ramBudgetMB: 1 });
    await expect(r2.resolve('gpt-x')).rejects.toThrow(/공장 함수 없음/);
  });

  it('비밀 — apiKeyEnc 는 decryptSecret 로만 풀어 공장에 넘긴다(한 번) · 결과에 키가 없다', async () => {
    const { reg, inputs, decryptSecret } = setup();
    const [r1] = await Promise.all([reg.resolve('gpt-x'), reg.resolve('gpt-y')]);
    expect(decryptSecret).toHaveBeenCalledTimes(1);
    expect(decryptSecret).toHaveBeenCalledWith('BLOB-1');
    expect(inputs[0]?.apiKey).toBe('plain-of-BLOB-1');
    expect(JSON.stringify(r1)).not.toContain('plain-of-BLOB-1');
    // 로컬은 키를 받지 않는다
    await reg.resolve('qwen-0.8b');
    expect(inputs[1]?.apiKey).toBeNull();
  });

  it('복호화 실패는 남지 않는다(다시 resolve 하면 다시 시도)', async () => {
    const decryptSecret = vi.fn().mockRejectedValueOnce(new Error('safeStorage 못 씀')).mockResolvedValueOnce('k');
    const reg = new ModelRegistry({ providers, models, factories: { 'openai-compat': (i) => fakeProvider(i.provider.code, 'openai-compat', []) }, decryptSecret, ramBudgetMB: 1 });
    await expect(reg.resolve('gpt-x')).rejects.toThrow('safeStorage 못 씀');
    await expect(reg.resolve('gpt-x')).resolves.toBeTruthy();
    expect(decryptSecret).toHaveBeenCalledTimes(2);
  });
});

describe('ModelRegistry — RAM 예산 · LRU', () => {
  it('예산을 넘으면 가장 오래 안 쓴 로컬 모델을 unload', async () => {
    const { reg, made, log, onUnload } = setup(4000);
    const run = async (code: string) => collectChat((await reg.resolve(code)).provider.chat({ model: code, messages: [] }));
    await run('qwen-0.8b'); // 1000
    await run('qwen-2b'); // 3000
    await run('qwen-0.8b'); // 0.8b 를 최근으로
    expect(reg.loadedLocalModels().map((m) => m.code)).toEqual(['qwen-2b', 'qwen-0.8b']);
    await run('gemma-e2b'); // 3500 → 2b(가장 오래됨) 내리고 · 그래도 1000+3500 > 4000 → 0.8b 도 내림
    expect(made['qwen-2b']?.unloads).toBe(1);
    expect(made['qwen-0.8b']?.unloads).toBe(1);
    expect(log.filter((l) => l.startsWith('unload'))).toEqual(['unload:qwen-2b', 'unload:qwen-0.8b']);
    expect(onUnload.mock.calls).toEqual([
      ['qwen-2b', 'lru'],
      ['qwen-0.8b', 'lru'],
    ]);
    expect(reg.loadedLocalModels()).toEqual([{ code: 'gemma-e2b', ramMB: 3500 }]);
  });

  it('LRU 는 꼭 필요한 만큼만 내린다', async () => {
    const { reg, made } = setup(3600);
    const run = async (code: string) => collectChat((await reg.resolve(code)).provider.chat({ model: code, messages: [] }));
    await run('qwen-2b'); // 2000
    await run('qwen-0.8b'); // 3000
    await run('qwen-2b'); // 쓰기만 — 순서 0.8b, 2b
    await run('qwen-0.8b'); // 이미 올라 있음 → 내림 0
    expect(made['qwen-2b']?.unloads ?? 0).toBe(0);
    expect(made['qwen-0.8b']?.unloads ?? 0).toBe(0);
  });

  it('혼자서 예산을 넘는 모델은 error(아무것도 안 내림)', async () => {
    const { reg, made } = setup(4000);
    await collectChat((await reg.resolve('qwen-0.8b')).provider.chat({ model: 'qwen-0.8b', messages: [] }));
    const r = await collectChat((await reg.resolve('giant')).provider.chat({ model: 'giant', messages: [] }));
    expect(r.error).toMatch(/RAM 부족: giant/);
    expect(made['qwen-0.8b']?.unloads).toBe(0);
  });

  it('unload 실패 → error 조각', async () => {
    const { reg, made } = setup(2500);
    await collectChat((await reg.resolve('qwen-2b')).provider.chat({ model: 'qwen-2b', messages: [] }));
    const victim = made['qwen-2b'];
    if (victim) victim.unload = () => Promise.reject(new Error('busy'));
    const r = await collectChat((await reg.resolve('qwen-0.8b')).provider.chat({ model: 'qwen-0.8b', messages: [] }));
    expect(r.error).toMatch(/qwen-2b 를 내리다 실패했습니다: busy/);
  });

  it('원격 공급자는 RAM 예산 · 줄에 안 걸린다', async () => {
    const { reg } = setup(1);
    const r = await collectChat((await reg.resolve('gpt-x')).provider.chat({ model: 'gpt-x', messages: [] }));
    expect(r.error).toBeNull();
    expect(reg.loadedLocalModels()).toEqual([]);
  });
});

describe('ModelRegistry — 로컬 추론 한 번에 하나', () => {
  it('동시에 두 번 부르면 두 번째는 첫 번째가 끝난 뒤 시작', async () => {
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reg = new ModelRegistry({
      providers,
      models,
      factories: { onnx: (i) => fakeProvider(i.model.code, 'onnx', log, i.model.code === 'qwen-0.8b' ? gate : undefined) },
      decryptSecret: (b) => b,
      ramBudgetMB: 10_000,
    });
    const a = (await reg.resolve('qwen-0.8b')).provider;
    const b = (await reg.resolve('qwen-2b')).provider;
    const pa = collectChat(a.chat({ model: 'qwen-0.8b', messages: [] }));
    const pb = collectChat(b.chat({ model: 'qwen-2b', messages: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['start:qwen-0.8b']);
    open();
    await Promise.all([pa, pb]);
    expect(log).toEqual(['start:qwen-0.8b', 'end:qwen-0.8b', 'start:qwen-2b', 'end:qwen-2b']);
  });

  it('부르는 쪽이 중간에 break 해도 줄이 풀린다 · unloadAll', async () => {
    const { reg, made } = setup(10_000);
    const a = (await reg.resolve('qwen-0.8b')).provider;
    for await (const c of a.chat({ model: 'qwen-0.8b', messages: [] })) {
      if (c.type === 'delta') break;
    }
    const r = await collectChat((await reg.resolve('qwen-2b')).provider.chat({ model: 'qwen-2b', messages: [] }));
    expect(r.text).toBe('qwen-2b-답');
    await reg.unloadAll();
    expect(made['qwen-0.8b']?.unloads).toBe(1);
    expect(made['qwen-2b']?.unloads).toBe(1);
    expect(reg.loadedLocalModels()).toEqual([]);
  });
});

describe('ModelRegistry — 줄이 막히지 않는다(버린 이터레이터 · 대기 상한 · 강제 내리기)', () => {
  /** 조각 둘 사이에서 오래 쉬는 가짜 로컬 — signal 을 보면 바로 멈춘다 · 끝까지 갔는지 남긴다 */
  function slowLocal(code: string, log: string[]): ModelProvider & { unloads: number } {
    const p = {
      id: code,
      kind: 'gguf' as const,
      unloads: 0,
      async *chat(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
        log.push(`start:${code}`);
        try {
          yield { type: 'delta', text: 'a' };
          yield { type: 'delta', text: 'b' };
          yield { type: 'done', finishReason: 'stop' };
        } finally {
          log.push(`finally:${code}:${signal?.aborted ? 'aborted' : 'ok'}`);
        }
      },
      async unload(): Promise<void> {
        p.unloads += 1;
      },
    };
    return p;
  }
  const rows = {
    providers: [{ id: 'g', code: 'g', name: 'g', kind: 'gguf' as const }],
    models: [
      { providerId: 'g', code: 'm1', estimatedRamMB: 100 },
      { providerId: 'g', code: 'm2', estimatedRamMB: 100, outputTokenLimit: 77 },
    ],
  };
  function make(extra: Partial<ConstructorParameters<typeof ModelRegistry>[0]> = {}) {
    const log: string[] = [];
    const made: Record<string, ModelProvider & { unloads: number }> = {};
    const reg = new ModelRegistry({
      ...rows,
      factories: { gguf: ({ model }) => (made[model.code] = slowLocal(model.code, log)) },
      decryptSecret: (b) => b,
      ramBudgetMB: 1_000,
      ...extra,
    });
    return { reg, log, made };
  }

  it('registry: 버린 이터레이터가 다음 로컬 chat·unloadAll 을 막지 않는다', async () => {
    const { reg, log, made } = make({ idleHoldTimeoutMs: 50, unloadWaitTimeoutMs: 100 });
    const it1 = (await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] })[Symbol.asyncIterator]();
    expect(await it1.next()).toEqual({ done: false, value: { type: 'delta', text: 'a' } });
    // it1 을 return() 없이 버린다 — 줄을 잡은 채 next() 가 안 온다
    const started = Date.now();
    const r2 = await collectChat((await reg.resolve('m2')).provider.chat({ model: 'm2', messages: [] }));
    expect(r2).toMatchObject({ text: 'ab', finishReason: 'stop', error: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    // 버린 쪽은 안쪽 스트림이 중단(signal)으로 닫혔고 · 다시 읽으면 done(aborted)
    expect(log).toEqual(['start:m1', 'finally:m1:aborted', 'start:m2', 'finally:m2:ok']);
    expect(await it1.next()).toEqual({ done: false, value: { type: 'done', finishReason: 'aborted' } });
    expect((await it1.next()).done).toBe(true);
    // 다시 버린다 — unloadAll 도 막히지 않는다
    const it3 = (await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] })[Symbol.asyncIterator]();
    await it3.next();
    await reg.unloadAll();
    expect(made['m1']?.unloads).toBe(1);
    expect(made['m2']?.unloads).toBe(1);
    expect(reg.loadedLocalModels()).toEqual([]);
  });

  it('unloadAll 은 줄을 오래 잡은 chat 을 unloadWaitTimeoutMs 뒤 끊고 강제로 내린다', async () => {
    // idle 상한은 길게 — 대신 unloadAll 쪽 상한이 먼저 온다
    const { reg, log, made } = make({ idleHoldTimeoutMs: 60_000, unloadWaitTimeoutMs: 50 });
    const it1 = (await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] })[Symbol.asyncIterator]();
    await it1.next();
    const started = Date.now();
    await reg.unloadAll();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(made['m1']?.unloads).toBe(1);
    expect(log).toContain('finally:m1:aborted');
    expect(await it1.next()).toEqual({ done: false, value: { type: 'done', finishReason: 'aborted' } });
  });

  it('줄 대기 상한을 넘으면 error 조각 · 기다리는 중 abort 면 바로 done(aborted)', async () => {
    const { reg } = make({ queueWaitTimeoutMs: 30, idleHoldTimeoutMs: 60_000 });
    const holder = (await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] })[Symbol.asyncIterator]();
    await holder.next();
    const timedOut = await collectChat((await reg.resolve('m2')).provider.chat({ model: 'm2', messages: [] }));
    expect(timedOut.error).toMatch(/^로컬 추론 대기 시간초과\(30ms\): m2/);
    const ctrl = new AbortController();
    const waiting = collectChat((await reg.resolve('m2')).provider.chat({ model: 'm2', messages: [] }, ctrl.signal));
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    expect(await waiting).toMatchObject({ finishReason: 'aborted', error: null });
    await holder.return?.();
    // 줄이 풀렸다
    expect((await collectChat((await reg.resolve('m2')).provider.chat({ model: 'm2', messages: [] }))).text).toBe('ab');
  });

  it('registry: 적재 실패면 loaded=false', async () => {
    const failing: ModelProvider = {
      id: 'bad',
      kind: 'gguf',
      async *chat(): AsyncIterable<ChatChunk> {
        yield { type: 'error', message: 'load failed' };
      },
      async unload(): Promise<void> {},
    };
    const reg = new ModelRegistry({ ...rows, factories: { gguf: () => failing }, decryptSecret: (b) => b, ramBudgetMB: 1_000 });
    const r = await collectChat((await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] }));
    expect(r.error).toBe('load failed');
    expect(reg.loadedLocalModels()).toEqual([]);
  });

  it('isLoaded 를 주는 공급자면 그 값을 따른다', async () => {
    let loaded = false;
    const p: ModelProvider = {
      id: 'x',
      kind: 'gguf',
      async *chat(): AsyncIterable<ChatChunk> {
        loaded = true;
        yield { type: 'error', message: '생성 실패(적재는 됨)' };
      },
      isLoaded: () => loaded,
    };
    const reg = new ModelRegistry({ ...rows, factories: { gguf: () => p }, decryptSecret: (b) => b, ramBudgetMB: 1_000 });
    await collectChat((await reg.resolve('m1')).provider.chat({ model: 'm1', messages: [] }));
    expect(reg.loadedLocalModels()).toEqual([{ code: 'm1', ramMB: 100 }]);
  });

  it('outputTokenLimit — 요청에 max_tokens 가 없으면 넣는다(로컬 · 원격)', async () => {
    const seen: Array<number | undefined> = [];
    const capture = (id: string, kind: ProviderKind): ModelProvider => ({
      id,
      kind,
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        seen.push(req.max_tokens);
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const reg = new ModelRegistry({
      providers: [...rows.providers, { id: 'r', code: 'r', name: 'r', kind: 'openai-compat' }],
      models: [...rows.models, { providerId: 'r', code: 'r1', outputTokenLimit: 55 }, { providerId: 'r', code: 'r2' }],
      factories: { gguf: () => capture('g', 'gguf'), 'openai-compat': () => capture('r', 'openai-compat') },
      decryptSecret: (b) => b,
      ramBudgetMB: 1_000,
    });
    const run = async (code: string, max?: number) =>
      collectChat((await reg.resolve(code)).provider.chat({ model: code, messages: [], ...(max !== undefined ? { max_tokens: max } : {}) }));
    await run('m2');
    await run('m2', 5);
    await run('m1');
    await run('r1');
    await run('r1', 9);
    await run('r2');
    expect(seen).toEqual([77, 5, undefined, 55, 9, undefined]);
  });
});
