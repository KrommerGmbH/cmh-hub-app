import type { BridgeToApp, DriverRunResult } from '@cmh-hub-app/driver-core';
import { parseBridgeToExtension } from '@cmh-hub-app/driver-core';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  readyState: number;
}

export interface BridgeClientDeps {
  createSocket(url: string): WebSocketLike;
  runSteps(steps: unknown[]): Promise<DriverRunResult>;
  extVersion: string;
  log(msg: string): void;
  setTimer(fn: () => void, ms: number): unknown;
}

export class BridgeClient {
  private socket: WebSocketLike | null = null;
  private reconnectDelayMs = 1000;
  private reconnectScheduled = false;

  constructor(
    private readonly url: string,
    private readonly deps: BridgeClientDeps,
  ) {}

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  connect(): void {
    if (this.socket !== null && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
      return;
    }

    const ws = this.deps.createSocket(this.url);
    this.socket = ws;

    let disconnected = false;
    const handleDisconnect = (): void => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      if (this.reconnectScheduled) {
        return;
      }
      this.reconnectScheduled = true;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
      this.deps.setTimer(() => {
        this.reconnectScheduled = false;
        this.connect();
      }, delay);
    };

    ws.onopen = (): void => {
      this.reconnectDelayMs = 1000;
      this.reconnectScheduled = false;
      const hello: BridgeToApp = {
        type: 'hello',
        extVersion: this.deps.extVersion,
      };
      ws.send(JSON.stringify(hello));
      this.deps.log('connected');
    };

    ws.onmessage = (ev: { data: unknown }): void => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
      const parsed = parseBridgeToExtension(raw);
      if (!parsed) {
        this.deps.log('unrecognized message: ' + raw);
        return;
      }

      if (parsed.type === 'ping') {
        const pong: BridgeToApp = { type: 'pong' };
        ws.send(JSON.stringify(pong));
        return;
      }

      if (parsed.type === 'run') {
        void (async () => {
          try {
            const runResult = await this.deps.runSteps(parsed.steps);
            const resMsg: BridgeToApp = {
              type: 'result',
              id: parsed.id,
              result: runResult,
            };
            ws.send(JSON.stringify(resMsg));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const failMsg: BridgeToApp = {
              type: 'result',
              id: parsed.id,
              result: {
                ok: false,
                steps: [],
                error: {
                  code: 'invalid-step',
                  message,
                },
              },
            };
            ws.send(JSON.stringify(failMsg));
          }
        })();
      }
    };

    ws.onclose = (): void => {
      handleDisconnect();
    };

    ws.onerror = (): void => {
      handleDisconnect();
    };
  }
}
