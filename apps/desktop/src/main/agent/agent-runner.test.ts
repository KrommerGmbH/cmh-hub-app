import { describe, expect, it } from 'vitest';

import { DAL_WRITE_WITHOUT_TARGET_PATTERN } from '../settings/guard-policy.js';
import type { GuardPolicy } from '../settings/guard-policy.js';
import type { ChatChunk, ChatMessage } from '../models/model-provider.js';
import type { AgentDoneEvent, AgentEvent } from './agent-events.js';
import {
  ARGS_SCAN_MAX_DEPTH,
  ARGS_SCAN_MAX_VALUES,
  AgentRunner,
  canonicalJson,
  evaluateToolCall,
  guardTargetFor,
  summarizeArgs,
} from './agent-runner.js';
import type { AgentLimits, AgentToolbox } from './agent-runner.js';
import { InMemoryApprovalGate } from './approval-gate.js';
import type { ApprovalGate } from './approval-gate.js';
import {
  answerStep,
  callStep,
  collectEvents,
  eventInvariantViolations,
  fakeMcp,
  lastEvent,
  scriptedModel,
  spyTool,
  waitForAbortStep,
  withDeadline,
} from './__tests__/agent-test-support.js';
import type { ScriptStep } from './__tests__/agent-test-support.js';
import { ToolRouter, createEchoTool } from './tool-router.js';
import type { RoutedTool } from './tool-router.js';

const ALLOW: GuardPolicy = { defaultMode: 'full', tools: {}, credentials: {} };
const ASK: GuardPolicy = { defaultMode: 'guard', tools: {}, credentials: {} };

function setup(steps: readonly ScriptStep[], opts: { gateTimeoutMs?: number } = {}) {
  const gate = new InMemoryApprovalGate(opts.gateTimeoutMs !== undefined ? { timeoutMs: opts.gateTimeoutMs } : {});
  const runner = new AgentRunner({ approvalGate: gate, newRunId: () => 'run-1' });
  const model = scriptedModel(steps);
  return { gate, runner, model, modelRef: { provider: model.provider, code: 'fake-model' } };
}

function doneOf(events: readonly AgentEvent[]): AgentDoneEvent {
  const e = lastEvent(events);
  if (e.type !== 'done') throw new Error(`last event is ${e.type}`);
  return e;
}

const user = [{ role: 'user' as const, content: '안녕' }];

describe('AgentRunner — 기본 흐름', () => {
  it('도구 없이 답하면 delta 를 그대로 내고 done final 로 끝난다', async () => {
    const { runner, modelRef } = setup([answerStep('반갑습니다')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter(), policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    const done = doneOf(events);
    expect(done.reason).toBe('final');
    expect(done.messages.at(-1)).toEqual({ role: 'assistant', content: '반갑습니다' });
  });

  it('도구를 한 번 부르면 결과를 role tool 로 붙이고 다음 걸음에서 답한다', async () => {
    const { runner, model, modelRef } = setup([callStep('app__echo', { text: 'hi' }), answerStep('끝')]);
    const tools = new ToolRouter({ appTools: [createEchoTool()] });
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools, policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'delta', 'done']);
    expect(events[0]).toMatchObject({ type: 'tool_call', tool: 'app:echo', step: 1, callId: 'run-1-1-1', toolCallId: 'c1' });
    expect(events[1]).toMatchObject({ type: 'tool_result', ok: true, summary: 'hi' });
    expect(doneOf(events).reason).toBe('final');
    // 첫 요청에 도구 목록(OpenAI function 꼴) · 둘째 요청에 tool 결과
    expect(model.requests[0]?.tools?.map((t) => t.function.name)).toEqual(['app__echo']);
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'hi' });
  });

  it('모델 error 조각이 오면 error 이벤트와 done error 로 끝나고 대화에 오류 글이 남는다', async () => {
    const { runner, modelRef } = setup([[{ type: 'delta', text: '반쯤' }, { type: 'error', message: 'HTTP 500' }]]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter(), policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(events[1]).toMatchObject({ type: 'error', source: 'model', message: 'HTTP 500' });
    const done = doneOf(events);
    expect(done.reason).toBe('error');
    expect(done.messages.at(-1)).toEqual({ role: 'assistant', content: '반쯤\n[오류] HTTP 500' });
  });

  it('공급자가 약속을 어기고 던져도 run 은 던지지 않고 done error 로 끝난다', async () => {
    const { runner } = setup([]);
    const provider = {
      id: 'bad',
      kind: 'openai-compat' as const,
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('boom');
      },
    };
    const events = await collectEvents(runner.run({ messages: user, model: { provider, code: 'm' }, tools: new ToolRouter(), policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(doneOf(events).reason).toBe('error');
  });

  it('도구가 실패하면 error 이벤트 · 대화에 «오류:» 글을 붙이고 다음 걸음으로 간다', async () => {
    const broken = spyTool('broken', { fail: 'disk full' });
    const { runner, model, modelRef } = setup([callStep('app__broken', {}), answerStep('알겠습니다')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [broken] }), policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'error', 'tool_result', 'delta', 'done']);
    expect(events[1]).toMatchObject({ type: 'error', source: 'tool', callId: 'run-1-1-1', message: 'disk full' });
    expect(events[2]).toMatchObject({ type: 'tool_result', ok: false });
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '오류: disk full' });
    expect(doneOf(events).reason).toBe('final');
  });

  it('모르는 도구 · 깨진 인자 JSON 은 도구를 부르지 않고 오류 글로 돌려준다', async () => {
    const echo = spyTool('echo');
    const { runner, model, modelRef } = setup([
      [
        { type: 'tool_call', id: 'a', name: 'nope', argumentsJson: '{}' },
        { type: 'tool_call', id: 'b', name: 'app__echo', argumentsJson: '{bad' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      answerStep('ok'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW }));
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)).toEqual([
      '오류: 모르는 도구 "nope"',
      expect.stringContaining('오류: 인자 JSON 이 잘못됨'),
    ]);
    expect(events.filter((e) => e.type === 'tool_denied').map((e) => (e as { reason: string }).reason)).toEqual(['unknown_tool', 'bad_args']);
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['a', 'b']);
  });
});

describe('AgentRunner — Guard 와 승인 관문', () => {
  it('Guard deny 면 도구를 부르지 않고 모델에게 «거부됨: <규칙>» 을 돌려준다', async () => {
    const write = spyTool('record_update');
    // 이름은 allow — 인자의 entity 로 실제 호출 때 deny(내장 규칙)
    const { runner, model, modelRef } = setup([callStep('app__record_update', { entity: 'cmh_ai_approval' }), answerStep('못 했습니다')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [write] }), policy: ALLOW }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_denied', 'delta', 'done']);
    expect(events[1]).toMatchObject({ type: 'tool_denied', reason: 'guard', matchedPattern: 'entity:cmh_ai_approval:*' });
    expect(write.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '거부됨: entity:cmh_ai_approval:*' });
  });

  it('이름만으로 deny 인 도구는 모델 목록에서 빠지고 · 이름을 알고 불러도 «모르는 도구» 로 닫힌다(보여 준 도구만)', async () => {
    const echo = spyTool('echo');
    const policy: GuardPolicy = { defaultMode: 'full', tools: { 'app:echo': 'deny' }, credentials: {} };
    const { runner, model, modelRef } = setup([callStep('app__echo', { text: 'x' }), answerStep('못 했습니다')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'error', 'tool_denied', 'delta', 'done']);
    expect(events[2]).toMatchObject({ type: 'tool_denied', reason: 'unknown_tool' });
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[0]?.tools).toBeUndefined();
  });

  it('ask 면 승인을 기다리고 사람 UI 가 approved 를 고르면 도구를 부른다', async () => {
    const echo = spyTool('echo');
    const { gate, runner, modelRef } = setup([callStep('app__echo', { text: 'x' }), answerStep('done')]);
    const events: AgentEvent[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ASK })) {
      events.push(e);
      if (e.type === 'approval_required') {
        expect(e.reason).toBe('guard_ask');
        expect(gate.listPending('run-1').map((p) => p.id)).toEqual([e.approvalId]);
        expect(gate.decide(e.approvalId, 'approved', 'human-ui')).toBe(true);
      }
    }
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'approval_required', 'approval_decided', 'tool_result', 'delta', 'done']);
    expect(echo.calls).toEqual([{ text: 'x' }]);
    expect(gate.listPending()).toEqual([]);
  });

  it('ask 에서 사람이 rejected 를 고르면 도구를 부르지 않고 거부 글을 돌려준다', async () => {
    const echo = spyTool('echo');
    const { gate, runner, model, modelRef } = setup([callStep('app__echo', { text: 'x' }), answerStep('done')]);
    const events: AgentEvent[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ASK })) {
      events.push(e);
      if (e.type === 'approval_required') gate.decide(e.approvalId, 'rejected', 'human-ui');
    }
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'approval_required', 'approval_decided', 'tool_denied', 'delta', 'done']);
    expect(events[3]).toMatchObject({ type: 'tool_denied', reason: 'rejected' });
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.at(-1)?.content).toBe('거부됨: 사람이 거절함');
  });

  it('아무도 안 고르면 승인 시간 초과로 거부와 같게 처리한다', async () => {
    const echo = spyTool('echo');
    const { runner, model, modelRef } = setup([callStep('app__echo', { text: 'x' }), answerStep('done')], { gateTimeoutMs: 10 });
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ASK }));
    expect(events.find((e) => e.type === 'approval_decided')).toMatchObject({ decision: 'timeout' });
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'timeout' });
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.at(-1)?.content).toBe('거부됨: 승인 시간 초과');
  });

  it('needsApproval 도구는 allow 정책이어도 승인 관문을 지난다', async () => {
    const save = spyTool('save_draft', { needsApproval: true });
    const { gate, runner, modelRef } = setup([callStep('app__save_draft', { id: 1 }), answerStep('done')]);
    const seen: string[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [save] }), policy: ALLOW })) {
      if (e.type === 'approval_required') {
        seen.push(e.reason);
        gate.decide(e.approvalId, 'approved', 'human-ui');
      }
    }
    expect(seen).toEqual(['requires_approval']);
    expect(save.calls).toHaveLength(1);
  });

  it('마켓 쓰기(market:naver:save)는 allow 정책이어도 승인 관문을 지나고 거절되면 안 불린다', async () => {
    const calls: string[] = [];
    const market: RoutedTool = {
      name: 'market:naver:save',
      modelName: 'market__naver__save',
      source: 'browser',
      description: null,
      parameters: { type: 'object' },
      known: true,
      needsApproval: false,
      available: true,
    };
    const toolbox: AgentToolbox = {
      refresh: async () => ({ errors: [] }),
      definitions: () => ({
        tools: [{ type: 'function', function: { name: market.modelName } }],
        dropped: [],
        byName: new Map([[market.modelName, market], [market.name, market]]),
      }),
      lookup: (n) => (n === market.modelName || n === market.name ? market : null),
      call: async (n) => {
        calls.push(n);
        return { ok: true, text: 'saved', truncated: false };
      },
    };
    const { gate, runner, modelRef } = setup([callStep('market__naver__save', { productId: 7 }), answerStep('done')]);
    const seen: string[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: toolbox, policy: ALLOW })) {
      if (e.type === 'approval_required') {
        seen.push(e.reason);
        gate.decide(e.approvalId, 'rejected', 'human-ui');
      }
    }
    expect(seen).toEqual(['requires_approval']);
    expect(calls).toEqual([]);
  });

  it('dal_update 인자 entity 가 cmh_ai_approval 이면 allow 정책이어도 deny(Guard target)', async () => {
    const mcp = fakeMcp('cmh-shop-api-mcp', ['dal_update']);
    const tools = new ToolRouter({ mcp: { manager: mcp.manager, isKnown: () => true } });
    const policy: GuardPolicy = { defaultMode: 'full', tools: { 'mcp:**': 'allow' }, credentials: {} };
    const { runner, model, modelRef } = setup([
      callStep('mcp__cmh-shop-api-mcp__dal_update', { entity: 'cmh_ai_approval', payload: { decision: 'approved' } }, 'x1'),
      callStep('mcp__cmh-shop-api-mcp__dal_update', { entity: 'product', payload: {} }, 'x2'),
      answerStep('done'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools, policy }));
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ callId: 'run-1-1-1', reason: 'guard', matchedPattern: 'entity:cmh_ai_approval:*' });
    expect(model.requests[1]?.messages.at(-1)?.content).toBe('거부됨: entity:cmh_ai_approval:*');
    // 다른 엔티티는 지나간다 — 막힌 것은 승인 엔티티 하나
    expect(mcp.calls).toEqual([{ code: 'cmh-shop-api-mcp', name: 'dal_update', args: { entity: 'product', payload: {} } }]);
  });

  it('처음 보는 외부 MCP 도구(known false)는 allow 정책이어도 ask 로 승인을 묻는다', async () => {
    const mcp = fakeMcp('ext', ['read_page']);
    const { gate, runner, modelRef } = setup([callStep('mcp__ext__read_page', {}), answerStep('done')]);
    const reasons: string[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ mcp: { manager: mcp.manager } }), policy: ALLOW })) {
      if (e.type === 'approval_required') {
        reasons.push(e.reason);
        gate.decide(e.approvalId, 'approved', 'human-ui');
      }
    }
    expect(reasons).toEqual(['guard_ask']);
    expect(mcp.calls).toHaveLength(1);
  });
});

describe('AgentRunner — 상한과 멈춤', () => {
  it('maxSteps 에 닿으면 남은 도구를 부르지 않고 done max_steps', async () => {
    const echo = spyTool('echo');
    const { runner, modelRef } = setup([callStep('app__echo', { n: 1 }), callStep('app__echo', { n: 2 }), callStep('app__echo', { n: 3 })]);
    const events = await collectEvents(
      runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW, limits: { maxSteps: 2 } }),
    );
    const done = doneOf(events);
    expect(done.reason).toBe('max_steps');
    expect(done.step).toBe(2);
    expect(echo.calls).toEqual([{ n: 1 }]);
    // 답 없는 tool_call 이 남지 않게 «실행 안 함» 으로 닫는다
    // 모델이 둘째 걸음에도 id 'c1' 을 주었으므로 대화 id 는 'c1_2' 로 고유하게 바뀐다
    expect(done.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1_2', content: '실행 안 함: run 이 멈춤(max_steps)' });
  });

  it('usage 합이 maxTotalTokens 에 닿으면 done max_tokens', async () => {
    const echo = spyTool('echo');
    const usage = { promptTokens: 50, completionTokens: 10 };
    const { runner, modelRef } = setup([callStep('app__echo', { n: 1 }, 'c1', usage), callStep('app__echo', { n: 2 }, 'c2', usage)]);
    const events = await collectEvents(
      runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW, limits: { maxTotalTokens: 100 } }),
    );
    const done = doneOf(events);
    expect(done.reason).toBe('max_tokens');
    // 첫 걸음 뒤 60 · 둘째 요청 어림(대화 글자 ÷ 3)을 더하면 100 을 넘어 둘째 모델 호출 전에 멈춘다(사전 검사)
    expect(done.usage).toEqual({ promptTokens: 50, completionTokens: 10 });
    expect(done.step).toBe(1);
    expect(echo.calls).toEqual([{ n: 1 }]);
  });

  it('바깥 signal 로 취소하면 done aborted', async () => {
    const ctrl = new AbortController();
    const { runner, modelRef } = setup([waitForAbortStep('생각 중')]);
    const events: AgentEvent[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter(), policy: ALLOW, signal: ctrl.signal })) {
      events.push(e);
      if (e.type === 'delta') ctrl.abort();
    }
    const done = doneOf(events);
    expect(done.reason).toBe('aborted');
    expect(done.messages.at(-1)).toEqual({ role: 'assistant', content: '생각 중' });
  });

  it('승인을 기다리는 동안 취소하면 대기를 거두고 done aborted', async () => {
    const ctrl = new AbortController();
    const echo = spyTool('echo');
    const { gate, runner, modelRef } = setup([callStep('app__echo', { text: 'x' })]);
    const events: AgentEvent[] = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ASK, signal: ctrl.signal })) {
      events.push(e);
      if (e.type === 'approval_required') ctrl.abort();
    }
    expect(doneOf(events).reason).toBe('aborted');
    expect(events.some((e) => e.type === 'approval_decided')).toBe(false);
    expect(echo.calls).toHaveLength(0);
    expect(gate.listPending()).toEqual([]);
  });

  it('시간 상한을 넘기면 done max_time', async () => {
    const { runner, modelRef } = setup([waitForAbortStep()]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter(), policy: ALLOW, limits: { maxDurationMs: 20 } }));
    expect(doneOf(events).reason).toBe('max_time');
  });

  it('같은 도구 · 같은 인자를 3번 부르면 세 번째는 부르지 않고 done loop_detected', async () => {
    const echo = spyTool('echo');
    const same = { b: 2, a: 1 };
    const { runner, modelRef } = setup([
      callStep('app__echo', same, 'c1'),
      callStep('app__echo', { a: 1, b: 2 }, 'c2'), // 키 차례만 다름 → 같은 호출
      callStep('app__echo', same, 'c3'),
      answerStep('never'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW }));
    expect(doneOf(events).reason).toBe('loop_detected');
    expect(echo.calls).toHaveLength(2);
  });

  it('도구 목록 가져오기가 실패하면 catalog error 이벤트를 내고 run 은 이어 간다', async () => {
    const mcp = fakeMcp('a', ['t']);
    const { runner, modelRef } = setup([answerStep('ok')]);
    const tools = new ToolRouter({ mcp: { manager: mcp.manager, serverCodes: ['a', 'missing'] } });
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools, policy: ALLOW }));
    expect(events[0]).toMatchObject({ type: 'error', source: 'catalog', message: expect.stringContaining('"missing" is not connected') });
    expect(doneOf(events).reason).toBe('final');
  });
});

describe('AgentRunner 도우미', () => {
  it('canonicalJson 은 키 차례와 상관없이 같은 글', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }));
  });
  it('summarizeArgs 는 비밀 같은 키 값을 가린다', () => {
    expect(summarizeArgs({ user: 'kim', password: 'pw', nested: { apiKey: 'k' } })).toBe('{"user":"kim","password":"***(2자)","nested":{"apiKey":"***(1자)"}}');
  });
  it('guardTargetFor 는 이름과 상관없이 entity 를 꺼내고 글이 아니면 JSON 글로 넘긴다', () => {
    expect(guardTargetFor('mcp:s:dal_update', { entity: 'cmh_ai_approval' })).toEqual({ entity: 'cmh_ai_approval' });
    expect(guardTargetFor('mcp:s:dal_search', { entity: { x: 1 } })).toEqual({ entity: '{"x":1}' });
    expect(guardTargetFor('mcp:s:update', { entity: 'cmh_ai_approval' })).toEqual({ entity: 'cmh_ai_approval' });
    expect(guardTargetFor('mcp:s:update', { entityName: 'product' })).toEqual({ entity: 'product' });
    expect(guardTargetFor('mcp:s:dal_update', {})).toBeUndefined();
  });
});

describe('AgentRunner — 시간 상한 값', () => {
  it('maxDurationMs 가 Infinity 면 시간 상한 없이 돈다(setTimeout 1ms 함정)', async () => {
    const gate = new InMemoryApprovalGate();
    const runner = new AgentRunner({ approvalGate: gate });
    const model = scriptedModel([async function* () {
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'delta' as const, text: 'ok' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }]);
    const events = await collectEvents(
      runner.run({ messages: user, model: { provider: model.provider, code: 'm' }, tools: new ToolRouter(), policy: ALLOW, limits: { maxDurationMs: Infinity } }),
    );
    expect(doneOf(events).reason).toBe('final');
  });
});

// ---------------------------------------------------------------- 검수 4(research/10-review-code-ra.md) 차단 · 권고

const KNOWN = { known: true, needsApproval: false } as const;

function multiCallStep(calls: ReadonlyArray<{ id: string; name: string; args: Record<string, unknown> | string }>): ChatChunk[] {
  return [
    ...calls.map((c): ChatChunk => ({ type: 'tool_call', id: c.id, name: c.name, argumentsJson: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) })),
    { type: 'done', finishReason: 'tool_calls' },
  ];
}

describe('검수 4 차단 1 — 승인 엔티티 target', () => {
  it('guardTargetFor: dal_ 아닌 쓰기 도구의 entity cmh_ai_approval 도 deny', async () => {
    const appWrite = spyTool('record_update');
    const mcp = fakeMcp('shop', ['update_record', 'ai_proposal_apply']);
    const tools = new ToolRouter({ appTools: [appWrite], mcp: { manager: mcp.manager, isKnown: () => true } });
    const { runner, modelRef } = setup([
      multiCallStep([
        { id: 'a', name: 'app__record_update', args: { entity: 'cmh_ai_approval', id: 'x', data: { decision: 'approved' } } },
        { id: 'b', name: 'mcp__shop__update_record', args: { entity_name: 'cmh_ai_approval', id: 'x' } },
        { id: 'c', name: 'mcp__shop__ai_proposal_apply', args: { entityName: 'cmhAiApproval', ids: ['x'], value: 'approved' } },
      ]),
      answerStep('done'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools, policy: ALLOW }));
    expect(events.filter((e) => e.type === 'tool_denied').map((e) => [e.reason, e.matchedPattern])).toEqual([
      ['guard', 'entity:cmh_ai_approval:*'],
      ['guard', 'entity:cmh_ai_approval:*'],
      ['guard', 'entity:cmh_ai_approval:*'],
    ]);
    expect(appWrite.calls).toHaveLength(0);
    expect(mcp.calls).toHaveLength(0);
    expect(eventInvariantViolations(events)).toEqual([]);
  });

  it('guardTargetFor: dalUpdate · dal-update · 중첩 operations[].entity', () => {
    const decide = (name: string, args: Record<string, unknown>) => {
      const g = evaluateToolCall(ALLOW, { name, ...KNOWN }, args);
      return `${g.decision}${g.matchedPattern ? ` ${g.matchedPattern}` : ''}`;
    };
    // camelCase · 하이픈 이름도 범용 DAL 로 본다 — target 없으면 deny, 있으면 정상 판단(검수 4 R13)
    expect(decide('mcp:s:dalUpdate', {})).toBe(`deny ${DAL_WRITE_WITHOUT_TARGET_PATTERN}`);
    expect(decide('mcp:s:dalUpdate', { entity: 'product' })).toBe('allow');
    expect(decide('mcp:s:dalUpdate', { entity: 'cmh_ai_approval' })).toBe('deny entity:cmh_ai_approval:*');
    expect(decide('mcp:s:dal-update', { entity: 'product' })).toBe('allow');
    expect(decide('mcp:s:dal-update', {})).toBe(`deny ${DAL_WRITE_WITHOUT_TARGET_PATTERN}`);
    expect(decide('mcp:s:DAL_UPDATE', { entityName: 'cmhAiApproval' })).toBe('deny entity:cmh_ai_approval:*');
    // 읽기 꼴 DAL 은 target 없이도 · 승인 엔티티를 읽어도 지나간다
    expect(decide('mcp:s:dalSearch', {})).toBe('allow');
    expect(decide('mcp:s:dal_search', { entity: 'cmh_ai_approval' })).toBe('allow');
    // 중첩 operations[].entity · 객체 키 · 다른 칸 이름에 숨긴 값
    expect(decide('mcp:s:batch', { operations: [{ entity: 'product' }, { entity: 'cmh_ai_approval', payload: {} }] })).toBe('deny entity:cmh_ai_approval:*');
    expect(decide('mcp:s:dal_update', { entity: 'product', payload: { cmh_ai_approval: { decision: 'approved' } } })).toBe('deny entity:cmh_ai_approval:*');
    expect(decide('app:sync', { target: { table: 'cmh.ai.approval' } })).toBe('deny entity:cmh_ai_approval:*');
    // 다 못 훑으면(깊이 · 값 수 상한) 막는 쪽
    let deep: Record<string, unknown> = { x: 'cmh_ai_approval' };
    for (let i = 0; i < ARGS_SCAN_MAX_DEPTH + 1; i += 1) deep = { d: deep };
    expect(guardTargetFor('mcp:s:t', deep)?.entity).toBe('?args-scan-limit');
    expect(evaluateToolCall(ALLOW, { name: 'mcp:s:t', ...KNOWN }, deep)).toMatchObject({ decision: 'deny', matchedPattern: 'builtin:args-scan-limit' });
    const many = { list: Array.from({ length: ARGS_SCAN_MAX_VALUES + 1 }, (_, i) => `v${i}`) };
    expect(evaluateToolCall(ALLOW, { name: 'mcp:s:t', ...KNOWN }, many).decision).toBe('deny');
    // 평범한 인자는 그대로
    expect(decide('app:echo', { text: 'hello', n: 1 })).toBe('allow');
  });
});

describe('검수 4 차단 2 — 승인에는 인자 전문', () => {
  it('승인 요청에는 500자 뒤 · 가린 키에 숨긴 값까지 실린다', async () => {
    const mcp = fakeMcp('shop', ['dal_update']);
    const tools = new ToolRouter({ mcp: { manager: mcp.manager } }); // known false → ask
    const args = { note: 'x'.repeat(520), entity: 'product', id: 'p1', data: { price: 0 }, sql_token: 'DELETE FROM product' };
    const { gate, runner, modelRef } = setup([callStep('mcp__shop__dal_update', args), answerStep('ok')]);
    const required: Array<Extract<AgentEvent, { type: 'approval_required' }>> = [];
    for await (const e of runner.run({ messages: user, model: modelRef, tools, policy: ASK })) {
      if (e.type === 'approval_required') {
        required.push(e);
        const pending = gate.listPending()[0];
        expect(pending?.argsFull).toBe(e.argsFull);
        expect(pending?.maskedKeys).toEqual(['sql_token']);
        expect(pending?.expiresAt).toBe(e.expiresAt);
        gate.decide(e.approvalId, 'approved', 'human-ui');
      }
    }
    const e = required[0];
    expect(e).toBeDefined();
    if (!e) return;
    // 도구 줄 요약은 자르고 가린다
    expect(e.argsSummary).not.toContain('price');
    expect(summarizeArgs({ sql_token: 'DELETE FROM product' })).toBe('{"sql_token":"***(19자)"}');
    // 승인 화면 전문은 자르지도 가리지도 않는다 — 실행되는 인자와 같다
    expect(JSON.parse(e.argsFull)).toEqual(args);
    expect(e.argsFull).toContain('"price":0');
    expect(e.argsFull).toContain('DELETE FROM product');
    expect(e.maskedKeys).toEqual(['sql_token']);
    expect(mcp.calls[0]?.args).toEqual(args);
  });

  it('인자 전문이 256KB 를 넘으면 승인을 열지 않고 «사람이 확인할 수 없음» 으로 deny', async () => {
    const save = spyTool('save', { needsApproval: true });
    const big = { text: '가'.repeat(100_000) }; // 10만 자 · UTF-8 30만 바이트
    const { gate, runner, model, modelRef } = setup([callStep('app__save', big), answerStep('ok')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [save] }), policy: ALLOW }));
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'args_too_large' });
    expect(model.requests[1]?.messages.at(-1)?.content).toBe('거부됨: 인자가 너무 커 사람이 확인할 수 없음');
    expect(save.calls).toHaveLength(0);
    expect(gate.listPending()).toEqual([]);
  });
});

describe('검수 4 차단 3 — 이벤트 callId', () => {
  it('모델이 같은 call id 를 두 번 주어도 이벤트 callId 는 고유', async () => {
    const echo = spyTool('echo');
    const history: ChatMessage[] = [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'app__echo', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'x' },
      { role: 'user', content: 'again' },
    ];
    const { runner, modelRef } = setup([
      multiCallStep([
        { id: 'same', name: 'app__echo', args: { a: 1 } },
        { id: 'same', name: 'app__echo', args: { a: 2 } },
      ]),
      multiCallStep([
        { id: 'same', name: 'app__echo', args: { a: 3 } },
        { id: 'old', name: 'app__echo', args: { a: 4 } },
        { id: '', name: 'app__echo', args: { a: 5 } },
      ]),
      answerStep('ok'),
    ]);
    const events = await collectEvents(runner.run({ messages: history, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW }));
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.map((e) => e.callId)).toEqual(['run-1-1-1', 'run-1-1-2', 'run-1-2-1', 'run-1-2-2', 'run-1-2-3']);
    expect(toolCalls.map((e) => e.toolCallId)).toEqual(['same', 'same_2', 'same_3', 'old_2', 'call_2_3']);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.callId)).toEqual(toolCalls.map((e) => e.callId));
    expect(eventInvariantViolations(events)).toEqual([]);
  });
});

describe('검수 4 차단 4 — 목록 필터 listing', () => {
  it('definitions filter 는 listing:true 로 평가해 dal_update 를 모델에게 보인다', async () => {
    const mcp = fakeMcp('shop', ['dal_update', 'dal_search']);
    const tools = new ToolRouter({ mcp: { manager: mcp.manager, isKnown: () => true } });
    const { runner, model, modelRef } = setup([callStep('mcp__shop__dal_update', { id: 'p1', data: {} }), answerStep('ok')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools, policy: ALLOW }));
    expect(model.requests[0]?.tools?.map((t) => t.function.name)).toEqual(['mcp__shop__dal_update', 'mcp__shop__dal_search']);
    // 실제 호출 때 target 이 없으면 여전히 deny
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'guard', matchedPattern: DAL_WRITE_WITHOUT_TARGET_PATTERN });
    expect(mcp.calls).toHaveLength(0);
  });
});

describe('검수 4 권고 — 멈춤 · 닫기 · 상한', () => {
  it('도구 · 관문이 signal 을 무시해도 max_time · 취소에 done 이 난다', async () => {
    const hang: AgentToolbox = {
      refresh: async () => ({ errors: [] }),
      definitions: () => ({ tools: [{ type: 'function', function: { name: 'app__slow' } }], dropped: [], byName: new Map([['app__slow', slowTool]]) }),
      lookup: () => slowTool,
      call: () => new Promise(() => undefined), // signal 을 따르지 않는 도구
    };
    // ①도구가 멈춰 있어도 max_time
    const r1 = setup([callStep('app__slow', {}), answerStep('x')]);
    const t1 = await withDeadline(collectEvents(r1.runner.run({ messages: user, model: r1.modelRef, tools: hang, policy: ALLOW, limits: { maxDurationMs: 30 } })), 1_000);
    expect(t1).not.toBe('HANG');
    if (t1 !== 'HANG') {
      expect(doneOf(t1).reason).toBe('max_time');
      expect(t1.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'stopped' });
      expect(eventInvariantViolations(t1)).toEqual([]);
    }
    // ②관문이 signal 을 따르지 않고 decision 이 영원히 안 풀려도 max_time
    const deafGate: ApprovalGate = {
      open: async () => ({ id: 'g1', decision: new Promise(() => undefined) }),
      requestApproval: () => new Promise(() => undefined),
    };
    const runner2 = new AgentRunner({ approvalGate: deafGate, newRunId: () => 'run-2' });
    const m2 = scriptedModel([callStep('app__slow', {})]);
    const t2 = await withDeadline(
      collectEvents(runner2.run({ messages: user, model: { provider: m2.provider, code: 'm' }, tools: hang, policy: ASK, limits: { maxDurationMs: 30 } })),
      1_000,
    );
    expect(t2 === 'HANG' ? 'HANG' : doneOf(t2).reason).toBe('max_time');
    // ③바깥 취소도 같다(도구가 멈춰 있음)
    const ctrl = new AbortController();
    const r3 = setup([callStep('app__slow', {})]);
    const p3 = collectEvents(r3.runner.run({ messages: user, model: r3.modelRef, tools: hang, policy: ALLOW, signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 20);
    const t3 = await withDeadline(p3, 1_000);
    expect(t3 === 'HANG' ? 'HANG' : doneOf(t3).reason).toBe('aborted');
    // ④모델 스트림이 signal 을 따르지 않아도 max_time
    const deafModel = scriptedModel([
      async function* () {
        yield { type: 'delta' as const, text: '...' };
        await new Promise(() => undefined);
      },
    ]);
    const t4 = await withDeadline(
      collectEvents(r1.runner.run({ messages: user, model: { provider: deafModel.provider, code: 'm' }, tools: new ToolRouter(), policy: ALLOW, limits: { maxDurationMs: 30 } })),
      1_000,
    );
    expect(t4 === 'HANG' ? 'HANG' : doneOf(t4).reason).toBe('max_time');
  });

  it('관문 decision 이 reject 되면 남은 tool_call 을 닫고 done error', async () => {
    const echo = spyTool('echo');
    const brokenGate: ApprovalGate = {
      open: async () => ({ id: 'g1', decision: Promise.reject(new Error('db down')) }),
      requestApproval: async () => 'rejected',
    };
    const runner = new AgentRunner({ approvalGate: brokenGate, newRunId: () => 'run-1' });
    const model = scriptedModel([
      multiCallStep([
        { id: 'c1', name: 'app__echo', args: {} },
        { id: 'c2', name: 'app__echo', args: { b: 1 } },
      ]),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: { provider: model.provider, code: 'm' }, tools: new ToolRouter({ appTools: [echo] }), policy: ASK }));
    const done = doneOf(events);
    expect(done.reason).toBe('error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ source: 'runner', message: 'db down' });
    expect(done.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content])).toEqual([
      ['c1', '실행 안 함: run 이 멈춤(error)'],
      ['c2', '실행 안 함: run 이 멈춤(error)'],
    ]);
    expect(echo.calls).toHaveLength(0);
    expect(eventInvariantViolations(events)).toEqual([]);
  });

  it('refresh 뒤에도 모델 이름은 같은 도구를 가리킨다', async () => {
    let order = ['a.b', 'a_b'];
    const calls: string[] = [];
    const manager = {
      listStates: () => [{ code: 's', status: 'connected' as const }],
      listTools: async () => ({
        tools: order.map((name) => ({ serverId: 's', name, title: null, description: name, parameters: {}, active: true as const, needsApproval: false })),
        warnings: [],
      }),
      callTool: async (_c: string, name: string) => {
        calls.push(name);
        return { ok: true as const, text: 'ok', truncated: false, bytes: 2 };
      },
    };
    const router = new ToolRouter({ mcp: { manager, isKnown: () => true } });
    const { runner, modelRef } = setup([
      async function* () {
        // run 도중 다른 쪽이 같은 라우터를 refresh(등록 차례가 바뀜)
        order = ['a_b', 'a.b'];
        await router.refresh();
        yield* multiCallStep([{ id: 'c1', name: 'mcp__s__a_b', args: {} }]);
      },
      answerStep('ok'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: router, policy: ALLOW }));
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ tool: 'mcp:s:a.b' });
    expect(calls).toEqual(['a.b']);
    // 라우터의 이름 매기기도 등록 차례와 상관없다
    expect(router.lookup('mcp__s__a_b')?.name).toBe('mcp:s:a.b');
    expect(router.lookup('mcp__s__a_b_2')?.name).toBe('mcp:s:a_b');
  });

  it('상한으로 모델 목록에서 빠진 도구는 이름을 알아도 불리지 않는다', async () => {
    const a = spyTool('a');
    const b = spyTool('b');
    const { runner, modelRef } = setup([callStep('app__b', {}), answerStep('ok')]);
    const events = await collectEvents(
      runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [a, b] }), policy: ALLOW, limits: { maxTools: 1 } }),
    );
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'unknown_tool' });
    expect(b.calls).toHaveLength(0);
  });

  it('한 걸음 tool_call 수 상한 — 넘는 호출은 «실행 안 함» 으로 닫는다', async () => {
    const echo = spyTool('echo');
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: 'app__echo', args: { i } }));
    const { runner, model, modelRef } = setup([multiCallStep(many), answerStep('ok')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW }));
    expect(echo.calls).toHaveLength(8);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(8);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ source: 'runner', message: '한 걸음 도구 호출 상한 8 — 12개 실행 안 함' });
    const toolMsgs = model.requests[1]?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(toolMsgs).toHaveLength(20);
    expect(toolMsgs.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c19', content: '실행 안 함: 한 걸음 도구 호출 상한(8) 넘음' });
    expect(eventInvariantViolations(events)).toEqual([]);
  });

  it('usage 없는 공급자에서 maxTotalTokens — 글자 어림으로 세고 · 첫 요청이 이미 크면 모델을 부르지 않는다', async () => {
    const echo = spyTool('echo');
    // usage 를 안 주는 걸음(callStep 은 usage 없이 done)
    const { runner, model, modelRef } = setup([callStep('app__echo', { t: 'x'.repeat(600) }, 'c1'), callStep('app__echo', { t: 'y' }, 'c2'), answerStep('ok')]);
    const events = await collectEvents(
      runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW, limits: { maxTotalTokens: 400 } }),
    );
    expect(doneOf(events).reason).toBe('max_tokens');
    expect(model.requests).toHaveLength(1);
    const big = setup([answerStep('never')]);
    const huge: ChatMessage[] = [{ role: 'user', content: 'z'.repeat(9_000) }];
    const ev2 = await collectEvents(big.runner.run({ messages: huge, model: big.modelRef, tools: new ToolRouter(), policy: ALLOW, limits: { maxTotalTokens: 1_000 } }));
    expect(doneOf(ev2)).toMatchObject({ reason: 'max_tokens', step: 0 });
    expect(big.model.requests).toHaveLength(0);
  });

  it('인자 글 · 오류 글 상한', async () => {
    const echo = spyTool('echo');
    const { runner, modelRef } = setup([
      callStep('app__echo', { t: 'x'.repeat(200) }),
      [{ type: 'error', message: 'E'.repeat(10_000) }],
    ]);
    const events = await collectEvents(
      runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW, limits: { maxToolArgsChars: 100 } }),
    );
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ reason: 'bad_args' });
    expect(echo.calls).toHaveLength(0);
    const done = doneOf(events);
    const ref = done.messages.find((m) => m.tool_calls)?.tool_calls?.[0];
    expect(JSON.parse(ref?.function.arguments ?? '')).toEqual({ _omitted: '208자 인자 생략(상한 넘음)' });
    const modelErr = events.find((e) => e.type === 'error' && e.source === 'model');
    expect(modelErr && modelErr.type === 'error' ? modelErr.message.length : 0).toBeLessThan(2_100);
  });

  it('되풀이: 키 차례만 다른 인자 · 1 과 1.0 — 멈춘 호출도 tool_denied loop 로 닫는다', async () => {
    const echo = spyTool('echo');
    const { runner, modelRef } = setup([
      multiCallStep([{ id: 'a', name: 'app__echo', args: '{"x":1,"y":2}' }]),
      multiCallStep([{ id: 'b', name: 'app__echo', args: '{"y":2,"x":1}' }]),
      multiCallStep([{ id: 'c', name: 'app__echo', args: '{ "y" : 2 , "x" : 1.0 }' }]),
      answerStep('never'),
    ]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy: ALLOW }));
    expect(doneOf(events).reason).toBe('loop_detected');
    expect(events.at(-2)).toMatchObject({ type: 'tool_denied', reason: 'loop', callId: 'run-1-3-1' });
    expect(echo.calls).toHaveLength(2);
    expect(eventInvariantViolations(events)).toEqual([]);
  });

  it('for-await 를 approval_required 에서 끊으면 대기 0', async () => {
    const { gate, runner, modelRef } = setup([callStep('app__echo', {})]);
    for await (const e of runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [createEchoTool()] }), policy: ASK })) {
      if (e.type === 'approval_required') break;
    }
    expect(gate.listPending()).toEqual([]);
  });

  it('runner 는 받은 관문의 decide 에 닿지 못한다(restrictGate)', () => {
    const gate = new InMemoryApprovalGate();
    const runner = new AgentRunner({ approvalGate: gate });
    const held = (runner as unknown as { approvalGate: Record<string, unknown> }).approvalGate;
    expect(held).not.toBe(gate);
    expect(Object.keys(held).sort()).toEqual(['open', 'requestApproval']);
    expect('decide' in held).toBe(false);
  });
});

const slowTool: RoutedTool = {
  name: 'app:slow',
  modelName: 'app__slow',
  source: 'app',
  description: null,
  parameters: { type: 'object' },
  known: true,
  needsApproval: false,
  available: true,
};

describe('검수 4 — 모든 tool_call 이벤트에 닫는 이벤트가 하나 · done 은 모든 길에서 정확히 한 번', () => {
  type Scenario = {
    name: string;
    steps: Parameters<typeof scriptedModel>[0];
    policy?: GuardPolicy;
    limits?: Partial<AgentLimits>;
    gateTimeoutMs?: number;
    onApproval?: 'approved' | 'rejected' | 'abort' | 'none';
    tools?: () => AgentToolbox;
  };
  const echoRouter = () => new ToolRouter({ appTools: [createEchoTool(), spyTool('broken', { fail: 'x' })] });
  const scenarios: Scenario[] = [
    { name: 'final', steps: [answerStep('hi')] },
    { name: 'tool ok', steps: [callStep('app__echo', { text: 'a' }), answerStep('ok')] },
    { name: 'tool fail', steps: [callStep('app__broken', {}), answerStep('ok')] },
    { name: 'unknown + bad args', steps: [multiCallStep([{ id: 'a', name: 'nope', args: {} }, { id: 'b', name: 'app__echo', args: '{bad' }]), answerStep('ok')] },
    { name: 'guard deny', steps: [callStep('app__echo', { entity: 'cmh_ai_approval' }), answerStep('ok')] },
    { name: 'approve', steps: [callStep('app__echo', { text: 'a' }), answerStep('ok')], policy: ASK, onApproval: 'approved' },
    { name: 'reject', steps: [callStep('app__echo', { text: 'a' }), answerStep('ok')], policy: ASK, onApproval: 'rejected' },
    { name: 'approval timeout', steps: [callStep('app__echo', { text: 'a' }), answerStep('ok')], policy: ASK, gateTimeoutMs: 5, onApproval: 'none' },
    { name: 'abort at approval', steps: [multiCallStep([{ id: 'a', name: 'app__echo', args: {} }, { id: 'b', name: 'app__echo', args: { b: 1 } }])], policy: ASK, onApproval: 'abort' },
    { name: 'max_steps', steps: [callStep('app__echo', { n: 1 }), callStep('app__echo', { n: 2 })], limits: { maxSteps: 2 } },
    { name: 'loop', steps: [callStep('app__echo', { n: 1 }, 'a'), callStep('app__echo', { n: 1 }, 'b'), callStep('app__echo', { n: 1 }, 'c')] },
    { name: 'model error', steps: [[{ type: 'error', message: 'boom' }]] },
    { name: 'call limit', steps: [multiCallStep(Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, name: 'app__echo', args: { i } }))), answerStep('ok')], limits: { maxToolCallsPerStep: 2 } },
    {
      name: 'tool hang → max_time',
      steps: [callStep('app__slow', {})],
      limits: { maxDurationMs: 20 },
      tools: () => ({
        refresh: async () => ({ errors: [] }),
        definitions: () => ({ tools: [{ type: 'function', function: { name: 'app__slow' } }], dropped: [], byName: new Map([['app__slow', slowTool]]) }),
        lookup: () => slowTool,
        call: () => new Promise(() => undefined),
      }),
    },
  ];
  for (const sc of scenarios) {
    it(sc.name, async () => {
      const { gate, runner, modelRef } = setup(sc.steps, sc.gateTimeoutMs !== undefined ? { gateTimeoutMs: sc.gateTimeoutMs } : {});
      const ctrl = new AbortController();
      const events: AgentEvent[] = [];
      const run = runner.run({
        messages: user,
        model: modelRef,
        tools: sc.tools ? sc.tools() : echoRouter(),
        policy: sc.policy ?? ALLOW,
        signal: ctrl.signal,
        ...(sc.limits ? { limits: sc.limits } : {}),
      });
      const all = (async () => {
        for await (const e of run) {
          events.push(e);
          if (e.type === 'approval_required') {
            if (sc.onApproval === 'approved' || sc.onApproval === 'rejected') gate.decide(e.approvalId, sc.onApproval, 'human-ui');
            if (sc.onApproval === 'abort') ctrl.abort();
          }
        }
      })();
      expect(await withDeadline(all, 2_000)).not.toBe('HANG');
      expect(eventInvariantViolations(events)).toEqual([]);
    });
  }
});
