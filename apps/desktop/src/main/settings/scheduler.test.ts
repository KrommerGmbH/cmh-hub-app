import { describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_DELAY_MS, MIN_RUN_INTERVAL_SECONDS, Scheduler, type SchedulerTimer, type ScheduledTaskRow } from './scheduler.js';

/** 가짜 시간 — advance(ms) 가 그 사이 타이머를 차례대로 부르고 microtask 를 비운다 */
class FakeTimer implements SchedulerTimer {
  private t = 1_000_000;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  readonly delays: number[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    this.seq += 1;
    this.delays.push(ms);
    this.timers.set(this.seq, { at: this.t + ms, callback });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.t = Math.max(this.t, nextAt);
      timer?.callback();
    }
    this.t = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MIN = 60_000;

describe('Scheduler (R7-b · scheduled_task 꼴)', () => {
  it('start 전에는 안 돈다 · start 하면 바로 한 번 · 그 뒤 run_interval 마다', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const handler = vi.fn();
    scheduler.register({ name: 'cache.cleanup', scheduledTaskClass: 'ModelCacheCleanup', runInterval: 60, handler });
    await timer.advance(10 * MIN);
    expect(handler).not.toHaveBeenCalled();
    scheduler.start();
    await timer.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await timer.advance(MIN - 1);
    expect(handler).toHaveBeenCalledTimes(1);
    await timer.advance(1);
    expect(handler).toHaveBeenCalledTimes(2);
    const row = scheduler.get('cache.cleanup');
    expect(row).toMatchObject<Partial<ScheduledTaskRow>>({
      name: 'cache.cleanup',
      scheduled_task_class: 'ModelCacheCleanup',
      run_interval: 60,
      status: 'scheduled',
      last_execution_time: timer.now(),
      next_execution_time: timer.now() + MIN,
    });
  });

  it('놓친 차례는 몰아서 돌리지 않는다(next 가 한참 지났어도 한 번)', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const handler = vi.fn();
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler, nextExecutionTime: timer.now() - 100 * MIN });
    scheduler.start();
    await timer.advance(MIN - 1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('실패 → status failed · onError · 다음 차례를 다시 잡는다(동기 throw · 거부 둘 다)', async () => {
    const timer = new FakeTimer();
    const onError = vi.fn();
    const scheduler = new Scheduler({ timer, onError });
    let calls = 0;
    scheduler.register({
      name: 't',
      scheduledTaskClass: 'T',
      runInterval: 60,
      handler: () => {
        calls += 1;
        if (calls === 1) throw new Error('sync boom');
        if (calls === 2) return Promise.reject(new Error('async boom'));
        return undefined;
      },
    });
    scheduler.start();
    await timer.advance(0);
    expect(scheduler.get('t')?.status).toBe('failed');
    expect(onError).toHaveBeenLastCalledWith('t', expect.objectContaining({ message: 'sync boom' }));
    await timer.advance(MIN);
    expect(scheduler.get('t')?.status).toBe('failed');
    expect(onError).toHaveBeenLastCalledWith('t', expect.objectContaining({ message: 'async boom' }));
    await timer.advance(MIN);
    expect(calls).toBe(3);
    expect(scheduler.get('t')?.status).toBe('scheduled');
  });

  it('onError 가 던져도 다음 차례는 잡힌다', async () => {
    const timer = new FakeTimer();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new Scheduler({
      timer,
      onError: () => {
        throw new Error('reporter broken');
      },
    });
    const handler = vi.fn(() => {
      throw new Error('x');
    });
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler });
    scheduler.start();
    await timer.advance(MIN);
    expect(handler).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('같은 이름은 겹쳐 돌지 않는다 · 돌고 있는 동안 runNow 는 skipped-running', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    scheduler.register({
      name: 'slow',
      scheduledTaskClass: 'Slow',
      runInterval: 60,
      handler: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      },
    });
    scheduler.start();
    await timer.advance(0);
    expect(scheduler.get('slow')?.status).toBe('running');
    await timer.advance(10 * MIN); // 주기가 지나도 새로 시작하지 않는다
    expect(await scheduler.runNow('slow')).toBe('skipped-running');
    expect(maxActive).toBe(1);
    gate.resolve();
    await timer.advance(0);
    expect(scheduler.get('slow')?.status).toBe('scheduled');
    expect(scheduler.get('slow')?.next_execution_time).toBe(timer.now() + MIN); // 끝난 시각 + run_interval
  });

  it('inactive 는 절대 안 돈다(타이머 · runNow) · 다시 켜면 돈다', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const handler = vi.fn();
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler, status: 'inactive' });
    scheduler.start();
    await timer.advance(10 * MIN);
    expect(await scheduler.runNow('t')).toBe('inactive');
    expect(handler).not.toHaveBeenCalled();
    expect(timer.pending()).toBe(0);
    scheduler.setActive('t', true);
    await timer.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
    scheduler.setActive('t', false);
    await timer.advance(10 * MIN);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scheduler.get('t')?.status).toBe('inactive');
  });

  it('도는 중 inactive 로 바꾸면 끝난 뒤 다시 잡지 않는다', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const gate = deferred();
    const handler = vi.fn(() => gate.promise);
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler });
    scheduler.start();
    await timer.advance(0);
    scheduler.setActive('t', false);
    gate.resolve();
    await timer.advance(10 * MIN);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scheduler.get('t')?.status).toBe('inactive');
  });

  it('runNow: 다음 차례를 끝난 시각 기준으로 다시 잡는다 · 실패면 failed', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer, onError: () => undefined });
    const handler = vi.fn();
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler, nextExecutionTime: timer.now() + 30 * MIN });
    scheduler.register({ name: 'bad', scheduledTaskClass: 'Bad', runInterval: 60, handler: () => Promise.reject(new Error('x')), nextExecutionTime: timer.now() + 30 * MIN });
    scheduler.start();
    expect(await scheduler.runNow('t')).toBe('ran');
    expect(await scheduler.runNow('bad')).toBe('failed');
    expect(handler).toHaveBeenCalledTimes(1);
    await timer.advance(MIN);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('최소 주기 · 이름 · 중복 등록 검사', async () => {
    const scheduler = new Scheduler({ timer: new FakeTimer() });
    const base = { scheduledTaskClass: 'T', handler: () => undefined };
    expect(() => scheduler.register({ ...base, name: 't', runInterval: MIN_RUN_INTERVAL_SECONDS - 1 })).toThrow('>= 60');
    expect(() => scheduler.register({ ...base, name: 't', runInterval: 60.5 })).toThrow('integer');
    expect(() => scheduler.register({ ...base, name: 'a b', runInterval: 60 })).toThrow('invalid task name');
    expect(() => scheduler.register({ ...base, name: 't', runInterval: 60, scheduledTaskClass: ' ' })).toThrow('scheduledTaskClass');
    scheduler.register({ ...base, name: 't', runInterval: 60 });
    expect(() => scheduler.register({ ...base, name: 't', runInterval: 60 })).toThrow('already registered');
    await expect(scheduler.runNow('missing')).rejects.toThrow('unknown task');
  });

  it('setTimeout 상한보다 긴 기다림은 잘라서 자고 다시 잰다(Node 가 1ms 로 바꾸는 함정)', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const handler = vi.fn();
    const far = MAX_TIMER_DELAY_MS + 5 * MIN;
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler, nextExecutionTime: timer.now() + far });
    scheduler.start();
    expect(timer.delays.at(-1)).toBe(MAX_TIMER_DELAY_MS);
    await timer.advance(MAX_TIMER_DELAY_MS);
    expect(handler).not.toHaveBeenCalled();
    await timer.advance(5 * MIN);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stop: 타이머를 지우고 abort 를 보내고 끝나는 handler 를 기다린다', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    let aborted = false;
    scheduler.register({
      name: 't',
      scheduledTaskClass: 'T',
      runInterval: 60,
      handler: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    });
    scheduler.register({ name: 'idle', scheduledTaskClass: 'I', runInterval: 60, handler: () => undefined, nextExecutionTime: timer.now() + MIN });
    scheduler.start();
    await timer.advance(0);
    const result = await scheduler.stop();
    expect(aborted).toBe(true);
    expect(result.unfinished).toEqual([]);
    expect(timer.pending()).toBe(0);
    expect(await scheduler.runNow('idle')).toBe('stopped');
    expect(() => scheduler.start()).toThrow('stopped');
  });

  it('stop: abort 를 무시하는 handler 도 stopTimeoutMs 뒤에 stop 이 끝난다(영영 안 끝나는 버그 방지)', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer, stopTimeoutMs: 3_000 });
    const gate = deferred();
    scheduler.register({ name: 'stuck', scheduledTaskClass: 'Stuck', runInterval: 60, handler: () => gate.promise });
    scheduler.start();
    await timer.advance(0);
    let done: { readonly unfinished: readonly string[] } | null = null;
    void scheduler.stop().then((r) => {
      done = r;
    });
    await timer.advance(2_999);
    expect(done).toBeNull();
    await timer.advance(1);
    expect(done).toEqual({ unfinished: ['stuck'] });
    // 늦게 끝나도 다음 차례를 잡지 않는다
    gate.resolve();
    await timer.advance(10 * MIN);
    expect(timer.pending()).toBe(0);
  });

  it('검수 7 🟢2: start() 전 runNow 는 돌지 않고 not-started', async () => {
    const timer = new FakeTimer();
    const scheduler = new Scheduler({ timer });
    const handler = vi.fn();
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler });
    expect(await scheduler.runNow('t')).toBe('not-started');
    expect(handler).not.toHaveBeenCalled();
    expect(scheduler.get('t')?.status).toBe('scheduled');
  });

  it('검수 7 🟢1: running 을 알리는 onRowChange 안에서 runNow 를 불러도 겹쳐 돌지 않는다', async () => {
    const timer = new FakeTimer();
    let scheduler: Scheduler | null = null;
    const nested: Promise<string>[] = [];
    scheduler = new Scheduler({
      timer,
      onRowChange: (row) => {
        if (row.status === 'running' && nested.length === 0) nested.push(scheduler?.runNow('u') ?? Promise.resolve('none'));
      },
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const gate = deferred();
    scheduler.register({
      name: 'u',
      scheduledTaskClass: 'U',
      runInterval: 60,
      nextExecutionTime: timer.now() + 30 * MIN,
      handler: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent -= 1;
      },
    });
    scheduler.start();
    const first = scheduler.runNow('u');
    expect(await nested[0]).toBe('skipped-running');
    gate.resolve();
    expect(await first).toBe('ran');
    expect(maxConcurrent).toBe(1);
  });

  it('검수 7 🟢3: handler 가 setActive(false) 뒤 던지면 runNow 는 failed', async () => {
    const timer = new FakeTimer();
    const onError = vi.fn();
    const scheduler = new Scheduler({ timer, onError });
    scheduler.register({
      name: 'v',
      scheduledTaskClass: 'V',
      runInterval: 60,
      nextExecutionTime: timer.now() + 30 * MIN,
      handler: () => {
        scheduler.setActive('v', false);
        throw new Error('x');
      },
    });
    scheduler.start();
    expect(await scheduler.runNow('v')).toBe('failed');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.get('v')?.status).toBe('inactive');
  });

  it('검수 7 🟢4: stop() 이 끝난 뒤 늦게 끝난 handler 는 onRowChange 를 부르지 않는다 · 기다리는 동안 끝난 것은 알린다', async () => {
    const timer = new FakeTimer();
    const rows: ScheduledTaskRow[] = [];
    const scheduler = new Scheduler({ timer, stopTimeoutMs: 3_000, onRowChange: (row) => rows.push(row) });
    const stuck = deferred();
    const quick = deferred();
    scheduler.register({ name: 'stuck', scheduledTaskClass: 'S', runInterval: 60, handler: () => stuck.promise });
    scheduler.register({ name: 'quick', scheduledTaskClass: 'Q', runInterval: 60, handler: () => quick.promise });
    scheduler.start();
    await timer.advance(0);
    let done: { readonly unfinished: readonly string[] } | null = null;
    void scheduler.stop().then((r) => {
      done = r;
    });
    quick.resolve();
    await timer.advance(1_000);
    expect(rows.at(-1)).toMatchObject({ name: 'quick', status: 'scheduled' }); // 기다리는 동안 끝남 → 알린다
    await timer.advance(2_000);
    expect(done).toEqual({ unfinished: ['stuck'] });
    const before = rows.length;
    stuck.resolve();
    await timer.advance(10 * MIN);
    expect(rows.length).toBe(before); // stop 이 끝난 뒤 → 알리지 않는다
    expect(scheduler.get('stuck')?.status).toBe('scheduled'); // 메모리 행은 바뀐다
    expect(timer.pending()).toBe(0);
  });

  it('onRowChange 는 상태가 바뀔 때마다 행 사본을 받는다', async () => {
    const timer = new FakeTimer();
    const rows: ScheduledTaskRow[] = [];
    const scheduler = new Scheduler({ timer, onRowChange: (row) => rows.push(row) });
    scheduler.register({ name: 't', scheduledTaskClass: 'T', runInterval: 60, handler: () => undefined });
    scheduler.start();
    await timer.advance(0);
    expect(rows.map((r) => r.status)).toEqual(['scheduled', 'running', 'scheduled']);
  });
});
