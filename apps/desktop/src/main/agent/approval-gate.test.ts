import { describe, expect, it } from 'vitest';

import { APPROVAL_ARGS_MAX_BYTES, InMemoryApprovalGate, restrictGate } from './approval-gate.js';
import type { ApprovalRequest } from './approval-gate.js';

const req: ApprovalRequest = { runId: 'r', tool: 'app:echo', argsSummary: '{}', argsFull: '{}', maskedKeys: [], reason: 'guard_ask' };

describe('InMemoryApprovalGate', () => {
  it('사람 UI 의 결정이 기다리던 약속을 푼다', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'a1' });
    const pending = gate.requestApproval(req);
    expect(gate.listPending().map((p) => p.id)).toEqual(['a1']);
    expect(gate.decide('a1', 'approved', 'human-ui')).toBe(true);
    await expect(pending).resolves.toBe('approved');
    expect(gate.listPending()).toEqual([]);
  });

  it('actor 가 human-ui 가 아니면 예외 — 승인 상태 쓰기는 main UI IPC 만(합의안 5)', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'a1' });
    void gate.requestApproval(req);
    expect(() => gate.decide('a1', 'approved', 'agent' as never)).toThrow(/only the human UI IPC/);
    // 예외 뒤에도 대기는 그대로(에이전트가 결정을 못 바꿨다)
    expect(gate.listPending()).toHaveLength(1);
    gate.decide('a1', 'rejected', 'human-ui');
  });

  it('모르는 결정 값은 예외 · 없는 id 나 이미 정해진 id 는 false', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'a1' });
    const pending = gate.requestApproval(req);
    expect(() => gate.decide('a1', 'timeout' as never, 'human-ui')).toThrow(/unknown decision/);
    expect(gate.decide('nope', 'approved', 'human-ui')).toBe(false);
    gate.decide('a1', 'rejected', 'human-ui');
    expect(gate.decide('a1', 'approved', 'human-ui')).toBe(false);
    await expect(pending).resolves.toBe('rejected');
  });

  it('시간 안에 안 고르면 timeout', async () => {
    const gate = new InMemoryApprovalGate({ timeoutMs: 5 });
    await expect(gate.requestApproval(req)).resolves.toBe('timeout');
    expect(gate.listPending()).toEqual([]);
  });

  it('signal 이 끊기면 대기를 거두고 rejected(사람이 승인하지 않았으므로)', async () => {
    const gate = new InMemoryApprovalGate();
    const ctrl = new AbortController();
    const pending = gate.requestApproval({ ...req, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).resolves.toBe('rejected');
    expect(gate.listPending()).toEqual([]);
  });

  it('InMemoryApprovalGate: 같은 id 를 두 번 열면 예외(앞 대기를 덮어쓰지 않는다)', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'dup', timeoutMs: 30 });
    const first = await gate.open(req);
    await expect(gate.open({ ...req, runId: 'other' })).rejects.toThrow(/duplicate approval id/);
    expect(gate.listPending().map((p) => p.runId)).toEqual(['r']);
    await expect(first.decision).resolves.toBe('timeout');
  });

  it('인자 전문이 256KB 를 넘으면 열지 않는다 · 대기 행에 전문 · 가린 키 · 만료 시각이 실린다', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'a1', now: () => 1_000, timeoutMs: 60_000 });
    await expect(gate.open({ ...req, argsFull: 'x'.repeat(APPROVAL_ARGS_MAX_BYTES + 1) })).rejects.toThrow(/cannot review/);
    const t = await gate.open({ ...req, argsFull: '{"password":"p"}', maskedKeys: ['password'], matchedPattern: 'mcp:**' });
    expect(t.expiresAt).toBe(61_000);
    expect(gate.listPending()[0]).toMatchObject({ argsFull: '{"password":"p"}', maskedKeys: ['password'], matchedPattern: 'mcp:**', createdAt: 1_000, expiresAt: 61_000 });
    gate.decide('a1', 'rejected', 'human-ui');
  });

  it('restrictGate 는 open · requestApproval 만 담는다(decide 에 닿지 못함)', async () => {
    const gate = new InMemoryApprovalGate({ newId: () => 'a1' });
    const thin = restrictGate(gate);
    expect(Object.keys(thin).sort()).toEqual(['open', 'requestApproval']);
    expect('decide' in thin).toBe(false);
    expect(Object.isFrozen(thin)).toBe(true);
    const pending = thin.requestApproval(req);
    expect(gate.decide('a1', 'approved', 'human-ui')).toBe(true);
    await expect(pending).resolves.toBe('approved');
  });
});
