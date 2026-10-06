import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startTaskWorker, TASK_ROUTES, type ClaimedTask } from './task-worker.js';
import type { AppSession } from '../identity/app-session.js';
import type { LocalLlmEngine, ChatCompletionResponse } from './local-llm-engine.js';

describe('task-worker heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mockTask: ClaimedTask = {
    task_id: 'task-test-001',
    market: 'local-llm',
    action_key: 'llm-inference',
    payload: {
      model: 'hf:test/model:Q4',
      messages: [{ role: 'user', content: 'test question' }],
    },
    lease_minutes: 10,
  };

  const dummyResponse: ChatCompletionResponse = {
    id: 'res-001',
    object: 'chat.completion',
    created: 1234567890,
    model: 'hf:test/model:Q4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };

  it('sends heartbeat 3 times in 3 seconds and stops after task finishes', async () => {
    let nextCalled = false;
    const callFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === TASK_ROUTES.next) {
        if (!nextCalled) {
          nextCalled = true;
          return { status: 200, data: { task: mockTask }, appError: null };
        }
        return { status: 200, data: { task: null }, appError: null };
      }
      return { status: 200, data: {}, appError: null };
    });

    const appSession = {
      installationId: 'test-inst',
      call: callFn,
    } as unknown as AppSession;

    let resolveChat!: (value: ChatCompletionResponse) => void;
    const chatPromise = new Promise<ChatCompletionResponse>((resolve) => {
      resolveChat = resolve;
    });

    const engine = {
      chatCompletion: vi.fn().mockReturnValue(chatPromise),
    } as unknown as LocalLlmEngine;

    const stopWorker = startTaskWorker(appSession, engine, {
      models: () => ['hf:test/model:Q4'],
      intervalMs: 10,
      heartbeatMs: 1000,
    });

    // 10ms 후 첫 번째 tick 실행 -> 작업 가져옴 -> engine.chatCompletion 대기 진입
    await vi.advanceTimersByTimeAsync(10);
    expect(callFn).toHaveBeenCalledWith(TASK_ROUTES.next, expect.any(Object));

    // 작업 진행 도중 3초 경과 -> 1000ms 마다 1번씩 총 3회 heartbeat 전송 확인
    await vi.advanceTimersByTimeAsync(3000);
    const heartbeatRoute = TASK_ROUTES.heartbeat('task-test-001');
    const heartbeatCalls = callFn.mock.calls.filter(([path]) => path === heartbeatRoute);
    expect(heartbeatCalls).toHaveLength(3);
    expect(heartbeatCalls[0]).toEqual([
      heartbeatRoute,
      { runner: 'hub-app-test-inst' },
    ]);

    // 작업 완료 (Promise 해결)
    resolveChat(dummyResponse);
    await vi.advanceTimersByTimeAsync(10);

    // 결과 전송 확인
    expect(callFn).toHaveBeenCalledWith(
      TASK_ROUTES.result('task-test-001'),
      expect.objectContaining({ runner: 'hub-app-test-inst', ok: true }),
    );

    // 작업 완료 후 추가 시간이 흘러도 heartbeat 가 더 이상 호출되지 않음
    await vi.advanceTimersByTimeAsync(5000);
    const afterDoneCalls = callFn.mock.calls.filter(([path]) => path === heartbeatRoute);
    expect(afterDoneCalls).toHaveLength(3);

    stopWorker();
  });

  it('warns when heartbeat returns 409 status', async () => {
    let nextCalled = false;
    const heartbeatRoute = TASK_ROUTES.heartbeat('task-test-001');
    const callFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === TASK_ROUTES.next) {
        if (!nextCalled) {
          nextCalled = true;
          return { status: 200, data: { task: mockTask }, appError: null };
        }
        return { status: 200, data: { task: null }, appError: null };
      }
      if (path === heartbeatRoute) {
        return { status: 409, data: null, appError: null };
      }
      return { status: 200, data: {}, appError: null };
    });

    const appSession = {
      installationId: 'test-inst',
      call: callFn,
    } as unknown as AppSession;

    let resolveChat!: (value: ChatCompletionResponse) => void;
    const chatPromise = new Promise<ChatCompletionResponse>((resolve) => {
      resolveChat = resolve;
    });

    const engine = {
      chatCompletion: vi.fn().mockReturnValue(chatPromise),
    } as unknown as LocalLlmEngine;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stopWorker = startTaskWorker(appSession, engine, {
      models: () => ['hf:test/model:Q4'],
      intervalMs: 10,
      heartbeatMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith(
      '[task-worker] heartbeat 409 — 이 작업의 lease 를 잃었습니다(다른 PC 가 집었을 수 있음)',
      'task-test-001',
    );

    resolveChat(dummyResponse);
    await vi.advanceTimersByTimeAsync(10);
    stopWorker();
  });
});
