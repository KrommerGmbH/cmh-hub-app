// R4 — 모델 레지스트리. `cmh_ai_provider` · `cmh_ai_model` 행(서버 CmhAiAgent 와 같은 칸 · 속성은 camelCase)을 받아 `resolve(code)` → 공급자.
// 코드에 모델 이름을 박지 않는다(원칙 7) — 공급자 구현은 kind 별 공장 함수로 주입받는다.
// 합의안 권고 «R4 RAM 예산 + LRU 내리기»: 로컬(gguf · onnx · laya)은 모델마다 공급자 하나 · 예산을 넘으면 가장 오래 안 쓴 로컬 모델을 unload().
// 한 번에 로컬 추론 1개(R4 §9) — 로컬 chat 은 줄을 선다(두 번째는 첫 번째 스트림이 끝나야 시작).
//   줄이 영원히 막히지 않게(검수 3 차단 4): 줄 대기 상한(queueWaitTimeoutMs · 넘으면 error 조각) · signal 이면 바로 done(aborted) ·
//   줄을 잡은 이터레이터가 idleHoldTimeoutMs 동안 next() 를 안 부르면(버린 이터레이터) 안쪽 스트림을 끊고 줄을 강제로 푼다(그 이터레이터는 이후 done(aborted)) ·
//   unloadAll · unload 는 줄을 unloadWaitTimeoutMs 만 기다리고 넘으면 앞사람을 끊고 강제로 내린다.
//   줄을 풀기 전에 안쪽 스트림의 return() 이 끝나기를 기다린다(ONNX 는 그 안에서 generate 를 멈추고 끝날 때까지 기다린다).
// 비밀: `apiKeyEnc`(safeStorage blob)는 주입받은 decryptSecret 로만 풀어 공장 함수에 넘기고, 레지스트리는 푼 값을 들고 있지도 내보내지도 않는다.
import { errorText, FINISH_ABORTED, isLocalKind, type ChatChunk, type ChatRequest, type ModelProvider, type ProviderKind } from './model-provider.js';

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
  /** 로컬 줄 대기 상한(ms) · 기본 120000 — 넘으면 error 조각 «로컬 추론 대기 시간초과» */
  queueWaitTimeoutMs?: number;
  /** 줄을 잡은 이터레이터가 조각을 받고 이만큼(ms) next() 를 안 부르면 줄을 강제로 푼다 · 기본 30000 */
  idleHoldTimeoutMs?: number;
  /** unloadAll · unload 가 줄을 기다리는 상한(ms) · 넘으면 앞사람을 끊고 강제로 내린다 · 기본 10000 */
  unloadWaitTimeoutMs?: number;
}

const DEFAULT_QUEUE_WAIT_MS = 120_000;
const DEFAULT_IDLE_HOLD_MS = 30_000;
const DEFAULT_UNLOAD_WAIT_MS = 10_000;

/** 줄 한 자리 — release 는 여러 번 불러도 한 번만 */
interface LockTicket {
  release(): void;
  /** 줄을 강제로 뺏을 때 부른다(localChat 이 채운다) */
  revoke: (() => Promise<void>) | null;
}

/** 로컬 줄(FIFO · 한 번에 하나) — 기다리다 그만둔 사람은 줄에서 빠진다 */
class LocalLock {
  private held = false;
  private readonly waiters: Array<(ticket: LockTicket) => void> = [];
  /** 지금 줄을 잡은 자리 */
  current: LockTicket | null = null;

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<LockTicket | 'timeout' | 'aborted'> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.issue());
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
      };
      const grant = (ticket: LockTicket): void => {
        cleanup();
        resolve(ticket);
      };
      const drop = (why: 'timeout' | 'aborted'): void => {
        const i = this.waiters.indexOf(grant);
        if (i < 0) return; // 이미 차례를 받았다
        this.waiters.splice(i, 1);
        cleanup();
        resolve(why);
      };
      const onAbort = (): void => drop('aborted');
      this.waiters.push(grant);
      timer = setTimeout(() => drop('timeout'), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private issue(): LockTicket {
    let released = false;
    const ticket: LockTicket = {
      revoke: null,
      release: () => {
        if (released) return;
        released = true;
        if (this.current === ticket) this.current = null;
        const next = this.waiters.shift();
        if (next) next(this.issue());
        else this.held = false;
      },
    };
    this.current = ticket;
    return ticket;
  }
}

/** p 가 끝나거나 ms 가 지나면 끝(어느 쪽이든 던지지 않는다) */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** max_tokens 가 없으면 모델 행의 outputTokenLimit 을 넣는다 */
function withOutputLimit(req: ChatRequest, modelRow: ModelRow): ChatRequest {
  const limit = modelRow.outputTokenLimit;
  if (req.max_tokens !== undefined || typeof limit !== 'number' || !(limit > 0)) return req;
  return { ...req, max_tokens: limit };
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
  /** 로컬 추론 줄 */
  private readonly lock = new LocalLock();
  private readonly queueWaitTimeoutMs: number;
  private readonly idleHoldTimeoutMs: number;
  private readonly unloadWaitTimeoutMs: number;

  constructor(opts: ModelRegistryOptions) {
    for (const p of opts.providers) this.providerById.set(p.id, p);
    for (const m of opts.models) this.modelByCode.set(m.code, m);
    this.factories = opts.factories;
    this.decryptSecret = opts.decryptSecret;
    this.ramBudgetMB = opts.ramBudgetMB;
    this.onUnload = opts.onUnload;
    this.queueWaitTimeoutMs = opts.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_MS;
    this.idleHoldTimeoutMs = opts.idleHoldTimeoutMs ?? DEFAULT_IDLE_HOLD_MS;
    this.unloadWaitTimeoutMs = opts.unloadWaitTimeoutMs ?? DEFAULT_UNLOAD_WAIT_MS;
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
      return { provider: this.wrapLocal(modelCode, slot, modelRow), modelRow };
    }

    let remote = this.remote.get(providerRow.id);
    if (!remote) {
      const blob = providerRow.apiKeyEnc;
      remote = (async () => factory({ provider: providerRow, model: modelRow, apiKey: blob ? await this.decryptSecret(blob) : null }))();
      this.remote.set(providerRow.id, remote);
      // 복호화 실패는 남겨 두지 않는다(키를 고친 뒤 다시 resolve 할 수 있게)
      remote.catch(() => this.remote.delete(providerRow.id));
    }
    const shared = await remote;
    const limit = modelRow.outputTokenLimit;
    if (typeof limit !== 'number' || !(limit > 0)) return { provider: shared, modelRow };
    // 모델마다 출력 상한이 다르다 — 공급자는 같이 쓰고 요청만 고쳐 넘기는 얇은 감싸개
    const limited: ModelProvider = {
      id: shared.id,
      kind: shared.kind,
      chat: (req, signal) => shared.chat(withOutputLimit(req, modelRow), signal),
    };
    return { provider: limited, modelRow };
  }

  /** 지금 RAM 에 있다고 보는 로컬 모델(오래된 것부터) */
  loadedLocalModels(): Array<{ code: string; ramMB: number }> {
    return [...this.local.entries()]
      .filter(([, s]) => s.loaded)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .map(([code, s]) => ({ code, ramMB: s.ramMB }));
  }

  /** 앱 끝날 때 — 로컬 모델을 모두 내린다(줄을 unloadWaitTimeoutMs 만 기다리고 넘으면 앞사람을 끊고 강제로) */
  async unloadAll(): Promise<void> {
    await this.runExclusiveForced(async () => {
      for (const s of this.local.values()) {
        if (s.loaded) {
          s.loaded = false;
          await s.inner.unload?.();
        }
      }
    });
  }

  private wrapLocal(modelCode: string, slot: LocalSlot, modelRow: ModelRow): ModelProvider {
    return {
      id: slot.inner.id,
      kind: slot.inner.kind,
      // 줄은 첫 next() 때 선다 — 끝까지 읽거나 break(return) 하면 바로 풀린다 · 버려도 idleHoldTimeoutMs 뒤 풀린다
      chat: (req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> => this.localChat(modelCode, slot, withOutputLimit(req, modelRow), signal),
      unload: async () => {
        await this.runExclusiveForced(async () => {
          if (!slot.loaded) return;
          slot.loaded = false;
          await slot.inner.unload?.();
        });
      },
    };
  }

  private async *localChat(modelCode: string, slot: LocalSlot, req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const ticket = await this.lock.acquire(this.queueWaitTimeoutMs, signal);
    if (ticket === 'aborted') {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    if (ticket === 'timeout') {
      yield { type: 'error', message: `로컬 추론 대기 시간초과(${this.queueWaitTimeoutMs}ms): ${modelCode} — 앞선 로컬 추론이 끝나지 않았습니다` };
      return;
    }
    const inner = new AbortController();
    const onOuterAbort = (): void => inner.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (signal?.aborted) inner.abort();
    let iter: AsyncIterator<ChatChunk> | null = null;
    let closing: Promise<void> | null = null;
    /** 안쪽 스트림을 끊고 그 return()(= 안쪽 finally) 이 끝날 때까지 */
    const closeInner = (): Promise<void> => {
      if (!closing) {
        inner.abort();
        const it = iter;
        closing = (async () => {
          try {
            await it?.return?.();
          } catch {
            // 안쪽이 던져도 줄은 푼다
          }
        })();
      }
      return closing;
    };
    const wasLoaded = slot.loaded;
    let produced = false;
    let errored = false;
    let started = false;
    const settleLoaded = (): void => {
      if (!started) return;
      if (slot.inner.isLoaded) slot.loaded = slot.inner.isLoaded();
      else if (!wasLoaded && errored && !produced) slot.loaded = false; // 처음 적재하던 chat 이 글 없이 실패 = 적재 실패
    };
    let revoked = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const disarm = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const revoke = async (): Promise<void> => {
      if (revoked) return;
      revoked = true;
      disarm();
      // 엔진이 signal 을 무시해도 줄을 영원히 붙들지 않게 상한을 둔다
      await settleWithin(closeInner(), this.unloadWaitTimeoutMs);
      settleLoaded();
      ticket.release();
    };
    ticket.revoke = revoke;
    /** 조각 하나를 내기 직전 — 부르는 쪽이 idleHoldTimeoutMs 안에 next() 를 안 부르면 줄을 뺏는다 */
    const arm = (): void => {
      disarm();
      idleTimer = setTimeout(() => void revoke(), this.idleHoldTimeoutMs);
      idleTimer.unref?.();
    };
    try {
      let refused: string | null = null;
      if (slot.ramMB > this.ramBudgetMB) refused = `RAM 부족: ${modelCode} 는 ${slot.ramMB}MB 인데 예산이 ${this.ramBudgetMB}MB 입니다`;
      else if (!slot.loaded) refused = await this.makeRoom(modelCode, slot.ramMB);
      if (refused !== null) {
        arm();
        yield { type: 'error', message: refused };
        disarm();
        return;
      }
      slot.loaded = true;
      slot.lastUsed = ++this.useCounter;
      started = true;
      iter = slot.inner.chat(req, inner.signal)[Symbol.asyncIterator]();
      for (;;) {
        let r: IteratorResult<ChatChunk>;
        try {
          r = await iter.next();
        } catch (e) {
          // 약속(던지지 않음)을 어긴 공급자도 줄을 붙들지 않게
          errored = true;
          arm();
          yield { type: 'error', message: errorText(e) };
          disarm();
          break;
        }
        if (r.done) break;
        const c = r.value;
        if (c.type === 'error') errored = true;
        else if (c.type !== 'done') produced = true;
        arm();
        yield c;
        disarm();
        if (revoked) {
          yield { type: 'done', finishReason: FINISH_ABORTED };
          return;
        }
      }
    } finally {
      disarm();
      signal?.removeEventListener('abort', onOuterAbort);
      if (!revoked) {
        await closeInner();
        settleLoaded();
        ticket.release();
      }
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

  /** 줄을 unloadWaitTimeoutMs 만 기다려 fn 을 돌린다 — 넘으면 지금 줄을 잡은 chat 을 끊고(revoke) 줄 없이 돌린다 */
  private async runExclusiveForced(fn: () => Promise<void>): Promise<void> {
    const ticket = await this.lock.acquire(this.unloadWaitTimeoutMs);
    if (ticket === 'timeout' || ticket === 'aborted') {
      await this.lock.current?.revoke?.();
      await fn();
      return;
    }
    try {
      await fn();
    } finally {
      ticket.release();
    }
  }
}
