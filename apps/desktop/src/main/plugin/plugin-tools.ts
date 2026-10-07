// R2-b — 플러그인이 내놓는 도구(`contributes.tools`)를 에이전트 루프(RA ToolRouter)에 보이는 출처 하나로 묶는다.
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
//
// 이름: Guard 이름 = `plugin:<플러그인 이름>:<도구 이름>` — 세 마디 · 각 마디는 guard-policy.ts TOOL_SEGMENT(`[A-Za-z0-9_.-]`) 안쪽이라
//   `plugin:plugin-hello:*` · `plugin:**` 같은 정책 글롭이 그대로 맞는다. 도구 이름에 `:` 를 막아 마디를 늘려 deny 규칙을 비껴가지 못하게.
// 승인: access 가 read 가 아니면(빠지면 write) needsApproval: true → Guard 가 allow 여도 승인 관문(requiresApproval).
// known: 기본 false → Guard 최소 ask(처음 보는 외부 도구와 같은 대접 · 합의안 5). 사람이 본 기록이 생기면 isKnown 으로 true.
// 부르기: 앱 → 플러그인 RPC `tool:<도구 이름>` · params = 모델이 준 인자 객체. 안 떠 있으면 `onTool:<도구 이름>` 으로 그 플러그인만 깨운다.
// 🔴 Guard 평가 · 승인 관문은 여기서 하지 않는다 — AgentRunner 가 callTool 앞에서 한다(tool-router.ts 와 같은 나눔). callTool 은 던지지 않는다.

import type { ToolCallContext, ToolCallResult } from '../agent/tool-router.js';
import { PLUGIN_NAME_PATTERN, PLUGIN_TOOL_NAME_PATTERN, type PluginManifest, type ToolContribution } from './plugin-manifest.js';
import type { PluginState } from './plugin-registry.js';

export const PLUGIN_TOOL_SOURCE = 'plugin';
/** 앱 → 플러그인 도구 요청 메서드 앞붙이 */
export const PLUGIN_TOOL_METHOD_PREFIX = 'tool:';
/** 【AI 임시 결정】 도구 한 번의 기본 시간초과 · 결과 글자 상한(원칙 2 토큰 절약) */
export const PLUGIN_TOOL_TIMEOUT_MS = 30_000;
export const PLUGIN_TOOL_MAX_RESULT_CHARS = 32_000;

/** Guard 이름. 플러그인 이름 · 도구 이름이 규칙에 안 맞으면 예외(모양이 깨진 이름을 목록에 올리지 않는다) */
export function pluginToolName(pluginName: string, toolName: string): string {
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) throw new Error(`plugin tool: plugin name must match ${PLUGIN_NAME_PATTERN.source}`);
  if (!PLUGIN_TOOL_NAME_PATTERN.test(toolName)) throw new Error(`plugin tool: tool name must match ${PLUGIN_TOOL_NAME_PATTERN.source}`);
  return `${PLUGIN_TOOL_SOURCE}:${pluginName}:${toolName}`;
}

/** Guard 이름 → (플러그인, 도구). 꼴이 아니면 null */
export function parsePluginToolName(name: string): { plugin: string; tool: string } | null {
  const parts = name.split(':');
  if (parts.length !== 3 || parts[0] !== PLUGIN_TOOL_SOURCE) return null;
  const plugin = parts[1] ?? '';
  const tool = parts[2] ?? '';
  if (!PLUGIN_NAME_PATTERN.test(plugin) || !PLUGIN_TOOL_NAME_PATTERN.test(tool)) return null;
  return { plugin, tool };
}

/** 쓰기 꼴 도구인가 — read 라고 선언한 것만 아니다 */
export function toolNeedsApproval(tool: Pick<ToolContribution, 'access'>): boolean {
  return tool.access !== 'read';
}

export interface PluginToolInfo {
  /** Guard 이름 — evaluateGuard 의 tool */
  readonly name: string;
  readonly plugin: string;
  readonly tool: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly known: boolean;
  readonly needsApproval: boolean;
}

/** PluginRegistry 에서 쓰는 것만(시험에서 가짜로) */
export interface PluginToolHost {
  activePlugins(): ReadonlyArray<{ readonly name: string; readonly state: PluginState; readonly manifest: PluginManifest | null }>;
  fire(event: string, only?: string): Promise<string[]>;
  isRunning(name: string): boolean;
  request(name: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface PluginToolSourceOptions {
  readonly host: PluginToolHost;
  /** 사람이 본 적 있는 도구인가(Guard known). 기본 전부 false */
  readonly isKnown?: (guardName: string) => boolean;
  readonly timeoutMs?: number;
  readonly maxResultChars?: number;
  readonly logger?: { warn: (message: string) => void };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 플러그인이 돌려준 값 → 도구 결과. `{ ok: false, error }` 는 실패 · 문자열 · `{ text }` 는 그 글자 · 그 밖은 JSON.
 * 글자 상한을 넘으면 자르고 truncated.
 */
export function toolResultFromPlugin(raw: unknown, maxChars = PLUGIN_TOOL_MAX_RESULT_CHARS): ToolCallResult {
  if (isObject(raw) && raw['ok'] === false) {
    const error = typeof raw['error'] === 'string' ? raw['error'] : 'plugin tool failed';
    return { ok: false, error: error.slice(0, maxChars), truncated: error.length > maxChars };
  }
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (isObject(raw) && typeof raw['text'] === 'string') text = raw['text'];
  else {
    try {
      text = JSON.stringify(raw ?? null);
    } catch {
      return { ok: false, error: 'plugin tool result is not serializable', truncated: false };
    }
  }
  return text.length > maxChars ? { ok: true, text: text.slice(0, maxChars), truncated: true } : { ok: true, text, truncated: false };
}

export class PluginToolSource {
  private readonly timeoutMs: number;
  private readonly maxResultChars: number;

  constructor(private readonly options: PluginToolSourceOptions) {
    this.timeoutMs = options.timeoutMs ?? PLUGIN_TOOL_TIMEOUT_MS;
    this.maxResultChars = options.maxResultChars ?? PLUGIN_TOOL_MAX_RESULT_CHARS;
  }

  /** active 플러그인의 선언한 도구 전부(떠 있지 않아도 — 불릴 때 깨운다). 이름이 깨진 것은 빼고 경고 */
  listTools(): PluginToolInfo[] {
    const out: PluginToolInfo[] = [];
    for (const plugin of this.options.host.activePlugins()) {
      if (plugin.state !== 'active' || !plugin.manifest) continue;
      for (const tool of plugin.manifest.contributes.tools) {
        let name: string;
        try {
          name = pluginToolName(plugin.name, tool.name);
        } catch (error) {
          this.options.logger?.warn(`[plugin] skipped tool "${tool.name.slice(0, 80)}" of ${plugin.name}: ${errorText(error)}`);
          continue;
        }
        out.push({
          name,
          plugin: plugin.name,
          tool: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          known: this.options.isKnown ? this.options.isKnown(name) : false,
          needsApproval: toolNeedsApproval(tool),
        });
      }
    }
    return out;
  }

  /** Guard 이름으로 부른다. 던지지 않는다. 부를 때 다시 본다 — 그 사이 비활성 · 도구가 빠진 판으로 update 됐으면 거부 */
  async callTool(guardName: string, args: Record<string, unknown>, ctx: ToolCallContext = {}): Promise<ToolCallResult> {
    const parsed = parsePluginToolName(guardName);
    if (!parsed) return { ok: false, error: `not a plugin tool name "${guardName.slice(0, 200)}"`, truncated: false };
    const { plugin, tool } = parsed;
    const descriptor = this.options.host.activePlugins().find((p) => p.name === plugin);
    if (!descriptor?.manifest || descriptor.state !== 'active') return { ok: false, error: `plugin "${plugin}" is not active`, truncated: false };
    if (!descriptor.manifest.contributes.tools.some((t) => t.name === tool)) {
      return { ok: false, error: `plugin "${plugin}" does not declare tool "${tool}"`, truncated: false };
    }
    if (ctx.signal?.aborted) return { ok: false, error: 'aborted', truncated: false };
    try {
      if (!this.options.host.isRunning(plugin)) await this.options.host.fire(`onTool:${tool}`, plugin);
      if (!this.options.host.isRunning(plugin)) return { ok: false, error: `plugin "${plugin}" is not running (no onTool:${tool} activation or activation failed)`, truncated: false };
      const request = this.options.host.request(plugin, `${PLUGIN_TOOL_METHOD_PREFIX}${tool}`, args, ctx.timeoutMs ?? this.timeoutMs);
      const raw = await (ctx.signal ? raceAbort(request, ctx.signal) : request);
      return toolResultFromPlugin(raw, this.maxResultChars);
    } catch (error) {
      return { ok: false, error: `${guardName}: ${errorText(error)}`, truncated: false };
    }
  }
}

/** RPC 는 취소가 없다 — 중단 신호가 오면 기다림만 끝낸다(플러그인 쪽 일은 끝까지 돌 수 있다 · 답은 버린다) */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
