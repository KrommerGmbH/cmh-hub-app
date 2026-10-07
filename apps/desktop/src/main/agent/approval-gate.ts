// RA — 승인 관문. electron 을 import 하지 않는 순수 모듈.
// 합의안 5(cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안»): 승인 상태 쓰기는 main 의 UI IPC 핸들러(사람 클릭)만.
// 그래서 결정 함수 `decide` 는 `ApprovalGate` 인터페이스에 없다 — AgentRunner · 도구 · 플러그인은 `ApprovalGate`(open/requestApproval)만 받고,
// `InMemoryApprovalGate` 객체 자체는 main 의 IPC 핸들러만 쥔다. `decide` 는 actor 가 'human-ui' 가 아니면 예외(IPC 로 들어온 값은 런타임 검사).
// 1차는 메모리 안 대기열이다. DB(`cmh_ai_approval` 행 만들기 · decision 칸 쓰기)는 다음 차례 — 같은 인터페이스의 다른 구현으로 갈아 끼운다.
import { randomUUID } from 'node:crypto';

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout';
/** 사람이 고를 수 있는 결정(timeout 은 관문이 낸다) */
export type ApprovalDecision = 'approved' | 'rejected';
/** 결정을 쓸 수 있는 유일한 주체 — main 의 UI IPC 핸들러(사람 클릭) */
export type ApprovalActor = 'human-ui';
/** guard_ask = Guard 결정이 ask · requires_approval = allow 여도 승인 관문(마켓 쓰기 · needsApproval) */
export type ApprovalReason = 'guard_ask' | 'requires_approval';

export interface ApprovalRequest {
  readonly runId: string;
  /** Guard 이름 */
  readonly tool: string;
  readonly argsSummary: string;
  readonly reason: ApprovalReason;
  /** 이 run 이 끝나면(취소 · 시간 상한) 대기를 거둔다 — 결과는 'rejected'(사람이 승인하지 않았으므로 막는 쪽) */
  readonly signal?: AbortSignal;
}

export interface ApprovalTicket {
  /** UI 가 decide 에 넘길 id */
  readonly id: string;
  readonly decision: Promise<ApprovalOutcome>;
}

/** AgentRunner 가 보는 쪽 — 결정할 수단이 없다 */
export interface ApprovalGate {
  /** 대기 행을 만들고 id 를 먼저 돌려준다(이벤트 approval_required 를 낸 뒤 decision 을 기다리려고) */
  open(request: ApprovalRequest): Promise<ApprovalTicket>;
  /** open + decision 기다리기 */
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

export interface PendingApproval {
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly argsSummary: string;
  readonly reason: ApprovalReason;
  /** 열린 때(ms · now()) */
  readonly createdAt: number;
}

export interface InMemoryApprovalGateOptions {
  /** 사람이 이 시간 안에 안 고르면 'timeout'. 【임시 기본값 5분 · 근거 없음 · 다음 차례에 설정 테이블 값으로】 */
  timeoutMs?: number;
  /** 시험용 */
  now?: () => number;
  /** 시험용 — 기본 crypto.randomUUID */
  newId?: () => string;
}

export const APPROVAL_DEFAULT_TIMEOUT_MS = 5 * 60_000;

const DECISIONS: readonly string[] = ['approved', 'rejected'];

interface Slot {
  readonly pending: PendingApproval;
  readonly settle: (outcome: ApprovalOutcome) => void;
}

export class InMemoryApprovalGate implements ApprovalGate {
  private readonly slots = new Map<string, Slot>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: InMemoryApprovalGateOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? APPROVAL_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  // async 지만 await 가 없어 대기 행은 이 함수를 부른 그 차례에 이미 들어가 있다
  async open(request: ApprovalRequest): Promise<ApprovalTicket> {
    const id = this.newId();
    const pending: PendingApproval = {
      id,
      runId: request.runId,
      tool: request.tool,
      argsSummary: request.argsSummary,
      reason: request.reason,
      createdAt: this.now(),
    };
    const signal = request.signal;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.slots.delete(id)) return; // 이미 정해짐
        if (timer !== null) clearTimeout(timer);
        if (onAbort !== null) signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      this.slots.set(id, { pending, settle });
      timer = setTimeout(() => settle('timeout'), this.timeoutMs);
      if (signal) {
        onAbort = () => settle('rejected');
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return { id, decision };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return (await this.open(request)).decision;
  }

  /**
   * 사람의 결정. main 의 UI IPC 핸들러만 부른다(합의안 5).
   * actor · decision 이 틀리면 예외(프로그래머 잘못) · 이미 정해졌거나 없는 id 면 false(사람이 시간 초과 뒤 누른 경우 — 자료 문제).
   */
  decide(id: string, decision: ApprovalDecision, actor: ApprovalActor): boolean {
    if ((actor as string) !== 'human-ui') throw new Error(`approval: only the human UI IPC may decide (actor ${JSON.stringify(actor)})`);
    if (!DECISIONS.includes(decision as string)) throw new Error(`approval: unknown decision ${JSON.stringify(decision)}`);
    const slot = this.slots.get(id);
    if (!slot) return false;
    slot.settle(decision);
    return true;
  }

  /** UI 가 그릴 대기 목록(열린 차례) */
  listPending(runId?: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const { pending } of this.slots.values()) {
      if (runId === undefined || pending.runId === runId) out.push(pending);
    }
    return out;
  }
}
