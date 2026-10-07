// R1 앱 연결 — main 쪽 자료 서비스. SQLite(better-sqlite3 · 동기)는 별도 프로세스(data-worker)에서 돌고 main 은 RPC 로만 부른다.
// electron 을 import 하지 않는다(띄우기는 ProcessLauncher 뒤 — 앱은 ElectronProcessLauncher(utilityProcess) · 시험은 NodeProcessLauncher(fork)).
// @cmh-hub-app/data 도 «타입만» import 한다 — 값을 import 하면 그 index 가 better-sqlite3 를 main 에 싣는다.
//
// 상태: idle → starting → running ⇄ restarting → failed | stopping → stopped
//   · 자식이 뜻밖에 죽으면 한 번(maxRestarts) 다시 띄운다. 그래도 죽으면 failed — 앱은 살고 요청은 unavailable 로 거부된다.
//   · 열기(마이그레이션) 실패는 다시 띄우지 않고 곧장 failed(같은 파일이면 또 실패한다).
//   · 띄우는(다시 띄우는) 동안 온 요청은 새 자식을 그 요청의 시간초과 안에서만 기다린다(넘으면 unavailable) · 죽을 때 날아가던 요청은 processExited 로 거부(쓰기 중복을 피해 되풀이하지 않는다).
//   · open(사본 + 마이그레이션)은 기본 시간초과가 없다 — 자식이 살아 있는 동안 기다리고, 자식이 끝나면 그때 실패한다(검수 6 S3 · 큰 DB · 느린 디스크).
// 내리기: 'shutdown' 요청(stopTimeoutMs · DB 닫기) → SIGTERM → killTimeoutMs → SIGKILL → killTimeoutMs — 플러그인(plugin-process.ts)과 같은 차례.
// 비밀칸: secrets.read 는 SECRET_READERS(호출자 · 엔티티 · 칸) 허용 목록에 있는 것만 자식에게 보낸다.
//   ⚠ 호출자 이름은 main 코드가 스스로 밝히는 글자다(main 안은 믿는다) — 허용 목록은 «어디서 비밀값을 꺼내나»를 한 곳에 적어 두는 가드다.
//   공개 call() 은 DATA_PUBLIC_METHODS(repo.* · health)만 보낸다 — secrets.read · open · shutdown 은 안쪽 send() 로만(검수 6 B1: call() 로 허용 목록을 건너뛰던 길).

import { fileURLToPath } from 'node:url';
import type { CriteriaRequestParams, Entity, EntitySearchResult, IdSearchResult, WriteResult } from '@cmh-hub-app/data';
import type { PluginChannel, ProcessLauncher } from '../plugin/process-launcher.js';
import { RpcEndpoint, RpcError } from '../plugin/plugin-rpc.js';
import { DATA_METHOD, DATA_PUBLIC_METHODS, DATA_RPC_ERROR, type HealthResult, type OpenResult, type SecretReadResult } from './data-protocol.js';

export type DataServiceState = 'idle' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped';

export type DataServiceLogLevel = 'info' | 'warn' | 'error';

/** Criteria 객체(parse() 가 있는 것) 또는 그 JSON */
export type CriteriaArg = CriteriaRequestParams | { parse(): CriteriaRequestParams };

/** 비밀칸을 꺼내도 되는 main 쪽 호출자 하나 */
export interface SecretReaderGrant {
  readonly caller: string;
  readonly entity: string;
  /** 저장 이름(snake_case) 또는 속성 이름(camelCase) — 둘 다 맞춘다 */
  readonly field: string;
}

/** 지금 허용 목록 — R4 ModelProvider 가 원격 모델 API 키(safeStorage blob)를 풀 때 */
export const SECRET_READERS: readonly SecretReaderGrant[] = Object.freeze([
  Object.freeze({ caller: 'models.provider-key', entity: 'cmh_ai_provider', field: 'api_key_enc' }),
]);

export interface DataServiceOptions {
  /** SQLite 파일 — 앱은 userData/cmh-hub.sqlite */
  readonly filename: string;
  readonly launcher: ProcessLauncher;
  /** 자식 진입 파일(.js) · 기본 이 파일 옆 data-worker.js(dist/main/data/) */
  readonly workerPath?: string;
  /** 요청 하나 기본 시간초과 · 기본 10초 */
  readonly requestTimeoutMs?: number;
  /**
   * open(사본 + 마이그레이션) 답 기다림 · 기본 없음(자식이 살아 있는 동안 기다린다 · 자식이 끝나면 processExited 로 실패).
   * 주면 그 시간에 끊고 자식을 거둔다(시험 · 나중에 화면이 «멈춤» 판정을 따로 할 때).
   */
  readonly startTimeoutMs?: number;
  /** 'shutdown' 답 기다림 · 기본 2초 */
  readonly stopTimeoutMs?: number;
  /** SIGTERM 뒤 SIGKILL 까지 · SIGKILL 뒤 exit 기다림 · 기본 2초 */
  readonly killTimeoutMs?: number;
  /** 뜻밖의 죽음 뒤 다시 띄우는 횟수(앱이 사는 동안 합) · 기본 1 */
  readonly maxRestarts?: number;
  /** 기본 SECRET_READERS */
  readonly secretReaders?: readonly SecretReaderGrant[];
  /** 자식에게 줄 환경변수(부모 env 를 통째로 물려주지 않는다) · 기본 OS 임시 폴더 · 시스템 폴더 변수만 */
  readonly env?: Readonly<Record<string, string>>;
  readonly onLog?: (level: DataServiceLogLevel, message: string) => void;
  readonly onStateChange?: (state: DataServiceState, detail: string | null) => void;
}

interface Session {
  readonly channel: PluginChannel;
  readonly rpc: RpcEndpoint;
  /** 'exit' 를 보면 풀린다 */
  readonly exited: Promise<void>;
  hasExited: boolean;
}

/** 자식 env 에 넘겨도 되는 OS 변수(비밀값이 아닌 것 · SQLite 임시 파일 · Windows 시스템 DLL 찾기) */
const PASSTHROUGH_ENV = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG'] as const;

function defaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function defaultWorkerPath(): string {
  return fileURLToPath(new URL('./data-worker.js', import.meta.url));
}

/**
 * «시간초과 없음» 대신 쓰는 값 — RpcEndpoint.request 는 늘 setTimeout 을 거는데, 2^31-1 ms 를 넘기면 Node 가 1ms 로 바꾼다
 * (TimeoutOverflowWarning · 2026-10-07 node 로 확인). 2^31-1 ms ≈ 24.8일.
 */
const NO_TIMEOUT_MS = 2_147_483_647;

/** start 실패(마지막) — 화면이 code(-32014 corruptDatabase 등)와 data(DataOpenErrorData)로 고를 것을 보인다 */
export interface DataServiceFailure {
  readonly code: number | null;
  readonly message: string;
  readonly data: unknown;
}

/** p 가 ms 안에 끝나면 true */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms);
    timer.unref?.();
    p.then(
      () => {
        clearTimeout(timer);
        resolveWait(true);
      },
      () => {
        clearTimeout(timer);
        resolveWait(true);
      },
    );
  });
}

function compactFieldName(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

function toCriteriaJson(criteria: CriteriaArg | undefined): CriteriaRequestParams {
  if (criteria === undefined) return {};
  const maybe = criteria as { parse?: unknown };
  return typeof maybe.parse === 'function' ? (criteria as { parse(): CriteriaRequestParams }).parse() : (criteria as CriteriaRequestParams);
}

function unavailable(message: string): RpcError {
  return new RpcError(DATA_RPC_ERROR.unavailable, message);
}

export class DataService {
  private stateValue: DataServiceState = 'idle';
  private session: Session | null = null;
  /** 지금 띄우는 중이거나 띄운 자식 — 요청은 이것을 기다린다 */
  private ready: Promise<Session> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restarts = 0;
  private lastErrorValue: string | null = null;
  private openResult: OpenResult | null = null;
  private failureValue: DataServiceFailure | null = null;

  constructor(private readonly options: DataServiceOptions) {}

  get state(): DataServiceState {
    return this.stateValue;
  }

  /** 지금 자식 pid(없으면 undefined) */
  get pid(): number | undefined {
    return this.session && !this.session.hasExited ? this.session.channel.pid : undefined;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get restartCount(): number {
    return this.restarts;
  }

  /** 마지막 start · 재시작 실패의 RPC 오류 번호와 data(깨진 파일이면 code -32014 · data.backupPath) · 없으면 null */
  get lastFailure(): DataServiceFailure | null {
    return this.failureValue;
  }

  /** 마지막 open 결과(이번에 돈 마이그레이션) */
  get lastOpen(): OpenResult | null {
    return this.openResult;
  }

  /** 자식을 띄우고 DB 를 연다. 실패하면 failed 로 두고 예외(앱은 이 예외를 로그로만 남기고 계속 간다) */
  async start(): Promise<OpenResult> {
    if (this.stateValue !== 'idle') throw new Error(`data service cannot start from state ${this.stateValue}`);
    this.setState('starting', null);
    const ready = this.spawn();
    this.ready = ready;
    try {
      await ready;
    } catch (error) {
      if (this.state === 'starting') this.fail(`start failed: ${(error as Error).message}`, error);
      throw error;
    }
    // 띄우는 사이 stop() 이 불렸으면 running 으로 바꾸지 않는다
    if (this.state !== 'starting' || !this.openResult) throw unavailable(`data service was ${this.state} while starting`);
    this.setState('running', null);
    return this.openResult;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  // ───────────── 얇은 메서드(전부 scope 'api' — 자식이 정한다) ─────────────

  health(): Promise<HealthResult> {
    return this.call(DATA_METHOD.health) as Promise<HealthResult>;
  }

  search<E extends Entity = Entity>(entity: string, criteria?: CriteriaArg): Promise<EntitySearchResult<E>> {
    return this.call(DATA_METHOD.search, { entity, criteria: toCriteriaJson(criteria) }) as Promise<EntitySearchResult<E>>;
  }

  searchIds(entity: string, criteria?: CriteriaArg): Promise<IdSearchResult> {
    return this.call(DATA_METHOD.searchIds, { entity, criteria: toCriteriaJson(criteria) }) as Promise<IdSearchResult>;
  }

  get<E extends Entity = Entity>(entity: string, id: string, criteria?: CriteriaArg): Promise<E | null> {
    return this.call(DATA_METHOD.get, { entity, id, criteria: toCriteriaJson(criteria) }) as Promise<E | null>;
  }

  aggregate(entity: string, criteria: CriteriaArg): Promise<Record<string, unknown>> {
    return this.call(DATA_METHOD.aggregate, { entity, criteria: toCriteriaJson(criteria) }) as Promise<Record<string, unknown>>;
  }

  upsert(entity: string, rows: readonly Record<string, unknown>[]): Promise<WriteResult> {
    return this.call(DATA_METHOD.upsert, { entity, rows }) as Promise<WriteResult>;
  }

  delete(entity: string, ids: readonly string[]): Promise<WriteResult> {
    return this.call(DATA_METHOD.delete, { entity, ids }) as Promise<WriteResult>;
  }

  /** 비밀칸 하나(암호 blob 그대로) — 허용 목록에 없는 (호출자 · 엔티티 · 칸)은 자식에게 보내지도 않는다 */
  async readSecret(caller: string, entity: string, id: string, field: string): Promise<unknown> {
    const grants = this.options.secretReaders ?? SECRET_READERS;
    const allowed = grants.some((g) => g.caller === caller && g.entity === entity && compactFieldName(g.field) === compactFieldName(field));
    if (!allowed) {
      this.log('warn', `secret read denied: caller "${caller}" → ${entity}.${field}`);
      throw new RpcError(DATA_RPC_ERROR.permissionDenied, `permission denied: "${caller}" may not read ${entity}.${field}`);
    }
    const result = (await this.send(DATA_METHOD.readSecret, { entity, id, field })) as SecretReadResult;
    return result.value;
  }

  /**
   * 낮은 길 — DATA_PUBLIC_METHODS(repo.* · health)만. secrets.read · open · shutdown 등 그 밖은 자식에게 보내지 않고 permissionDenied.
   * scope 를 넣으면 자식이 거부한다.
   */
  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!DATA_PUBLIC_METHODS.has(method)) {
      this.log('warn', `call denied: method "${method}" is not public`);
      throw new RpcError(DATA_RPC_ERROR.permissionDenied, `permission denied: method "${method}" cannot be sent through DataService.call()`);
    }
    return this.send(method, params, timeoutMs);
  }

  // ───────────── 안쪽 ─────────────

  /** 메서드를 거르지 않고 보낸다 — 이 파일 안(readSecret · call)만 부른다. 띄우는 중 기다림도 timeoutMs 안에 든다 */
  private async send(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const budgetMs = timeoutMs ?? this.options.requestTimeoutMs ?? 10_000;
    const startedAt = Date.now();
    const session = await this.currentSession(budgetMs);
    const leftMs = Math.max(1, budgetMs - (Date.now() - startedAt));
    return session.rpc.request(method, params, leftMs);
  }

  private async currentSession(waitMs: number): Promise<Session> {
    switch (this.stateValue) {
      case 'idle':
        throw unavailable('data service is not started');
      case 'failed':
        throw unavailable(`data service failed: ${this.lastErrorValue ?? 'unknown error'}`);
      case 'stopping':
      case 'stopped':
        throw unavailable('data service is stopped');
      default:
        break;
    }
    const ready = this.ready;
    if (!ready) throw unavailable('data service has no process');
    // open 은 시간초과가 없으므로(S3) 띄우는 중 기다림은 요청 쪽 시간으로 끊는다 — open 자체는 계속 돈다
    if (this.stateValue !== 'running' && !(await settlesWithin(ready, waitMs))) {
      throw unavailable(`data service is still ${this.stateValue} after ${waitMs}ms`);
    }
    try {
      return await ready;
    } catch {
      throw unavailable(`data service failed: ${this.lastErrorValue ?? 'process did not start'}`);
    }
  }

  /** 자식 하나를 띄우고 open 까지. 실패하면 거두고 예외 */
  private async spawn(): Promise<Session> {
    const workerPath = this.options.workerPath ?? defaultWorkerPath();
    const channel = this.options.launcher.launch(workerPath, {
      cwd: process.cwd(),
      env: this.options.env ?? defaultEnv(),
      execArgv: [],
      serviceName: 'cmh-data',
    });
    const rpc = new RpcEndpoint({
      send: (message) => channel.send(message),
      methods: {},
      defaultTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      onProtocolError: (message) => this.log('warn', `rpc: ${message}`),
    });
    let markExited: () => void = () => undefined;
    const session: Session = {
      channel,
      rpc,
      exited: new Promise<void>((resolveExit) => {
        markExited = resolveExit;
      }),
      hasExited: false,
    };
    channel.onMessage((message) => rpc.handleMessage(message));
    channel.onExit((code) => {
      session.hasExited = true;
      rpc.close(new RpcError(DATA_RPC_ERROR.processExited, `data process exited (code ${code ?? 'unknown'})`));
      markExited();
      this.handleExit(session, code);
    });
    this.session = session;
    try {
      this.openResult = (await rpc.request(DATA_METHOD.open, { filename: this.options.filename }, this.options.startTimeoutMs ?? NO_TIMEOUT_MS)) as OpenResult;
    } catch (error) {
      // 열기 실패 · 시간초과 · 죽음 — 거둔다(자식도 스스로 끝나지만 기다리지 않는다)
      await this.terminate(session);
      throw error;
    }
    if (this.openResult.updated.length > 0 || this.openResult.destructive.length > 0) {
      this.log('info', `migrated: ${[...this.openResult.updated, ...this.openResult.destructive].join(', ')}`);
    }
    return session;
  }

  private handleExit(session: Session, code: number | null): void {
    if (session !== this.session) return; // 이미 바꾼 옛 자식
    if (this.stateValue !== 'running') return; // 띄우는 중 죽음은 spawn 이 실패로 받는다 · 내리는 중은 예상한 끝
    if (this.restarts >= (this.options.maxRestarts ?? 1)) {
      this.fail(`data process exited unexpectedly (code ${code ?? 'unknown'}) after ${this.restarts} restart(s)`);
      return;
    }
    this.restarts += 1;
    this.log('warn', `data process exited unexpectedly (code ${code ?? 'unknown'}) — restarting (${this.restarts})`);
    this.setState('restarting', `exit code ${code ?? 'unknown'}`);
    const ready = this.spawn();
    this.ready = ready;
    ready.then(
      () => {
        if (this.stateValue === 'restarting' && this.ready === ready) this.setState('running', null);
      },
      (error: unknown) => {
        if (this.stateValue === 'restarting' && this.ready === ready) this.fail(`restart failed: ${(error as Error).message}`, error);
      },
    );
  }

  private async doStop(): Promise<void> {
    if (this.stateValue === 'idle' || this.stateValue === 'stopped') {
      this.setState('stopped', null);
      return;
    }
    this.setState('stopping', null);
    const session = this.session;
    if (session && !session.hasExited) {
      try {
        await session.rpc.request(DATA_METHOD.shutdown, undefined, this.options.stopTimeoutMs ?? 2_000);
      } catch {
        // 답이 없거나 이미 죽었어도 아래에서 거둔다
      }
      const gone = await this.terminate(session);
      if (!gone) this.log('error', 'data process did not report exit after SIGKILL');
    }
    this.setState('stopped', null);
  }

  /** SIGTERM → killTimeoutMs → SIGKILL → killTimeoutMs 만 exit 대기. exit 를 보면 true */
  private async terminate(session: Session): Promise<boolean> {
    if (session.hasExited) return true;
    const killTimeoutMs = this.options.killTimeoutMs ?? 2_000;
    session.channel.kill('SIGTERM');
    if (await settlesWithin(session.exited, killTimeoutMs)) return true;
    session.channel.kill('SIGKILL');
    return settlesWithin(session.exited, killTimeoutMs);
  }

  private fail(message: string, cause?: unknown): void {
    this.lastErrorValue = message;
    this.failureValue =
      cause instanceof RpcError ? { code: cause.code, message: cause.message, data: cause.data ?? null } : { code: null, message, data: null };
    this.log('error', message);
    this.setState('failed', message);
  }

  private setState(state: DataServiceState, detail: string | null): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onStateChange?.(state, detail);
  }

  private log(level: DataServiceLogLevel, message: string): void {
    this.options.onLog?.(level, message);
  }
}
