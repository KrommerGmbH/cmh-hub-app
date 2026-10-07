import type { DriverRunResult } from '@cmh-hub-app/driver-core';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeClientDeps, WebSocketLike } from './bridge-client.js';
import { BridgeClient } from './bridge-client.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  triggerError(): void {
    this.onerror?.();
  }
}

describe('BridgeClient', () => {
  function createHarness() {
    const sockets: FakeWebSocket[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];

    const mockRunSteps = vi.fn<(steps: unknown[]) => Promise<DriverRunResult>>().mockResolvedValue({
      ok: true,
      steps: [],
      error: null,
    });

    const deps: BridgeClientDeps = {
      createSocket: (_url: string) => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      runSteps: mockRunSteps,
      extVersion: '0.1.0',
      log: (m: string) => logs.push(m),
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return timers.length;
      },
    };

    const client = new BridgeClient('ws://127.0.0.1:47900', deps);

    return {
      client,
      deps,
      sockets,
      timers,
      logs,
      mockRunSteps,
    };
  }

  it('열림 → hello 전송', () => {
    const { client, sockets } = createHarness();
    client.connect();

    expect(sockets.length).toBe(1);
    const ws = sockets[0]!;
    expect(client.isOpen()).toBe(false);

    ws.triggerOpen();
    expect(client.isOpen()).toBe(true);
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'hello',
      extVersion: '0.1.0',
    });
  });

  it('run → runSteps 호출 · result 송신', async () => {
    const { client, sockets, mockRunSteps } = createHarness();
    mockRunSteps.mockResolvedValueOnce({
      ok: true,
      steps: [{ op: 'goto', ok: true }],
      error: null,
    });

    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();

    const runPayload = JSON.stringify({
      type: 'run',
      id: 'task-100',
      steps: [{ op: 'goto', url: 'https://sell.smartstore.naver.com/' }],
    });
    ws.triggerMessage(runPayload);

    await vi.waitFor(() => {
      expect(mockRunSteps).toHaveBeenCalledWith([
        { op: 'goto', url: 'https://sell.smartstore.naver.com/' },
      ]);
      expect(ws.sent.length).toBe(2);
    });

    expect(JSON.parse(ws.sent[1]!)).toEqual({
      type: 'result',
      id: 'task-100',
      result: {
        ok: true,
        steps: [{ op: 'goto', ok: true }],
        error: null,
      },
    });
  });

  it('runSteps throw → ok false 결과 송신', async () => {
    const { client, sockets, mockRunSteps } = createHarness();
    mockRunSteps.mockRejectedValueOnce(new Error('탭 통신 실패'));

    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();

    ws.triggerMessage(
      JSON.stringify({
        type: 'run',
        id: 'task-err',
        steps: [],
      }),
    );

    await vi.waitFor(() => {
      expect(ws.sent.length).toBe(2);
    });

    expect(JSON.parse(ws.sent[1]!)).toEqual({
      type: 'result',
      id: 'task-err',
      result: {
        ok: false,
        steps: [],
        error: {
          code: 'invalid-step',
          message: '탭 통신 실패',
        },
      },
    });
  });

  it('ping → pong 송신', () => {
    const { client, sockets } = createHarness();
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();

    ws.triggerMessage(JSON.stringify({ type: 'ping' }));
    expect(ws.sent.length).toBe(2);
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: 'pong' });
  });

  it('close → setTimer 가 1000 · 두 번째 close → 2000 · 열림 뒤 다시 1000', () => {
    const { client, sockets, timers } = createHarness();
    client.connect();
    const ws1 = sockets[0]!;

    // 첫 close
    ws1.triggerClose();
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(1000);

    // 타이머 콜백으로 두 번째 연결
    timers[0]!.fn();
    expect(sockets.length).toBe(2);
    const ws2 = sockets[1]!;

    // 두 번째 close
    ws2.triggerClose();
    expect(timers.length).toBe(2);
    expect(timers[1]!.ms).toBe(2000);

    // 타이머 콜백으로 세 번째 연결
    timers[1]!.fn();
    expect(sockets.length).toBe(3);
    const ws3 = sockets[2]!;

    // 열림 발생 → 지연 리셋
    ws3.triggerOpen();
    expect(client.isOpen()).toBe(true);

    // 세 번째 close → 다시 1000ms
    ws3.triggerClose();
    expect(timers.length).toBe(3);
    expect(timers[2]!.ms).toBe(1000);
  });

  it('이미 연결이 열려 있을 때 connect() 를 호출해도 중복 연결하지 않는다', () => {
    const { client, sockets } = createHarness();
    client.connect();
    sockets[0]!.triggerOpen();
    expect(sockets.length).toBe(1);

    client.connect();
    expect(sockets.length).toBe(1);
  });

  it('연결 중에 connect() 두 번 → createSocket 한 번', () => {
    const { client, sockets } = createHarness();
    client.connect();
    expect(sockets.length).toBe(1);

    client.connect();
    expect(sockets.length).toBe(1);
  });

  it('send(): 연결이 열려 있으면 메시지 전송 후 true 반환, 닫혀 있으면 false 반환', () => {
    const { client, sockets } = createHarness();

    // 닫힌 상태
    const closedSent = client.send({ type: 'pong' });
    expect(closedSent).toBe(false);

    // 연결 및 오픈
    client.connect();
    const ws = sockets[0]!;
    ws.triggerOpen();

    const openSent = client.send({
      type: 'context-action',
      intentKey: 'explain_field',
      element: null,
      pageUrl: 'https://sell.smartstore.naver.com/',
      pageTitle: '홈',
    });
    expect(openSent).toBe(true);
    expect(JSON.parse(ws.sent[ws.sent.length - 1]!)).toEqual({
      type: 'context-action',
      intentKey: 'explain_field',
      element: null,
      pageUrl: 'https://sell.smartstore.naver.com/',
      pageTitle: '홈',
    });
  });
});
