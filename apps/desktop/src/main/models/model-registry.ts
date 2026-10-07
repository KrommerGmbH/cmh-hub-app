// R4 — 모델 레지스트리. `cmh_ai_provider` · `cmh_ai_model` 행(서버 CmhAiAgent 와 같은 칸 · 속성은 camelCase)을 받아 `resolve(code)` → 공급자.
// 코드에 모델 이름을 박지 않는다(원칙 7) — 공급자 구현은 kind 별 공장 함수로 주입받는다.
// 합의안 권고 «R4 RAM 예산 + LRU 내리기»: 로컬(gguf · onnx · laya)은 모델마다 공급자 하나 · 예산을 넘으면 가장 오래 안 쓴 로컬 모델을 unload().
// 한 번에 로컬 추론 1개(R4 §9) — 로컬 chat 은 줄을 선다(두 번째는 첫 번째 스트림이 끝나야 시작).
// 비밀: `apiKeyEnc`(safeStorage blob)는 주입받은 decryptSecret 로만 풀어 공장 함수에 넘기고, 레지스트리는 푼 값을 들고 있지도 내보내지도 않는다.
import { errorText, isLocalKind, type ChatChunk, type ChatRequest, type ModelProvider, type ProviderKind } from './model-provider.js';

/** `cmh_ai_provider` 행(research/05) — 앱이 쓰는 칸만 */
export interface ProviderRow {
  id: string;
  code: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  /** safeStorage 로 암호화한 키(평문 0) */
  apiKeyEnc?: string | null;
  active?: boolean;
  freeTier?: boolean;
  dailyLimit?: number | null;
  rpmLimit?: number | null;
}

/** `cmh_ai_model` 행(research/05) — 앱이 쓰는 칸만 */
export interface ModelRow {
  id?: string;
  providerId: string;
  code: string;
  label?: string | null;
  contextWindow?: number | null;
  active?: boolean;
  thinking?: boolean;
  toolCalling?: boolean;
  outputTokenLimit?: number | null;
  /**
   * 로컬 모델이 적재되면 쓰는 RAM(MB). **서버 테이블 칸이 아니다**(합의안 2 — 새 칸은 서버 PLAN 승인 뒤) —
   * 부르는 쪽이 파일 크기 · R0 실측으로 채운다. 로컬 kind 인데 없으면 resolve 가 거절한다.
   */
  estimatedRamMB?: number;
}

export interface ProviderFactoryInput {
  provider: ProviderRow;
  /** 로컬 kind 면 이 모델 하나를 위한 공급자 · 원격 kind 면 처음 resolve 한 모델(공급자 하나를 모든 모델이 같이 쓴다) */
  model: ModelRow;
  /** decryptSecret(apiKeyEnc) — 키가 없으면 null */
  apiKey: string | null;
}

export type ProviderFactory = (input: ProviderFactoryInput) => ModelProvider;

export interface ModelRegistryOptions {
  providers: ProviderRow[];
  models: ModelRow[];
  factories: Partial<Record<ProviderKind, ProviderFactory>>;
  /** safeStorage.decryptString 꼴 — 레지스트리 밖으로 결과를 내보내지 않는다 */
  decryptSecret: (blob: string) => string | Promise<string>;
  /** 로컬 모델 RAM 예산(MB) */
  ramBudgetMB: number;
  /** LRU 로 내린 것을 알린다(로그 · 상태 줄) — 비밀값 없음 */
  onUnload?: (modelCode: string, reason: 'lru') => void;
}

export interface ResolvedModel {
  /** 레지스트리가 감싼 공급자 — 로컬이면 RAM 예산 · 줄서기를 거친다 */
  provider: ModelProvider;
  modelRow: ModelRow;
}

interface LocalSlot {
  inner: ModelProvider;
  ramMB: number;
  loaded: boolean;
  /** LRU — 클수록 최근(시계 대신 늘어나는 수 · 시험에서 결정적) */
  lastUsed: number;
}

export class ModelRegistry {
  private readonly providerById = new Map<string, ProviderRow>();
  private readonly modelByCode = new Map<string, ModelRow>();
  private readonly factories: Partial<Record<ProviderKind, ProviderFactory>>;
  private readonly decryptSecret: (blob: string) => string | Promise<string>;
  private readonly ramBudgetMB: number;
  private readonly onUnload: ((modelCode: string, reason: 'lru') => void) | undefined;
  /** 원격 공급자 — provider.id 별 하나(동시에 resolve 해도 복호화 · 생성은 한 번) */
  private readonly remote = new Map<string, Promise<ModelProvider>>();
  /** 로컬 공급자 — model.code 별 하나 */
  private readonly local = new Map<string, LocalSlot>();
  private useCounter = 0;
  /** 로컬 추론 줄 — 앞사람이 끝나면 풀리는 약속 */
  private localTail: Promise<void> = Promise.resolve();

  constructor(opts: ModelRegistryOptions) {
    for (const p of opts.providers) this.providerById.set(p.id, p);
    for (const m of opts.models) this.modelByCode.set(m.code, m);
    this.factories = opts.factories;
    this.decryptSecret = opts.decryptSecret;
    this.ramBudgetMB = opts.ramBudgetMB;
    this.onUnload = opts.onUnload;
  }

  async resolve(modelCode: string): Promise<ResolvedModel> {
    const modelRow = this.modelByCode.get(modelCode);
    if (!modelRow) throw new Error(`모르는 모델입니다: ${modelCode}`);
    if (modelRow.active === false) throw new Error(`꺼진 모델입니다: ${modelCode}`);
    const providerRow = this.providerById.get(modelRow.providerId);
    if (!providerRow) throw new Error(`모델 ${modelCode} 의 공급자 행이 없습니다(providerId ${modelRow.providerId})`);
    if (providerRow.active === false) throw new Error(`꺼진 공급자입니다: ${providerRow.code}`);
    const factory = this.factories[providerRow.kind];
    if (!factory) throw new Error(`공급자 종류 ${providerRow.kind} 를 만들 수 없습니다(공장 함수 없음)`);

    if (isLocalKind(providerRow.kind)) {
      let slot = this.local.get(modelCode);
      if (!slot) {
        const ramMB = modelRow.estimatedRamMB;
        if (ramMB === undefined || !(ramMB > 0)) throw new Error(`로컬 모델 ${modelCode} 의 estimatedRamMB 가 없습니다`);
        slot = { inner: factory({ provider: providerRow, model: modelRow, apiKey: null }), ramMB, loaded: false, lastUsed: 0 };
        this.local.set(modelCode, slot);
      }
      return { provider: this.wrapLocal(modelCode, slot), modelRow };
    }

    let remote = this.remote.get(providerRow.id);
    if (!remote) {
      const blob = providerRow.apiKeyEnc;
      remote = (async () => factory({ provider: providerRow, model: modelRow, apiKey: blob ? await this.decryptSecret(blob) : null }))();
      this.remote.set(providerRow.id, remote);
      // 복호화 실패는 남겨 두지 않는다(키를 고친 뒤 다시 resolve 할 수 있게)
      remote.catch(() => this.remote.delete(providerRow.id));
    }
    return { provider: await remote, modelRow };
  }

  /** 지금 RAM 에 있다고 보는 로컬 모델(오래된 것부터) */
  loadedLocalModels(): Array<{ code: string; ramMB: number }> {
    return [...this.local.entries()]
      .filter(([, s]) => s.loaded)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .map(([code, s]) => ({ code, ramMB: s.ramMB }));
  }

  /** 앱 끝날 때 — 로컬 모델을 모두 내린다(줄이 비기를 기다린 뒤) */
  async unloadAll(): Promise<void> {
    await this.runExclusive(async () => {
      for (const s of this.local.values()) {
        if (s.loaded) {
          s.loaded = false;
          await s.inner.unload?.();
        }
      }
    });
  }

  private wrapLocal(modelCode: string, slot: LocalSlot): ModelProvider {
    return {
      id: slot.inner.id,
      kind: slot.inner.kind,
      // 줄은 첫 next() 때 선다 — 부르는 쪽은 끝까지 읽거나 for-await 를 break 해서(return) 줄을 풀어야 한다
      chat: (req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> => this.localChat(modelCode, slot, req, signal),
      unload: async () => {
        await this.runExclusive(async () => {
          if (!slot.loaded) return;
          slot.loaded = false;
          await slot.inner.unload?.();
        });
      },
    };
  }

  private async *localChat(modelCode: string, slot: LocalSlot, req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const release = await this.acquire();
    try {
      if (slot.ramMB > this.ramBudgetMB) {
        yield { type: 'error', message: `RAM 부족: ${modelCode} 는 ${slot.ramMB}MB 인데 예산이 ${this.ramBudgetMB}MB 입니다` };
        return;
      }
      if (!slot.loaded) {
        const failed = await this.makeRoom(modelCode, slot.ramMB);
        if (failed) {
          yield { type: 'error', message: failed };
          return;
        }
      }
      slot.loaded = true;
      slot.lastUsed = ++this.useCounter;
      yield* slot.inner.chat(req, signal);
    } finally {
      release();
    }
  }

  /** 예산 안에 들도록 오래된 로컬 모델부터 내린다 — 실패하면 오류 글 */
  private async makeRoom(exceptCode: string, needMB: number): Promise<string | null> {
    const used = (): number => [...this.local.values()].filter((s) => s.loaded).reduce((n, s) => n + s.ramMB, 0);
    while (used() + needMB > this.ramBudgetMB) {
      const victim = this.loadedLocalModels().find((m) => m.code !== exceptCode);
      if (!victim) return `RAM 부족: ${exceptCode}(${needMB}MB)를 올릴 자리가 없습니다(예산 ${this.ramBudgetMB}MB)`;
      const s = this.local.get(victim.code);
      if (!s) return `내부 오류: ${victim.code} 슬롯이 없습니다`;
      try {
        await s.inner.unload?.();
      } catch (e) {
        return `RAM 예산을 맞추려고 ${victim.code} 를 내리다 실패했습니다: ${errorText(e)}`;
      }
      s.loaded = false;
      this.onUnload?.(victim.code, 'lru');
    }
    return null;
  }

  /** 로컬 줄에 선다 — 돌려받은 함수를 부르면 다음 사람 차례 */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.localTail;
    this.localTail = before.then(() => mine);
    await before;
    return release;
  }

  private async runExclusive(fn: () => Promise<void>): Promise<void> {
    const release = await this.acquire();
    try {
      await fn();
    } finally {
      release();
    }
  }
}
