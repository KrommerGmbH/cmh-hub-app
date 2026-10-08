// R2-b — 플러그인 화면(WebContentsView) ↔ 앱(main) 다리. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 화면은 preload(plugin-ui-preload.cts)의 `window.cmhPlugin.call(method, params)` 하나로만 앱에 닿는다 → ipcMain.handle(PLUGIN_UI_IPC_CHANNEL).
// 글 한 통마다 검사(meteor-admin-sdk 의 «메시지마다 권한» 꼴 · 합의안 5):
//   ①보낸 webContents id 가 이 다리에 붙인(attach) 플러그인 화면인가 — 셸 · 탭 · 남의 화면이 같은 채널을 불러도 거부
//   ②보낸 프레임이 그 화면의 맨 위 프레임이고 주소가 그 플러그인 origin(`cmh-plugin://<이름>`)인가
//   ③메서드가 host:* 표(plugin-host-api.ts HOST_METHODS)에 있는가 — 없으면 permissionDenied(deny by default) · 옛 이름(repository.*)은 화면에 안 연다
//   ④그 다음 검사는 플러그인 프로세스와 같은 처리기(createHostMethods) — 매니페스트 permissions · 승인 엔티티 쓰기 늘 거부
// 답은 던지지 않고 `{ ok, result | error{code,message} }` 꼴(IPC 너머로 Error 를 넘기면 code 가 사라진다).

import { HOST_METHODS, LogRateLimiter, createHostMethods, type HostApiOptions } from './plugin-host-api.js';
import type { PluginManifest } from './plugin-manifest.js';
import { RPC_ERROR, RpcError, type RpcMethodHandler } from './plugin-rpc.js';
import { isPluginUiUrl } from './plugin-ui-policy.js';

/** preload(plugin-ui-preload.cts)와 같은 글자여야 한다 — sandbox preload 는 이 모듈을 require 할 수 없어 두 곳에 적고 시험으로 맞춘다 */
export const PLUGIN_UI_IPC_CHANNEL = 'cmh-plugin-ui:call';
/** 【AI 임시 결정】 플러그인 프로세스와 같은 상한(plugin-process.ts PLUGIN_MAX_CONCURRENT_REQUESTS · PLUGIN_MAX_MESSAGE_BYTES) */
export const PLUGIN_UI_MAX_CONCURRENT = 16;
export const PLUGIN_UI_MAX_MESSAGE_BYTES = 1024 * 1024;
/** 【AI 임시 결정】 onRejected 초당 상한(플러그인 하나마다 · 붙지 않은 보낸 쪽은 한 묶음) — 거부를 무더기로 일으켜 로그를 채우지 못하게(검수 8 🟢6) */
export const PLUGIN_UI_REJECTED_PER_SECOND = 20;
const UNATTACHED_KEY = '\u0000unattached';

export interface PluginUiSender {
  readonly webContentsId: number;
  /** 보낸 프레임의 주소(프레임이 이미 사라졌으면 null) */
  readonly frameUrl: string | null;
  /** 보낸 프레임이 맨 위 프레임인가 */
  readonly isMainFrame: boolean;
}

export type PluginUiReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

export interface PluginUiRejection {
  readonly webContentsId: number;
  readonly plugin: string | null;
  readonly reason: string;
}

export interface PluginUiBridgeOptions extends Omit<HostApiOptions, 'manifest'> {
  /** 다리 앞에서 거부한 것(보낸 쪽 · 꼴 · 상한) — 로그 자리 */
  readonly onRejected?: (info: PluginUiRejection) => void;
  readonly maxConcurrent?: number;
  readonly maxMessageBytes?: number;
}

interface Attached {
  readonly plugin: string;
  readonly methods: Readonly<Record<string, RpcMethodHandler>>;
  inFlight: number;
}

const UI_METHODS: ReadonlySet<string> = new Set(HOST_METHODS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: number, message: string): PluginUiReply {
  return { ok: false, error: { code, message } };
}

export class PluginUiBridge {
  private readonly attached = new Map<number, Attached>();
  /** onRejected 빈도 상한 — 플러그인 이름(붙지 않은 보낸 쪽은 UNATTACHED_KEY)마다. 키 수 = 플러그인 수 + 1 이라 커지지 않는다 */
  private readonly rejectLimiters = new Map<string, LogRateLimiter>();

  constructor(private readonly options: PluginUiBridgeOptions = {}) {}

  /** 화면 하나를 붙인다. 같은 id 를 두 번 붙이면 예외(프로그래머 문제) */
  attach(webContentsId: number, manifest: PluginManifest): void {
    if (this.attached.has(webContentsId)) throw new Error(`plugin ui bridge: webContents ${webContentsId} is already attached`);
    const { onRejected: _onRejected, maxConcurrent: _maxConcurrent, maxMessageBytes: _maxMessageBytes, ...host } = this.options;
    this.attached.set(webContentsId, { plugin: manifest.name, methods: createHostMethods({ ...host, manifest }), inFlight: 0 });
  }

  /** 화면이 닫히면(destroyed) 뗀다 — 같은 id 가 나중에 다른 webContents 에 다시 쓰여도 권한이 넘어가지 않게 */
  detach(webContentsId: number): void {
    this.attached.delete(webContentsId);
  }

  /** 붙어 있는 플러그인 이름(없으면 null) */
  pluginOf(webContentsId: number): string | null {
    return this.attached.get(webContentsId)?.plugin ?? null;
  }

  /** 그 플러그인의 화면 id 전부(플러그인을 내릴 때 닫으려고) */
  viewsOf(pluginName: string): number[] {
    return [...this.attached].filter(([, a]) => a.plugin === pluginName).map(([id]) => id);
  }

  /** ipcMain.handle 처리기. 던지지 않는다 */
  async handle(sender: PluginUiSender, raw: unknown): Promise<PluginUiReply> {
    const entry = this.attached.get(sender.webContentsId);
    const reject = (code: number, reason: string): PluginUiReply => {
      this.reportRejected({ webContentsId: sender.webContentsId, plugin: entry?.plugin ?? null, reason });
      return fail(code, reason);
    };
    if (!entry) return reject(RPC_ERROR.permissionDenied, 'permission denied: sender is not a plugin view');
    if (!sender.isMainFrame) return reject(RPC_ERROR.permissionDenied, 'permission denied: only the top frame of a plugin view may call the host');
    if (sender.frameUrl === null || !isPluginUiUrl(entry.plugin, sender.frameUrl)) {
      return reject(RPC_ERROR.permissionDenied, 'permission denied: sender frame is not this plugin\'s page');
    }
    const maxBytes = this.options.maxMessageBytes ?? PLUGIN_UI_MAX_MESSAGE_BYTES;
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > maxBytes) return reject(RPC_ERROR.invalidRequest, `message larger than ${maxBytes} bytes`);
    if (!isObject(raw) || typeof raw['method'] !== 'string') return reject(RPC_ERROR.invalidRequest, 'message must be { method: string, params? }');
    const method = raw['method'];
    if (!UI_METHODS.has(method)) {
      return reject(RPC_ERROR.permissionDenied, `permission denied: host method "${method.slice(0, 128)}" is not available to plugin views`);
    }
    const handler = entry.methods[method];
    if (!handler) return reject(RPC_ERROR.permissionDenied, `permission denied: host method "${method.slice(0, 128)}" is not available to plugin views`);
    const limit = this.options.maxConcurrent ?? PLUGIN_UI_MAX_CONCURRENT;
    if (entry.inFlight >= limit) return reject(RPC_ERROR.tooManyRequests, `too many concurrent requests (limit ${limit})`);
    entry.inFlight += 1;
    try {
      const result = await handler(raw['params']);
      return { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      if (error instanceof RpcError) return fail(error.code, error.message);
      return fail(RPC_ERROR.internal, error instanceof Error ? error.message : String(error));
    } finally {
      entry.inFlight -= 1;
    }
  }

  /** onRejected 를 초당 상한 안에서만 부른다 · 넘쳐 버린 개수는 다음 창 첫 줄 앞에 한 번 알린다 */
  private reportRejected(info: PluginUiRejection): void {
    const onRejected = this.options.onRejected;
    if (!onRejected) return;
    const key = info.plugin ?? UNATTACHED_KEY;
    let limiter = this.rejectLimiters.get(key);
    if (!limiter) {
      limiter = new LogRateLimiter(PLUGIN_UI_REJECTED_PER_SECOND, this.options.now ?? Date.now);
      this.rejectLimiters.set(key, limiter);
    }
    const accepted = limiter.accept((dropped) => onRejected({ webContentsId: info.webContentsId, plugin: info.plugin, reason: `rejections rate limited: ${dropped} dropped` }));
    if (accepted) onRejected(info);
  }
}
