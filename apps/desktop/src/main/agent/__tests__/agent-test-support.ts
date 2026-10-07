// RA 시험 도우미 — 가짜 모델(각본) · 가짜 MCP 매니저 · 세는 앱 도구. 시험 파일만 import 한다(제품 코드에서 부르지 않음).
import type { ChatChunk, ChatRequest, ModelProvider } from '../../models/model-provider.js';
import type { McpCallResult, McpToolRow } from '../../mcp/mcp-server-manager.js';
import type { AgentEvent } from '../agent-events.js';
import type { AppTool, McpToolSource } from '../tool-router.js';

/** 각본 한 걸음 — 조각 열 또는 (요청 · signal) 을 받는 함수 */
export type ScriptStep = ChatChunk[] | ((req: ChatRequest, signal?: AbortSignal) => AsyncIterable<ChatChunk>);

export interface ScriptedModel {
  readonly provider: ModelProvider;
  readonly requests: ChatRequest[];
}

/** 정해진 조각 열을 차례로 내는 가짜 공급자. 각본이 끝나면 error 조각 */
export function scriptedModel(steps: readonly ScriptStep[]): ScriptedModel {
  const requests: ChatRequest[] = [];
  let i = 0;
  const provider: ModelProvider = {
    id: 'fake',
    kind: 'openai-compat',
    async *chat(req, signal) {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const step = steps[i];
      i += 1;
      if (step === undefined) {
        yield { type: 'error', message: 'script ended' };
        return;
      }
      if (Array.isArray(step)) {
        for (const c of step) yield c;
        return;
      }
      yield* step(req, signal);
    },
  };
  return { provider, requests };
}

/** 도구 한 번 부르는 걸음 */
export function callStep(name: string, args: Record<string, unknown>, id = 'c1', usage?: { promptTokens: number; completionTokens: number }): ChatChunk[] {
  return [
    { type: 'tool_call', id, name, argumentsJson: JSON.stringify(args) },
    usage ? { type: 'done', finishReason: 'tool_calls', usage } : { type: 'done', finishReason: 'tool_calls' },
  ];
}

/** 답만 하는 걸음 */
export function answerStep(text: string): ChatChunk[] {
  return [
    { type: 'delta', text },
    { type: 'done', finishReason: 'stop' },
  ];
}

/** abort 될 때까지 기다렸다가 done aborted 를 내는 걸음(공급자 약속과 같게) */
export function waitForAbortStep(firstDelta = '...'): ScriptStep {
  return async function* (_req, signal) {
    yield { type: 'delta', text: firstDelta };
    await new Promise<void>((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'done', finishReason: 'aborted' };
  };
}

export interface SpyTool extends AppTool {
  readonly calls: Array<Record<string, unknown>>;
}

/** 불린 인자를 모으는 앱 도구. fail 이면 오류 결과 */
export function spyTool(name: string, opts: { needsApproval?: boolean; fail?: string } = {}): SpyTool {
  const calls: Array<Record<string, unknown>> = [];
  return {
    name,
    description: `spy ${name}`,
    parameters: { type: 'object' },
    ...(opts.needsApproval !== undefined ? { needsApproval: opts.needsApproval } : {}),
    calls,
    run(args) {
      calls.push(args);
      if (opts.fail !== undefined) return { ok: false, error: opts.fail, truncated: false };
      return { ok: true, text: `ran ${name} ${JSON.stringify(args)}`, truncated: false };
    },
  };
}

export interface FakeMcp {
  readonly manager: McpToolSource;
  readonly calls: Array<{ code: string; name: string; args: Record<string, unknown> }>;
}

/** 연결된 서버 하나 · 도구 이름 목록 · 부르면 'ok' */
export function fakeMcp(code: string, toolNames: readonly string[]): FakeMcp {
  const calls: FakeMcp['calls'] = [];
  const rows: McpToolRow[] = toolNames.map((name) => ({
    serverId: `id-${code}`,
    name,
    title: null,
    description: `${name} tool`,
    parameters: { type: 'object' },
    active: true,
    needsApproval: false,
  }));
  return {
    calls,
    manager: {
      listStates: () => [{ code, status: 'connected' }],
      listTools: async () => ({ tools: rows.map((r) => ({ ...r })), warnings: [] }),
      callTool: async (c, name, args): Promise<McpCallResult> => {
        calls.push({ code: c, name, args });
        return { ok: true, text: 'ok', truncated: false, bytes: 2 };
      },
    },
  };
}

export async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

export function lastEvent(events: readonly AgentEvent[]): AgentEvent {
  const e = events[events.length - 1];
  if (!e) throw new Error('no events');
  return e;
}
