// W01 · W04 — 서버 작업 큐(CmhAiAgent cmh_ai_task)에서 llm-inference 를 집어 업체 PC 의 로컬 모델로 돌리고 결과를 올린다.
// 모양은 서버 실제 코드 기준(CmhAiTaskController::nextAction · resultAction · CmhAiTaskRunnerService::nextTask actionKey/models 거름 · 2026-10-02).
import type { AppSession } from '../identity/app-session.js';
import type { ChatCompletionRequest, LocalLlmEngine } from './local-llm-engine.js';

export const TASK_ROUTES = {
  next: '/api/_action/cmh-ai/task/next',
  result: (taskId: string) => `/api/_action/cmh-ai/task/${encodeURIComponent(taskId)}/result`,
  release: (taskId: string) => `/api/_action/cmh-ai/task/${encodeURIComponent(taskId)}/release`,
} as const;

export interface ClaimedTask {
  task_id: string;
  market: string;
  action_key: string;
  payload: { model?: string; messages?: ChatCompletionRequest['messages']; temperature?: number; max_tokens?: number };
  lease_minutes: number;
}

export interface TaskWorkerOptions {
  /** 이 PC 가 받을 수 있는 모델(이미 내려받은 GGUF URI) */
  models: () => string[];
  intervalMs?: number;
}

export function startTaskWorker(appSession: AppSession, engine: LocalLlmEngine, opts: TaskWorkerOptions): () => void {
  const runner = `hub-app-${appSession.installationId}`;
  const intervalMs = opts.intervalMs ?? 15_000;
  let busy = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    const models = opts.models();
    if (models.length === 0) return;
    busy = true;
    try {
      const claim = await appSession.call<{ task: ClaimedTask | null }>(TASK_ROUTES.next, {
        runner,
        market: 'local-llm',
        actionKey: 'llm-inference',
        models,
      });
      const task = claim?.data?.task;
      if (!task) return;
      const started = Date.now();
      try {
        const p = task.payload;
        const result = await engine.chatCompletion({
          model: p.model ?? '',
          messages: p.messages ?? [],
          ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
          ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
        });
        await appSession.call(TASK_ROUTES.result(task.task_id), { runner, ok: true, result, durationMs: Date.now() - started });
      } catch (e) {
        await appSession.call(TASK_ROUTES.result(task.task_id), { runner, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      setImmediate(() => void tick()); // 밀린 일을 바로 하나 더
    } catch (e) {
      console.warn('[task-worker]', e);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
