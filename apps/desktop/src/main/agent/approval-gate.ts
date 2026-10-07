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

/**
 * 승인 화면에 싣는 인자 전문 상한(UTF-8 바이트). 넘으면 사람이 다 볼 수 없으므로 승인 자체를 열지 않는다(RA 검수 4 차단 2) —
 * AgentRunner 는 열기 전에 재서 deny 하고, 관문도 넘는 요청은 예외로 막는다(두 겹).
 */
export const APPROVAL_ARGS_MAX_BYTES = 256 * 1024;

export interface ApprovalRequest {
  readonly runId: string;
  /** Guard 이름 */
  readonly tool: string;
  /** 도구 줄용 요약(비밀 같은 키 값은 `***(N자)` · 500자 상한). 승인 판단에는 argsFull 을 쓴다 */
  readonly argsSummary: string;
  /**
   * 실행될 인자 전문 — 자르지 않고 가리지도 않은 canonical JSON(키 정렬). 사람이 승인하는 것은 이 글이다(RA 검수 4 차단 2).
   * APPROVAL_ARGS_MAX_BYTES 를 넘으면 관문이 예외.
   */
  readonly argsFull: string;
  /** 비밀처럼 보이는 키의 경로(`a.b` · `items[0].token`). 비어 있지 않으면 R6 승인 화면이 경고를 띄운다 — 값은 argsFull 에 그대로 있다 */
  readonly maskedKeys: readonly string[];
  /** Guard 가 맞춘 규칙(없으면 null) — 승인 화면 표시용 */
  readonly matchedPattern?: string | null;
  readonly reason: ApprovalReason;
  /** 이 run 이 끝나면(취소 · 시간 상한) 대기를 거둔다 — 결과는 'rejected'(사람이 승인하지 않았으므로 막는 쪽) */
  readonly signal?: AbortSignal;
}

export interface ApprovalTicket {
  /** UI 가 decide 에 넘길 id */
  readonly id: string;
  readonly decision: Promise<ApprovalOutcome>;
  /** 이 때(ms · epoch)가 지나면 관문이 'timeout' 을 낸다 — 아는 관문만 */
  readonly expiresAt?: number;
}

/** AgentRunner 가 보는 쪽 — 결정할 수단이 없다 */
export interface ApprovalGate {
  /** 대기 행을 만들고 id 를 먼저 돌려준다(이벤트 approval_required 를 낸 뒤 decision 을 기다리려고) */
  open(request: ApprovalRequest): Promise<ApprovalTicket>;
  /** open + decision 기다리기 */
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * `{ open, requestApproval }` 만 담은 얇은 겉객체(RA 검수 4 권고 7). InMemoryApprovalGate 를 그대로 넘기면
 * 형변환으로 `decide` 에 닿을 수 있다 — runner · 도구 · 플러그인에는 이것만 넘긴다(AgentRunner 생성자도 스스로 감싼다).
 */
export function restrictGate(gate: ApprovalGate): ApprovalGate {
  return Object.freeze({
    open: (request: ApprovalRequest) => gate.open(request),
    requestApproval: (request: ApprovalRequest) => gate.requestApproval(request),
  });
}

export interface PendingApproval {
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly argsSummary: string;
  /** 사람이 승인 화면에서 볼 인자 전문(ApprovalRequest.argsFull) */
  readonly argsFull: string;
  /** 비밀처럼 보이는 키 경로 — 승인 화면 경고용 */
  readonly maskedKeys: readonly string[];
  readonly matchedPattern: string | null;
  readonly reason: ApprovalReason;
  /** 열린 때(ms · now()) */
  readonly createdAt: number;
  /** 이 때가 지나면 'timeout'(ms · now() 기준) */
  readonly expiresAt: number;
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
    if (typeof request.argsFull !== 'string') throw new Error('approval: argsFull must be a string');
    if (Buffer.byteLength(request.argsFull, 'utf8') > APPROVAL_ARGS_MAX_BYTES) {
      throw new Error(`approval: argsFull larger than ${APPROVAL_ARGS_MAX_BYTES} bytes — a human cannot review it`);
    }
    const id = this.newId();
    // 같은 id 로 앞 대기를 덮어쓰면 앞 약속은 영원히 안 풀린다(RA 검수 4 R11) — 프로그래머 잘못(newId)이므로 예외
    if (this.slots.has(id)) throw new Error(`approval: duplicate approval id ${JSON.stringify(id)}`);
    const createdAt = this.now();
    const pending: PendingApproval = {
      id,
      runId: request.runId,
      tool: request.tool,
      argsSummary: request.argsSummary,
      argsFull: request.argsFull,
      maskedKeys: [...(request.maskedKeys ?? [])],
      matchedPattern: request.matchedPattern ?? null,
      reason: request.reason,
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
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
    return { id, decision, expiresAt: pending.expiresAt };
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
