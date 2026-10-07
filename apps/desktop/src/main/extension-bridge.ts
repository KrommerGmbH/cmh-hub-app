// U11 — 앱 쪽 WebSocket 서버 ExtensionBridge
// - 127.0.0.1 에서만 열고 Origin 이 chrome-extension://<허용 id> 인 연결만 수락
// - 연결은 단 하나만 유지(새 연결 시 기존 연결 종료)
// - 20초마다 ping 송신하여 확장 서비스 워커 유지

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseBridgeToApp,
  type DriverErrorCode,
  type DriverRunResult,
} from '@cmh-hub-app/driver-core';

export type BridgeErrorCode = DriverErrorCode | 'no-extension' | 'extension-disconnected';

export interface BridgeRunResult extends Omit<DriverRunResult, 'error'> {
  error: { code: BridgeErrorCode; message: string } | null;
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedIds: readonly string[],
): boolean {
  if (typeof origin !== 'string') return false;
  const prefix = 'chrome-extension://';
  if (!origin.startsWith(prefix)) return false;
  const id = origin.slice(prefix.length);
  return allowedIds.includes(id);
}

export interface ExtensionBridgeOptions {
  host: string;
  port: number;
  allowedIds: readonly string[];
  log?: (m: string) => void;
}

interface PendingRun {
  socket: WebSocket;
  resolve: (res: BridgeRunResult) => void;
  timer: NodeJS.Timeout;
}

let activeBridgeInstance: ExtensionBridge | null = null;

export function getExtensionBridge(): ExtensionBridge | null {
  return activeBridgeInstance;
}

export class ExtensionBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly allowedIds: readonly string[];
  private readonly log: (m: string) => void;

  private wss: WebSocketServer | null = null;
  private currentSocket: WebSocket | null = null;
  private extVersion: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private readonly waitResolvers = new Set<(connected: boolean) => void>();
  private readonly pendingRuns = new Map<string, PendingRun>();

  constructor(opts: ExtensionBridgeOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.allowedIds = opts.allowedIds;
    this.log = opts.log ?? ((m: string) => console.info('[ext-bridge] ' + m));
  }

  start(): void {
    if (this.wss) return;
    activeBridgeInstance = this;

    const wss = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
        isAllowedOrigin(info.origin, this.allowedIds),
    });
    this.wss = wss;

    wss.on('connection', (ws, _req) => {
      this.log('새 WebSocket 연결 수신');
      if (this.currentSocket && this.currentSocket !== ws) {
        this.log('기존 연결 종료');
        const oldSocket = this.currentSocket;
        try {
          oldSocket.close();
        } catch {
          // ignore close error
        }
        this.rejectPending(
          {
            ok: false,
            steps: [],
            error: {
              code: 'extension-disconnected',
              message: '크롬 확장 연결이 끊어졌습니다',
            },
          },
          oldSocket,
        );
      }

      this.currentSocket = ws;
      this.extVersion = null;

      ws.on('message', (data) => {
        const raw = typeof data === 'string' ? data : data.toString();
        const msg = parseBridgeToApp(raw);
        if (!msg) return;

        if (msg.type === 'hello') {
          this.extVersion = msg.extVersion;
          this.log(`hello 수신 (extVersion=${msg.extVersion})`);
          for (const resolve of this.waitResolvers) {
            resolve(true);
          }
          this.waitResolvers.clear();
        } else if (msg.type === 'result') {
          const pending = this.pendingRuns.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRuns.delete(msg.id);
            pending.resolve(msg.result);
          }
        }
      });

      ws.on('close', () => {
        if (this.currentSocket === ws) {
          this.log('연결 종료됨');
          this.currentSocket = null;
          this.extVersion = null;
          this.rejectPending(
            {
              ok: false,
              steps: [],
              error: {
                code: 'extension-disconnected',
                message: '크롬 확장 연결이 끊어졌습니다',
              },
            },
            ws,
          );
        }
      });

      ws.on('error', (err) => {
        this.log(`소켓 오류: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    wss.on('error', (err: unknown) => {
      const isAddrInUse =
        err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'EADDRINUSE';
      if (isAddrInUse) {
        console.warn(`[ext-bridge] 포트 ${this.port} 이미 사용 중 (EADDRINUSE)`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ext-bridge] 서버 오류: ${msg}`);
      }
    });

    this.pingTimer = setInterval(() => {
      if (this.currentSocket && this.currentSocket.readyState === 1) {
        try {
          this.currentSocket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore send error
        }
      }
    }, 20_000);
  }

  isConnected(): boolean {
    return this.currentSocket !== null && this.currentSocket.readyState === 1 && this.extVersion !== null;
  }

  getExtVersion(): string | null {
    return this.extVersion;
  }

  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onDone = (connected: boolean) => {
        if (timer) clearTimeout(timer);
        this.waitResolvers.delete(onDone);
        resolve(connected);
      };

      timer = setTimeout(() => {
        this.waitResolvers.delete(onDone);
        resolve(this.isConnected());
      }, timeoutMs);

      this.waitResolvers.add(onDone);
    });
  }

  run(steps: unknown[], timeoutMs = 60_000): Promise<BridgeRunResult> {
    if (!this.isConnected() || !this.currentSocket) {
      return Promise.resolve({
        ok: false,
        steps: [],
        error: {
          code: 'no-extension',
          message: '크롬 확장이 연결되지 않았습니다 — 크롬을 켜고 확장을 확인하세요',
        },
      });
    }

    const id = randomUUID();
    const payload = JSON.stringify({ type: 'run', id, steps });

    return new Promise<BridgeRunResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRuns.delete(id);
        resolve({
          ok: false,
          steps: [],
          error: {
            code: 'timeout',
            message: `작업 실행 시간 초과 (${timeoutMs}ms)`,
          },
        });
      }, timeoutMs);

      this.pendingRuns.set(id, { socket: this.currentSocket!, resolve, timer });

      try {
        this.currentSocket!.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRuns.delete(id);
        const msg = err instanceof Error ? err.message : String(err);
        resolve({
          ok: false,
          steps: [],
          error: {
            code: 'extension-disconnected',
            message: `메시지 송신 실패: ${msg}`,
          },
        });
      }
    });
  }

  private rejectPending(result: BridgeRunResult, targetSocket?: WebSocket): void {
    for (const [id, pending] of this.pendingRuns) {
      if (!targetSocket || pending.socket === targetSocket) {
        clearTimeout(pending.timer);
        pending.resolve(result);
        this.pendingRuns.delete(id);
      }
    }
  }

  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.currentSocket) {
      try {
        this.currentSocket.close();
      } catch {
        // ignore
      }
      this.currentSocket = null;
      this.extVersion = null;
    }

    this.rejectPending({
      ok: false,
      steps: [],
      error: {
        code: 'extension-disconnected',
        message: '서버가 종료되었습니다',
      },
    });

    for (const resolve of this.waitResolvers) {
      resolve(false);
    }
    this.waitResolvers.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }

    if (activeBridgeInstance === this) {
      activeBridgeInstance = null;
    }
  }
}
