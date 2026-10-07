// R7-b — 예약 작업(scheduled task). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 칸 이름은 Shopware `scheduled_task` 그대로(PLAN R7 §4): `name` · `scheduled_task_class` · `run_interval`(초) · `status` ·
// `last_execution_time` · `next_execution_time`. 타이머는 main 타이머(H04 와 따로) — `now()` · `setTimeout` 꼴을 주입받아 시험은 가짜 시간으로 돈다.
//
// 규칙:
//   ①같은 이름은 한 번에 하나만 돈다(겹침 없음 — 돌고 있으면 그 차례는 건너뛴다)
//   ②실패하면 status `failed` 로 두고 다음 차례를 다시 잡는다. Shopware 기본(shouldRescheduleOnFailure=false)은 failed 가 영영 안 도는데
//     CmhCore 가 같은 함정을 이미 겪고 true 로 덮었다(`CmhCore/src/Service/ScheduledTask/CrawlPriceRefresh/CmhCrawlPriceRefreshTask.php:42-53`).
//   ③`inactive` 는 절대 돌지 않는다(runNow 도)
//   ④앱이 켜져 있을 때만 돈다(PLAN R7 §9 · 꺼져 있으면 서버 큐) — start() 전에는 아무것도 안 돌고, stop() 은 타이머를 지우고
//     도는 handler 에 abort 를 보낸 뒤 stopTimeoutMs 만 기다린다(플러그인 호스트 `plugin-process.ts` settlesWithin 꼴 — stop 이 영영 안 끝나는 버그를 막는다).
//   ⑤앱이 꺼져 있던 동안 놓친 차례는 몰아서 돌리지 않는다 — 시작 때 next_execution_time 이 지났으면 한 번만 바로 돈다.
//
// 【AI 임시 결정】 status `queued` 는 Shopware 꼴을 맞추려고 타입에만 둔다(로컬은 큐 없이 바로 running) — 서버에서 온 행을 그대로 담을 수 있게.
// 【AI 임시 결정】 다음 차례 = handler 가 끝난 시각 + run_interval(시작 시각 기준이면 오래 걸린 작업이 쉬지 않고 바로 다시 돈다).

export const SCHEDULED_TASK_STATUSES = ['scheduled', 'queued', 'running', 'failed', 'inactive'] as const;
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

/** Shopware `scheduled_task` 한 행(시각은 epoch ms · 저장 계층이 ISO 로 바꾼다) */
export interface ScheduledTaskRow {
  readonly name: string;
  readonly scheduled_task_class: string;
  /** 초 */
  readonly run_interval: number;
  readonly status: ScheduledTaskStatus;
  readonly last_execution_time: number | null;
  readonly next_execution_time: number;
}

export interface ScheduledTaskContext {
  readonly name: string;
  /** stop() 때 abort 된다 — 오래 도는 handler 는 이것을 보고 멈춘다 */
  readonly signal: AbortSignal;
}

export type ScheduledTaskHandler = (context: ScheduledTaskContext) => unknown;

export interface ScheduledTaskDefinition {
  readonly name: string;
  /** Shopware 는 PHP 클래스 이름 — 여기서는 handler 를 가리키는 이름(설정 화면 · 로그용) */
  readonly scheduledTaskClass: string;
  /** 초 · MIN_RUN_INTERVAL_SECONDS 이상 정수 */
  readonly runInterval: number;
  readonly handler: ScheduledTaskHandler;
  /** 처음 상태 — 기본 scheduled. inactive 로 등록하면 setActive(true) 전까지 안 돈다 */
  readonly status?: 'scheduled' | 'inactive';
  /** 처음 다음 차례(epoch ms) — 기본 지금(start 하면 바로 한 번) · 저장된 행을 되살릴 때 준다 */
  readonly nextExecutionTime?: number;
}

/** 주입 타이머 — 기본은 전역 Date.now · setTimeout · clearTimeout */
export interface SchedulerTimer {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  readonly timer?: SchedulerTimer;
  /** stop() 이 도는 handler 를 기다리는 상한(ms) — 【AI 임시 결정】 기본 5000 */
  readonly stopTimeoutMs?: number;
  /** handler 실패 · 거부를 받는다. 주지 않으면 console.error(조용히 버리지 않는다) */
  readonly onError?: (name: string, error: unknown) => void;
  /** 행이 바뀔 때마다(상태 · 시각) — 나중에 저장 계층이 듣는다 */
  readonly onRowChange?: (row: ScheduledTaskRow) => void;
}

export type RunNowResult = 'ran' | 'failed' | 'skipped-running' | 'inactive' | 'stopped';

/** 【AI 임시 결정】 최소 주기 60초 — 실수로 1초 주기를 넣어 CPU · 네트워크를 태우지 않게(원칙 1) */
export const MIN_RUN_INTERVAL_SECONDS = 60;
/** setTimeout 상한(2^31-1 ms). 넘기면 Node 가 1ms 로 바꿔 바로 불러 버린다 — 그보다 길면 이만큼 자고 깨어 다시 잰다 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NAME_MAX = 255;

interface TaskState {
  row: ScheduledTaskRow;
  readonly handler: ScheduledTaskHandler;
  timer: unknown;
  hasTimer: boolean;
  running: Promise<void> | null;
}

const defaultTimer: SchedulerTimer = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Scheduler {
  private readonly tasks = new Map<string, TaskState>();
  private readonly timer: SchedulerTimer;
  private readonly stopTimeoutMs: number;
  private readonly onError: (name: string, error: unknown) => void;
  private readonly onRowChange: ((row: ScheduledTaskRow) => void) | undefined;
  private readonly abort = new AbortController();
  private state: 'idle' | 'running' | 'stopped' = 'idle';

  constructor(options: SchedulerOptions = {}) {
    this.timer = options.timer ?? defaultTimer;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.onError = options.onError ?? ((name, error) => console.error(`[scheduler] task "${name}" failed`, error));
    this.onRowChange = options.onRowChange;
  }

  register(definition: ScheduledTaskDefinition): void {
    if (this.state === 'stopped') throw new Error('scheduler: stopped');
    const { name, scheduledTaskClass, runInterval } = definition;
    if (!NAME_PATTERN.test(name) || name.length > NAME_MAX) throw new Error(`scheduler: invalid task name "${name}"`);
    if (this.tasks.has(name)) throw new Error(`scheduler: task "${name}" already registered`);
    if (scheduledTaskClass.trim().length === 0) throw new Error(`scheduler: task "${name}" needs scheduledTaskClass`);
    if (!Number.isInteger(runInterval) || runInterval < MIN_RUN_INTERVAL_SECONDS) {
      throw new Error(`scheduler: task "${name}" run_interval must be an integer >= ${MIN_RUN_INTERVAL_SECONDS} seconds`);
    }
    const next = definition.nextExecutionTime ?? this.timer.now();
    if (!Number.isFinite(next)) throw new Error(`scheduler: task "${name}" nextExecutionTime must be finite`);
    const task: TaskState = {
      row: {
        name,
        scheduled_task_class: scheduledTaskClass,
        run_interval: runInterval,
        status: definition.status ?? 'scheduled',
        last_execution_time: null,
        next_execution_time: next,
      },
      handler: definition.handler,
      timer: undefined,
      hasTimer: false,
      running: null,
    };
    this.tasks.set(name, task);
    this.emitRow(task);
    if (this.state === 'running') this.arm(task);
  }

  /** 행 사본들(설정 화면 ⑥ 예약 작업 목록용) */
  list(): ScheduledTaskRow[] {
    return [...this.tasks.values()].map((t) => ({ ...t.row }));
  }

  get(name: string): ScheduledTaskRow | null {
    const task = this.tasks.get(name);
    return task === undefined ? null : { ...task.row };
  }

  /** 앱이 켜졌다 — 타이머를 건다. 【AI 임시 결정】 stop() 뒤에는 다시 못 켠다(앱 한 번 = scheduler 한 개) */
  start(): void {
    if (this.state === 'stopped') throw new Error('scheduler: stopped');
    if (this.state === 'running') return;
    this.state = 'running';
    for (const task of this.tasks.values()) this.arm(task);
  }

  /** 켜기 · 끄기. 끄면(inactive) 타이머를 지우고 runNow 도 거부 — 도는 중인 handler 는 끝까지 둔다(끝나도 다시 안 잡는다) */
  setActive(name: string, active: boolean): void {
    const task = this.require(name);
    if (!active) {
      this.disarm(task);
      this.update(task, { status: 'inactive' });
      return;
    }
    if (task.row.status !== 'inactive') return;
    this.update(task, { status: task.running ? 'running' : 'scheduled' });
    if (task.running === null && this.state === 'running') this.arm(task);
  }

  /** 지금 한 번 돌린다(설정 화면 «지금 실행»). 돌고 있으면 겹치지 않고 건너뛴다 */
  async runNow(name: string): Promise<RunNowResult> {
    const task = this.require(name);
    if (this.state === 'stopped') return 'stopped';
    if (task.row.status === 'inactive') return 'inactive';
    if (task.running !== null) return 'skipped-running';
    this.disarm(task);
    await this.execute(task);
    return task.row.status === 'failed' ? 'failed' : 'ran';
  }

  /**
   * 앱이 꺼진다 — 모든 타이머를 지우고 도는 handler 에 abort 를 보낸 뒤 stopTimeoutMs 만 기다린다.
   * 그래도 안 끝난 작업 이름을 돌려준다(그 handler 가 나중에 끝나도 다음 차례는 잡지 않는다). 두 번 불러도 된다.
   */
  async stop(): Promise<{ readonly unfinished: readonly string[] }> {
    this.state = 'stopped';
    for (const task of this.tasks.values()) this.disarm(task);
    this.abort.abort();
    const running = [...this.tasks.values()].filter((t) => t.running !== null);
    const results = await Promise.all(running.map(async (t) => ({ name: t.row.name, done: await this.settlesWithin(t.running ?? Promise.resolve(), this.stopTimeoutMs) })));
    return { unfinished: results.filter((r) => !r.done).map((r) => r.name) };
  }

  // ---------------------------------------------------------------- 안쪽

  private require(name: string): TaskState {
    const task = this.tasks.get(name);
    if (task === undefined) throw new Error(`scheduler: unknown task "${name}"`);
    return task;
  }

  private arm(task: TaskState): void {
    this.disarm(task);
    if (this.state !== 'running' || task.row.status === 'inactive' || task.running !== null) return;
    const delay = Math.min(Math.max(0, task.row.next_execution_time - this.timer.now()), MAX_TIMER_DELAY_MS);
    task.hasTimer = true;
    task.timer = this.timer.setTimeout(() => {
      task.hasTimer = false;
      task.timer = undefined;
      this.onTimer(task);
    }, delay);
  }

  private disarm(task: TaskState): void {
    if (!task.hasTimer) return;
    this.timer.clearTimeout(task.timer);
    task.hasTimer = false;
    task.timer = undefined;
  }

  private onTimer(task: TaskState): void {
    if (this.state !== 'running' || task.row.status === 'inactive' || task.running !== null) return;
    // MAX_TIMER_DELAY_MS 로 잘라 일찍 깼으면 다시 잔다
    if (this.timer.now() < task.row.next_execution_time) {
      this.arm(task);
      return;
    }
    void this.execute(task);
  }

  /** handler 한 번. 예외 · 거부는 failed 로 · 끝나면(stop · inactive 가 아니면) 다음 차례를 건다 */
  private execute(task: TaskState): Promise<void> {
    const startedAt = this.timer.now();
    this.update(task, { status: 'running', last_execution_time: startedAt });
    const context: ScheduledTaskContext = { name: task.row.name, signal: this.abort.signal };
    // handler 는 다음 microtask 에 부른다 — 동기로 던져도 task.running 이 먼저 잡혀 있어야 «끝남» 처리가 어긋나지 않는다
    const run = Promise.resolve()
      .then(() => task.handler(context))
      .then(
        () => false,
        (error: unknown) => {
          this.reportError(task.row.name, error);
          return true;
        },
      )
      .then((failed) => {
        task.running = null;
        const next = this.timer.now() + task.row.run_interval * 1000;
        // 도는 사이 inactive 로 바뀌었으면 그대로 둔다(다시 안 잡는다)
        if (task.row.status === 'inactive') {
          this.update(task, { next_execution_time: next });
          return;
        }
        this.update(task, { status: failed ? 'failed' : 'scheduled', next_execution_time: next });
        this.arm(task);
      });
    task.running = run;
    return run;
  }

  private update(task: TaskState, patch: Partial<ScheduledTaskRow>): void {
    task.row = { ...task.row, ...patch };
    this.emitRow(task);
  }

  private emitRow(task: TaskState): void {
    if (this.onRowChange === undefined) return;
    try {
      this.onRowChange({ ...task.row });
    } catch (error) {
      this.reportError(task.row.name, error);
    }
  }

  /** onError 가 던져도 scheduler 상태(task.running 풀기 · 다음 차례)가 멈추지 않게 */
  private reportError(name: string, error: unknown): void {
    try {
      this.onError(name, error);
    } catch (secondary) {
      console.error(`[scheduler] onError threw for task "${name}"`, secondary, error);
    }
  }

  /** p 가 ms 안에 끝나면 true(plugin-process.ts settlesWithin 꼴 · 주입 타이머로) */
  private settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise((resolveWait) => {
      const handle = this.timer.setTimeout(() => resolveWait(false), ms);
      p.then(
        () => {
          this.timer.clearTimeout(handle);
          resolveWait(true);
        },
        () => {
          this.timer.clearTimeout(handle);
          resolveWait(true);
        },
      );
    });
  }
}
