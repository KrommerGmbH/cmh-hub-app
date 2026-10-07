import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { isAllowedOrigin, ExtensionBridge } from './extension-bridge.js';

describe('isAllowedOrigin', () => {
  const allowed = ['njdfehbchcmplpbjddcjopbceieajona', 'test-ext-id'];

  it('허용 id origin → true', () => {
    expect(isAllowedOrigin('chrome-extension://njdfehbchcmplpbjddcjopbceieajona', allowed)).toBe(true);
    expect(isAllowedOrigin('chrome-extension://test-ext-id', allowed)).toBe(true);
  });

  it('다른 id origin → false', () => {
    expect(isAllowedOrigin('chrome-extension://unknown-extension-id', allowed)).toBe(false);
  });

  it('웹 origin → false', () => {
    expect(isAllowedOrigin('https://sell.smartstore.naver.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:47900', allowed)).toBe(false);
  });

  it('undefined origin → false', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
});

describe('ExtensionBridge WebSocket', () => {
  const allowedId = 'njdfehbchcmplpbjddcjopbceieajona';
  const allowedOrigin = `chrome-extension://${allowedId}`;

  function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      import('node:net').then(({ createServer }) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          if (addr && typeof addr === 'object') {
            const port = addr.port;
            srv.close(() => resolve(port));
          } else {
            srv.close(() => reject(new Error('no port')));
          }
        });
      });
    });
  }

  it('허용 Origin → 연결 · hello 뒤 isConnected 참', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      expect(bridge.isConnected()).toBe(false);

      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          client.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client.on('error', reject);
        bridge.waitForConnection(2000).then((connected) => {
          if (connected) resolve();
          else reject(new Error('timeout waiting for connection'));
        });
      });

      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getExtVersion()).toBe('1.0.0');

      client.close();
    } finally {
      bridge.stop();
    }
  });

  it('run → 가짜 확장이 result 를 돌려주면 풀림', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          client.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'run') {
            client.send(
              JSON.stringify({
                type: 'result',
                id: msg.id,
                result: {
                  ok: true,
                  steps: [{ op: 'read', ok: true, value: '확인된 제목' }],
                  error: null,
                },
              }),
            );
          }
        });
        client.on('error', reject);
        bridge.waitForConnection(2000).then((ok) => {
          if (ok) resolve();
          else reject(new Error('not connected'));
        });
      });

      const res = await bridge.run([{ op: 'read', selector: 'h1' }], 2000);
      expect(res.ok).toBe(true);
      expect(res.steps).toEqual([{ op: 'read', ok: true, value: '확인된 제목' }]);
      expect(res.error).toBeNull();

      client.close();
    } finally {
      bridge.stop();
    }
  });

  it('다른 Origin → 거절(연결 오류)', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: 'chrome-extension://unauthorized-extension-id',
      });

      const rejected = await new Promise<boolean>((resolve) => {
        client.on('unexpected-response', (_req, res) => {
          if (res.statusCode === 403 || res.statusCode === 401 || res.statusCode === 400) {
            resolve(true);
          }
        });
        client.on('error', () => {
          resolve(true);
        });
        client.on('open', () => {
          resolve(false);
        });
      });

      expect(rejected).toBe(true);
      expect(bridge.isConnected()).toBe(false);
      client.close();
    } finally {
      bridge.stop();
    }
  });

  it('응답 없으면 timeout(짧은 timeoutMs)', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          client.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client.on('error', reject);
        bridge.waitForConnection(2000).then((ok) => {
          if (ok) resolve();
          else reject(new Error('not connected'));
        });
      });

      const res = await bridge.run([{ op: 'wait', ms: 500 }], 50);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('timeout');

      client.close();
    } finally {
      bridge.stop();
    }
  });

  it('끊기면 extension-disconnected', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          client.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'run') {
            // 응답하지 않고 바로 끊음
            client.terminate();
          }
        });
        client.on('error', reject);
        bridge.waitForConnection(2000).then((ok) => {
          if (ok) resolve();
          else reject(new Error('not connected'));
        });
      });

      const res = await bridge.run([{ op: 'read', selector: 'title' }], 5000);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('extension-disconnected');
    } finally {
      bridge.stop();
    }
  });

  it('run 대기 중 두 번째 클라이언트가 붙으면 첫 run 이 extension-disconnected 로 바로 풀림', async () => {
    const port = await getFreePort();
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
    });
    bridge.start();

    try {
      const client1 = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client1.on('open', () => {
          client1.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client1.on('error', reject);
        bridge.waitForConnection(2000).then((ok) => {
          if (ok) resolve();
          else reject(new Error('not connected'));
        });
      });

      const runPromise = bridge.run([{ op: 'read', selector: 'title' }], 10000);

      const client2 = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client2.on('open', () => {
          client2.send(JSON.stringify({ type: 'hello', extVersion: '2.0.0' }));
          resolve();
        });
        client2.on('error', reject);
      });

      const res = await runPromise;
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('extension-disconnected');

      client1.close();
      client2.close();
    } finally {
      bridge.stop();
    }
  });

  it('허용 Origin 클라이언트가 context-action 을 보내면 콜백이 그 값으로 불림', async () => {
    const port = await getFreePort();
    let receivedAction: unknown = null;
    const bridge = new ExtensionBridge({
      host: '127.0.0.1',
      port,
      allowedIds: [allowedId],
      log: () => {},
      onContextAction: (msg) => {
        receivedAction = msg;
      },
    });
    bridge.start();

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: allowedOrigin,
      });

      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          client.send(JSON.stringify({ type: 'hello', extVersion: '1.0.0' }));
        });
        client.on('error', reject);
        bridge.waitForConnection(2000).then((ok) => {
          if (ok) resolve();
          else reject(new Error('not connected'));
        });
      });

      const actionPayload = {
        type: 'context-action',
        intentKey: 'suggest_value',
        element: {
          tag: 'input',
          type: 'text',
          name: 'prodName',
          id: 'prodName',
          role: null,
          label: '상품명',
          text: '',
          value: '기존상품명',
          selector: 'input[name="prodName"]',
        },
        pageUrl: 'https://sell.smartstore.naver.com/#/products/create',
        pageTitle: '상품 등록',
      };

      client.send(JSON.stringify(actionPayload));

      await new Promise<void>((resolve) => {
        const check = () => {
          if (receivedAction) resolve();
          else setTimeout(check, 20);
        };
        check();
      });

      expect(receivedAction).toEqual(actionPayload);

      client.close();
    } finally {
      bridge.stop();
    }
  });
});
