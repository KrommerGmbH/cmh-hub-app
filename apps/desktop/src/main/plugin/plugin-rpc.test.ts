import { describe, expect, it } from 'vitest';
import { RPC_ERROR, RpcEndpoint, type RpcMessage } from './plugin-rpc.js';

describe('RpcEndpoint — 상대가 보낸 글 상한', () => {
  it('동시 요청 상한을 넘으면 tooManyRequests 로 바로 답한다 · 끝난 자리는 다시 쓴다', async () => {
    const sent: RpcMessage[] = [];
    const gates: Array<() => void> = [];
    const ep = new RpcEndpoint({
      send: (m) => sent.push(m),
      methods: { slow: () => new Promise<string>((resolve) => gates.push(() => resolve('ok'))) },
      maxConcurrentIncoming: 2,
    });
    for (const id of [1, 2, 3]) ep.handleMessage({ jsonrpc: '2.0', id, method: 'slow' });
    await Promise.resolve();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 3, error: { code: RPC_ERROR.tooManyRequests, message: 'too many concurrent requests (limit 2)' } }]);
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' });
    ep.handleMessage({ jsonrpc: '2.0', id: 4, method: 'slow' });
    await Promise.resolve();
    expect(gates).toHaveLength(2); // 4 는 받아들였다
  });

  it('글 한 통 바이트 상한 — 요청이면 Invalid Request 로 답 · 알림이면 버림', async () => {
    const sent: RpcMessage[] = [];
    const errors: string[] = [];
    const calls: unknown[] = [];
    const ep = new RpcEndpoint({ send: (m) => sent.push(m), methods: { log: (p) => calls.push(p) }, maxMessageBytes: 100, onProtocolError: (m) => errors.push(m) });
    const big = 'x'.repeat(200);
    ep.handleMessage({ jsonrpc: '2.0', id: 1, method: 'log', params: big });
    ep.handleMessage({ jsonrpc: '2.0', method: 'log', params: big });
    ep.handleMessage({ jsonrpc: '2.0', method: 'log', params: 'small' });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: RPC_ERROR.invalidRequest, message: 'message larger than 100 bytes' } }]);
    expect(errors).toEqual(['dropped message larger than 100 bytes', 'dropped message larger than 100 bytes']);
    expect(calls).toEqual(['small']);
  });

  it('acceptsNotification — 알림으로 받을 메서드만 부르고 나머지 알림은 버린다(요청은 그대로 · 검수 8 🟢8)', async () => {
    const sent: RpcMessage[] = [];
    const errors: string[] = [];
    const calls: string[] = [];
    const ep = new RpcEndpoint({
      send: (m) => sent.push(m),
      methods: { log: () => { calls.push('log'); }, 'host:data.upsert': () => { calls.push('upsert'); return null; } },
      maxConcurrentIncoming: 2,
      acceptsNotification: (m) => m === 'log',
      onProtocolError: (m) => errors.push(m),
    });
    for (let i = 0; i < 5; i += 1) ep.handleMessage({ jsonrpc: '2.0', method: 'host:data.upsert', params: { entity: 'x', rows: [] } });
    // 동기 log 알림은 한 번에 몰려 와도(동시 상한 2 보다 많이) 버리지 않는다
    for (let i = 0; i < 5; i += 1) ep.handleMessage({ jsonrpc: '2.0', method: 'log' });
    ep.handleMessage({ jsonrpc: '2.0', id: 1, method: 'host:data.upsert' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['log', 'log', 'log', 'log', 'log', 'upsert']);
    expect(errors).toEqual(Array.from({ length: 5 }, () => 'dropped notification "host:data.upsert": this method must be called as a request (with id)'));
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, result: null }]);
  });

  it('시간초과 뒤 늦게 온 답은 버린다(pending 0)', async () => {
    const errors: string[] = [];
    const ep = new RpcEndpoint({ send: () => undefined, methods: {}, defaultTimeoutMs: 20, onProtocolError: (m) => errors.push(m) });
    await expect(ep.request('slow')).rejects.toMatchObject({ code: RPC_ERROR.timeout });
    ep.handleMessage({ jsonrpc: '2.0', id: 1, result: 'late' });
    expect(errors).toEqual(['response for unknown id 1 dropped']);
    expect(ep.pendingCount).toBe(0);
  });
});
