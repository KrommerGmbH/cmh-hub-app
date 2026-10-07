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
