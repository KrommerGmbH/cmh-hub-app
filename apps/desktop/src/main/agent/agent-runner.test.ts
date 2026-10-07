import { describe, expect, it } from 'vitest';

import type { GuardPolicy } from '../settings/guard-policy.js';
import type { AgentDoneEvent, AgentEvent } from './agent-events.js';
import { AgentRunner, canonicalJson, guardTargetFor, summarizeArgs } from './agent-runner.js';
import type { AgentToolbox } from './agent-runner.js';
import { InMemoryApprovalGate } from './approval-gate.js';
import {
  answerStep,
  callStep,
  collectEvents,
  fakeMcp,
  lastEvent,
  scriptedModel,
  spyTool,
  waitForAbortStep,
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
    expect(events[0]).toMatchObject({ type: 'tool_call', tool: 'app:echo', step: 1, callId: 'c1' });
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
    expect(events[1]).toMatchObject({ type: 'error', source: 'tool', callId: 'c1', message: 'disk full' });
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
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['a', 'b']);
  });
});

describe('AgentRunner — Guard 와 승인 관문', () => {
  it('Guard deny 면 도구를 부르지 않고 모델에게 «거부됨: <규칙>» 을 돌려준다', async () => {
    const echo = spyTool('echo');
    const policy: GuardPolicy = { defaultMode: 'full', tools: { 'app:echo': 'deny' }, credentials: {} };
    const { runner, model, modelRef } = setup([callStep('app__echo', { text: 'x' }), answerStep('못 했습니다')]);
    const events = await collectEvents(runner.run({ messages: user, model: modelRef, tools: new ToolRouter({ appTools: [echo] }), policy }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_denied', 'delta', 'done']);
    expect(events[1]).toMatchObject({ type: 'tool_denied', reason: 'guard', matchedPattern: 'app:echo' });
    expect(echo.calls).toHaveLength(0);
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '거부됨: app:echo' });
    // 이름만으로 deny 인 도구는 모델 목록에서 빠진다(토큰 절약)
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
      definitions: () => ({ tools: [], dropped: [] }),
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
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ callId: 'x1', reason: 'guard', matchedPattern: 'entity:cmh_ai_approval:*' });
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
    expect(done.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '실행 안 함: run 이 멈춤(max_steps)' });
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
    expect(done.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
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
    expect(summarizeArgs({ user: 'kim', password: 'p', nested: { apiKey: 'k' } })).toBe('{"user":"kim","password":"***","nested":{"apiKey":"***"}}');
  });
  it('guardTargetFor 는 dal_ 도구의 entity 만 꺼내고 글이 아니면 JSON 글로 넘긴다', () => {
    expect(guardTargetFor('mcp:s:dal_update', { entity: 'cmh_ai_approval' })).toEqual({ entity: 'cmh_ai_approval' });
    expect(guardTargetFor('mcp:s:dal_search', { entity: { x: 1 } })).toEqual({ entity: '{"x":1}' });
    expect(guardTargetFor('mcp:s:update', { entity: 'cmh_ai_approval' })).toBeUndefined();
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
