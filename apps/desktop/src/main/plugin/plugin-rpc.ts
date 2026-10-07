// R2-a — 아주 작은 JSON-RPC 2.0(양방향). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 새 의존 0 이라 직접 짰다. 칸 이름은 JSON-RPC 2.0 그대로(jsonrpc · id · method · params · result · error{code,message,data})라
// 나중에 vscode-jsonrpc 로 바꿀 때 플러그인 쪽 글은 그대로 둘 수 있다.
// 상대(플러그인 프로세스)는 믿지 않는다: 들어온 글이 꼴에 안 맞으면 버리고(요청이면 Invalid Request 로 답) 예외로 앱을 넘어뜨리지 않는다.

export const RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** 이 앱 정의 — 매니페스트 permissions 에 없는 접근 */
  permissionDenied: -32001,
  /** 이 앱 정의 — 시간초과(우리 쪽에서 만든 오류 · 상대는 보내지 않는다) */
  timeout: -32002,
  /** 이 앱 정의 — 상대 프로세스가 끝나서 답을 못 받음 */
  processExited: -32003,
  /** 이 앱 정의 — 상대가 보낸 요청이 동시 상한(maxConcurrentIncoming)을 넘음 */
  tooManyRequests: -32004,
} as const;

export interface RpcRequest { readonly jsonrpc: '2.0'; readonly id: number; readonly method: string; readonly params?: unknown }
export interface RpcNotification { readonly jsonrpc: '2.0'; readonly method: string; readonly params?: unknown }
export interface RpcErrorObject { readonly code: number; readonly message: string; readonly data?: unknown }
export type RpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: number | null; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: number | null; readonly error: RpcErrorObject };
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcMethodHandler = (params: unknown) => unknown;

export interface RpcEndpointOptions {
  /** 글 한 통을 상대에게 보낸다(postMessage / process.send) */
  readonly send: (message: RpcMessage) => void;
  /** 상대가 부를 수 있는 메서드 · 여기 없는 이름은 Method not found */
  readonly methods: Readonly<Record<string, RpcMethodHandler>>;
  /** 요청 하나의 기본 시간초과(ms) */
  readonly defaultTimeoutMs?: number;
  /** 꼴이 틀린 글 · 상대가 보낸 알림 처리 실패 같은 것을 남긴다 */
  readonly onProtocolError?: (message: string) => void;
  /** 상대가 보낸 요청 중 아직 답하지 않은 것의 상한 — 넘으면 tooManyRequests 로 바로 답한다 · 없으면 상한 없음 */
  readonly maxConcurrentIncoming?: number;
  /** 상대가 보낸 글 한 통의 JSON 바이트 상한 — 넘으면 버린다(요청이면 Invalid Request 로 답) · 없으면 상한 없음 */
  readonly maxMessageBytes?: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RpcError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RpcEndpoint {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedReason: RpcError | null = null;
  private readonly defaultTimeoutMs: number;
  /** 상대 요청 중 처리 중인 것 */
  private incoming = 0;

  constructor(private readonly options: RpcEndpointOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RPC_ERROR.timeout, `request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // 기다리는 요청 하나 때문에 앱(또는 시험) 프로세스가 끝나지 못하는 일이 없게
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.options.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcError(RPC_ERROR.internal, `send failed: ${(error as Error).message}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason) return;
    this.options.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** 상대에게서 온 글 한 통. 예외를 던지지 않는다. */
  handleMessage(raw: unknown): void {
    if (!isObject(raw) || raw['jsonrpc'] !== '2.0') {
      this.protocolError('dropped message without jsonrpc 2.0');
      return;
    }
    const id = raw['id'];
    const method = raw['method'];
    const maxBytes = this.options.maxMessageBytes;
    if (maxBytes !== undefined) {
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
      } catch {
        size = Number.POSITIVE_INFINITY;
      }
      if (size > maxBytes) {
        this.protocolError(`dropped message larger than ${maxBytes} bytes`);
        if (typeof method === 'string' && typeof id === 'number' && Number.isSafeInteger(id)) {
          this.reply(id, undefined, new RpcError(RPC_ERROR.invalidRequest, `message larger than ${maxBytes} bytes`));
        }
        return;
      }
    }
    if (typeof method === 'string') {
      if (id === undefined) {
        void this.dispatch(method, raw['params']).catch((error: unknown) => this.protocolError(`notification "${method}" failed: ${String(error)}`));
        return;
      }
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
        this.reply(null, undefined, new RpcError(RPC_ERROR.invalidRequest, 'request id must be an integer'));
        return;
      }
      const limit = this.options.maxConcurrentIncoming;
      if (limit !== undefined && this.incoming >= limit) {
        this.reply(id, undefined, new RpcError(RPC_ERROR.tooManyRequests, `too many concurrent requests (limit ${limit})`));
        return;
      }
      this.incoming += 1;
      this.dispatch(method, raw['params'])
        .then(
          (result) => this.reply(id, result, null),
          (error: unknown) => this.reply(id, undefined, error instanceof RpcError ? error : new RpcError(RPC_ERROR.internal, error instanceof Error ? error.message : String(error))),
        )
        .finally(() => {
          this.incoming -= 1;
        });
      return;
    }
    if (typeof id === 'number' && (Object.prototype.hasOwnProperty.call(raw, 'result') || isObject(raw['error']))) {
      const pending = this.pending.get(id);
      if (!pending) {
        this.protocolError(`response for unknown id ${id} dropped`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = raw['error'];
      if (isObject(error)) {
        const code = typeof error['code'] === 'number' ? error['code'] : RPC_ERROR.internal;
        const message = typeof error['message'] === 'string' ? error['message'] : 'unknown error';
        pending.reject(new RpcError(code, message, error['data']));
      } else {
        pending.resolve(raw['result']);
      }
      return;
    }
    this.protocolError('dropped malformed message');
  }

  /** 상대가 끝났을 때 — 기다리던 요청을 전부 거부하고 그 뒤 요청도 거부한다 */
  close(reason: RpcError): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const handler = Object.prototype.hasOwnProperty.call(this.options.methods, method) ? this.options.methods[method] : undefined;
    if (!handler) throw new RpcError(RPC_ERROR.methodNotFound, `method "${method}" not found`);
    return handler(params);
  }

  private reply(id: number | null, result: unknown, error: RpcError | null): void {
    if (this.closedReason) return;
    try {
      if (error) {
        this.options.send({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } });
      } else {
        this.options.send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
      }
    } catch (sendError) {
      this.protocolError(`reply failed: ${(sendError as Error).message}`);
    }
  }

  private protocolError(message: string): void {
    this.options.onProtocolError?.(message);
  }
}
