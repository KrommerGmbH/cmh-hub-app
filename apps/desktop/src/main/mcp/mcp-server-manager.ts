// R3-b — 사용자가 켠 MCP 서버(stdio · Streamable HTTP)에 붙어 도구 목록 · 도구 호출 · 프롬프트를 다룬다. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» · `#### [ ] R3.` · `research/04-mcp-skills-sqlite.md` §1.
// API 는 `node_modules/@modelcontextprotocol/client` 2.3.1 의 d.ts 를 읽고 썼다(`Client` · `StreamableHTTPClientTransport` · `/stdio` 의 `StdioClientTransport` · `getDefaultEnvironment`).
// 🔴 비밀값(env 값 · http 헤더 값)은 `resolveSecret` 로 연결할 때만 꺼내 메모리에만 둔다 — 로그 · 예외 · errorMessage · 도구 결과 글에서 값은 `***` 로 가린다.
// 🔴 Guard(allow/ask/deny)와 승인 관문은 여기서 부르지 않는다 — 도구 호출 앞단(RA `AgentRunner` · R7 Guard)의 몫이다. 이 모듈은 «켠 서버만 띄운다» 와 «받아들인 도구만 부른다» 까지만 지킨다.
//    다만 도구 행의 `needsApproval`(= `cmh_ai_mcp_tool.needs_approval`)은 여기서 채운다 — 저장된 행(사람이 정한 값)이 이기고 처음 보는 도구는 이름 규칙
//    (3차 검수 차단 1 · 검수 5 차단 2 로 거꾸로: 읽기 꼴 이름만 false · 나머지는 true).
// 행 꼴은 서버 `cmh_ai_mcp_server` · `cmh_ai_mcp_tool` 칸 이름(camelCase)과 맞춘다(research/05). `mcp-config-import.ts` 와는 일부러 묶지 않았다(입력 꼴을 여기서 따로 정의).
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ContentBlock, FetchLike, StreamableHTTPClientTransportOptions, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import { isReadLikeToolName } from '../settings/guard-policy.js';

export type McpServerType = 'stdio' | 'http';

/** = 서버 `cmh_ai_mcp_server` 한 행(camelCase) · 비밀값은 없다(이름만) */
export interface McpServerRow {
  id: string;
  code: string;
  name: string;
  type: McpServerType;
  command: string | null;
  args: string[];
  url: string | null;
  /**
   * = `env_keys` · 값은 `resolveSecret(id, 이름)` 으로.
   * stdio 는 자식 env 이름 · http 는 요청 헤더 이름(서버 테이블에 헤더 칸이 따로 없어서 같은 칸을 쓴다 — 【AI 임시 결정】).
   */
  envKeys: string[];
  active: boolean;
}

/** 값이 없으면 null. 값은 연결하는 동안만 메모리에 둔다 */
export type ResolveSecret = (serverId: string, name: string) => Promise<string | null>;

export type McpServerStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export interface McpServerState {
  code: string;
  serverId: string;
  status: McpServerStatus;
  /** 로그용 영문 · 비밀값은 `***` 로 가렸다 */
  errorMessage: string | null;
  /** 화면 글은 이 스니펫 키로(R8) */
  errorKey: string | null;
  /** stdio 자식 pid · http 는 null */
  pid: number | null;
  /** 협상된 규격 판(예 `2026-07-28` · 옛 서버면 `2025-11-25`) */
  protocolVersion: string | null;
}

/** = 서버 `cmh_ai_mcp_tool` 한 행(camelCase · id 없음 — 저장은 R1 Repository 몫) */
export interface McpToolRow {
  serverId: string;
  /** String(64) */
  name: string;
  title: string | null;
  description: string | null;
  /** 도구 `inputSchema`(JSON Schema) 그대로 */
  parameters: Record<string, unknown>;
  /** 저장 행이 active=false 인 도구는 목록에서 빠지므로 늘 true */
  active: true;
  /** = `cmh_ai_mcp_tool.needs_approval`. 저장 행 값이 이기고 · 없으면 이름 규칙(defaultNeedsApproval) */
  needsApproval: boolean;
}

/** 저장된 `cmh_ai_mcp_tool` 행 중 매니저가 보는 칸(R1 Repository 가 채워 준다) */
export interface McpKnownToolRow {
  name: string;
  needsApproval: boolean;
  active: boolean;
}

/** 서버 id 로 저장된 도구 행을 돌려준다 — 없으면 빈 목록 */
export type KnownToolRows = (serverId: string) => Promise<McpKnownToolRow[]>;

export interface McpToolList {
  tools: McpToolRow[];
  /** 로그용 영문(건너뛴 도구 · 자른 설명) */
  warnings: string[];
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpCallResult =
  | { ok: true; text: string; truncated: boolean; bytes: number }
  | { ok: false; error: string; errorKey: string; truncated: boolean };

export interface McpPromptArgument {
  name: string;
  description: string | null;
  required: boolean;
}

export interface McpPromptRow {
  serverId: string;
  code: string;
  name: string;
  title: string | null;
  description: string | null;
  arguments: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: string;
  text: string;
}

export interface McpPromptResult {
  description: string | null;
  messages: McpPromptMessage[];
}

export interface McpCloseResult {
  code: string;
  /** stdio 자식 pid 가 사라졌는지(http · 연결 없음은 true) */
  exited: boolean;
}

export interface McpServerManagerOptions {
  resolveSecret: ResolveSecret;
  clientInfo?: { name: string; version: string };
  /** 연결(규격 판 떠보기 + initialize) 전체 상한 */
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** 토큰 상한(합의안 권고) — 한 서버에서 받아들일 도구 수 */
  maxTools?: number;
  /** 토큰 상한 — 도구 설명 글자 수 */
  maxDescriptionChars?: number;
  /** 토큰 상한 — 도구 `inputSchema` JSON 크기(UTF-8 바이트) · 넘으면 그 도구를 건너뛴다 */
  maxSchemaBytes?: number;
  /** 토큰 상한 — 한 서버에서 받아들일 프롬프트 수 */
  maxPrompts?: number;
  /** 도구 결과 · 프롬프트 메시지 글 크기 상한(UTF-8 바이트) */
  maxResultBytes?: number;
  /** close 뒤 자식 pid 가 사라지기를 기다리는 시간 · 넘으면 SIGKILL */
  closeTimeoutMs?: number;
  /** http 전송의 fetch(시험 · Electron `net.fetch` 바꿔 끼우기용) */
  httpFetch?: FetchLike;
  /** 저장된 `cmh_ai_mcp_tool` 행(needs_approval · active) — 없으면 빈 목록으로 보고 이름 규칙만 쓴다 */
  knownToolRows?: KnownToolRows;
  logger?: { warn: (message: string) => void };
}

export const MCP_DEFAULTS = {
  connectTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  maxTools: 64,
  maxDescriptionChars: 1000,
  maxSchemaBytes: 8 * 1024,
  maxPrompts: 64,
  maxResultBytes: 64 * 1024,
  closeTimeoutMs: 5_000,
} as const;

/** 서버 `cmh_ai_mcp_tool.name` String(64) */
export const MCP_TOOL_NAME_MAX = 64;

/** 화면에 보일 글은 이 키로(R8 스니펫 · 키만 여기서 정하고 글은 스니펫 JSON 에) */
export const MCP_SNIPPET_KEYS = {
  runtimeMissing: 'cmh-hub-app.mcp.runtimeMissing',
  secretMissing: 'cmh-hub-app.mcp.secretMissing',
  invalidConfig: 'cmh-hub-app.mcp.invalidConfig',
  connectFailed: 'cmh-hub-app.mcp.connectFailed',
  connectTimeout: 'cmh-hub-app.mcp.connectTimeout',
  connectionClosed: 'cmh-hub-app.mcp.connectionClosed',
  notConnected: 'cmh-hub-app.mcp.notConnected',
  toolNotFound: 'cmh-hub-app.mcp.toolNotFound',
  toolFailed: 'cmh-hub-app.mcp.toolFailed',
  callTimeout: 'cmh-hub-app.mcp.callTimeout',
  callAborted: 'cmh-hub-app.mcp.callAborted',
  callFailed: 'cmh-hub-app.mcp.callFailed',
  promptFailed: 'cmh-hub-app.mcp.promptFailed',
  insecureHttpSecret: 'cmh-hub-app.mcp.insecureHttpSecret',
} as const;

/**
 * 【AI 임시 결정】 저장 행이 없는 처음 보는 도구의 needsApproval 기본값 — 거꾸로 된 규칙(검수 5 차단 2 · E4):
 * 처음 보는 도구는 true(승인 관문) · 이름이 읽기 꼴(guard-policy.ts isReadLikeToolName — 읽기 낱말이 있고 쓰기 낱말이 없음)일 때만 false.
 * 예: browser_api · browser_api_patch · browser_evaluate · market_task_done · talk_send → true / browser_snapshot · market_product_search · dal_get → false.
 * ⚠️ PLAN 결정 21(needsApproval 기본값 «쓰기 꼴 이름만 true»)을 바꾼다 — 낱말 표는 guard-policy.ts READ_TOOL_WORDS · WRITE_TOOL_WORDS 한 곳.
 * 사람이 `cmh_ai_mcp_tool.needs_approval` 을 정하면 그 값이 이긴다(mergeKnownRows).
 */
export function defaultNeedsApproval(toolName: string): boolean {
  return !isReadLikeToolName(toolName);
}

/** 흔한 런타임 — 없으면 «설치 안내» 를 보일 대상(설명용 · 확인은 모든 command 에 한다) */
export const KNOWN_RUNTIMES = ['node', 'npx', 'npm', 'pnpm', 'uv', 'uvx', 'python', 'python3', 'py', 'deno', 'bun', 'docker'] as const;

/** 화면에 보일 글은 snippetKey 로 · message 는 로그용 영문(값 가림) */
export class McpManagerError extends Error {
  readonly snippetKey: string;
  constructor(snippetKey: string, message: string) {
    super(message);
    this.name = 'McpManagerError';
    this.snippetKey = snippetKey;
  }
}

const SECRET_MASK = '***';
const STDERR_TAIL_CHARS = 2000;

interface Entry {
  row: McpServerRow;
  state: McpServerState;
  client: Client | null;
  transport: Transport | null;
  /** 이 연결에 쓴 비밀값 — 가리기용 · close 때 비운다 */
  secrets: string[];
  stderrTail: string;
  /** 띄운 stdio 자식 pid(연결이 실패해도 남는다 · 정리용) */
  spawnedPid: number | null;
  tools: McpToolRow[] | null;
  pending: Promise<McpServerState> | null;
  closing: boolean;
  /** close 진행 중이면 그 결과 — 같은 때 들어온 connect · close 가 기다린다 */
  closePromise: Promise<McpCloseResult> | null;
}

export class McpServerManager {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: Required<Omit<McpServerManagerOptions, 'httpFetch' | 'knownToolRows'>> & Pick<McpServerManagerOptions, 'httpFetch'>;
  private readonly knownToolRows: KnownToolRows;

  constructor(options: McpServerManagerOptions) {
    this.opts = {
      resolveSecret: options.resolveSecret,
      clientInfo: options.clientInfo ?? { name: 'cmh-hub-app', version: '0.1.0' },
      connectTimeoutMs: options.connectTimeoutMs ?? MCP_DEFAULTS.connectTimeoutMs,
      callTimeoutMs: options.callTimeoutMs ?? MCP_DEFAULTS.callTimeoutMs,
      maxTools: options.maxTools ?? MCP_DEFAULTS.maxTools,
      maxDescriptionChars: options.maxDescriptionChars ?? MCP_DEFAULTS.maxDescriptionChars,
      maxSchemaBytes: options.maxSchemaBytes ?? MCP_DEFAULTS.maxSchemaBytes,
      maxPrompts: options.maxPrompts ?? MCP_DEFAULTS.maxPrompts,
      maxResultBytes: options.maxResultBytes ?? MCP_DEFAULTS.maxResultBytes,
      closeTimeoutMs: options.closeTimeoutMs ?? MCP_DEFAULTS.closeTimeoutMs,
      logger: options.logger ?? { warn: (m) => console.warn(m) },
      ...(options.httpFetch ? { httpFetch: options.httpFetch } : {}),
    };
    this.knownToolRows = options.knownToolRows ?? (async () => []);
  }

  getState(code: string): McpServerState | null {
    const e = this.entries.get(code);
    return e ? { ...e.state } : null;
  }

  listStates(): McpServerState[] {
    return [...this.entries.values()].map((e) => ({ ...e.state }));
  }

  /**
   * `active` 인 행만 띄운다(PLAN R3 §9 «사용자가 켠 것만») · 이미 붙었거나 붙는 중이면 그 결과를 돌려준다.
   * close 가 진행 중이면 그 close 가 끝나기를 기다린 뒤 새로 띄운다(닫히는 연결을 «connected» 로 돌려주지 않게 — 3차 검수).
   */
  async connect(row: McpServerRow): Promise<McpServerState> {
    let existing = this.entries.get(row.code);
    while (existing?.closePromise) {
      await existing.closePromise;
      existing = this.entries.get(row.code);
    }
    if (!row.active) {
      if (existing && (existing.state.status === 'connected' || existing.state.status === 'connecting')) await this.close(row.code);
      const entry = this.newEntry(row);
      this.entries.set(row.code, entry);
      return { ...entry.state };
    }
    if (existing?.pending) return existing.pending;
    if (existing?.state.status === 'connected') return { ...existing.state };

    const entry = this.newEntry(row);
    entry.state.status = 'connecting';
    this.entries.set(row.code, entry);
    entry.pending = this.doConnect(entry).finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }

  /**
   * `tools/list` → `cmh_ai_mcp_tool` 꼴로 캐시. `:` 든 이름 · 64자 넘는 이름 · inputSchema 가 maxSchemaBytes 를 넘는 도구는 건너뛴다 · maxTools · maxDescriptionChars 로 자른다.
   * needsApproval · active 는 부를 때마다 저장 행(knownToolRows)과 다시 합친다 — 사람이 바꾼 값이 캐시 때문에 늦게 먹지 않게.
   */
  async listTools(code: string, opts: { refresh?: boolean } = {}): Promise<McpToolList> {
    const entry = this.requireConnected(code);
    const client = entry.client as Client;
    if (entry.tools && !opts.refresh) return { tools: await this.mergeKnownRows(entry, entry.tools, null), warnings: [] };

    let listed;
    try {
      listed = await client.listTools(undefined, { timeout: this.opts.callTimeoutMs, cacheMode: opts.refresh ? 'refresh' : 'use' });
    } catch (e) {
      throw new McpManagerError(MCP_SNIPPET_KEYS.callFailed, `${code}: tools/list failed: ${this.redact(entry, errorText(e))}`);
    }

    const warnings: string[] = [];
    const tools: McpToolRow[] = [];
    let overflow = 0;
    let cutDescriptions = 0;
    for (const tool of listed.tools) {
      // Guard 이름 `mcp:<code>:<tool>` 마디가 깨지므로 받지 않는다
      if (tool.name.includes(':')) {
        warnings.push(`${code}: skipped tool "${tool.name}" — ":" breaks the Guard name mcp:<server>:<tool>`);
        continue;
      }
      if (tool.name.length === 0 || tool.name.length > MCP_TOOL_NAME_MAX) {
        warnings.push(`${code}: skipped tool "${tool.name.slice(0, 80)}" — name must be 1..${MCP_TOOL_NAME_MAX} chars (cmh_ai_mcp_tool.name)`);
        continue;
      }
      // 토큰 상한 — 큰 스키마 하나가 모델 문맥을 다 먹지 않게(3차 검수 권고)
      if (Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), 'utf8') > this.opts.maxSchemaBytes) {
        warnings.push(`${code}: skipped tool "${tool.name}" — inputSchema larger than ${this.opts.maxSchemaBytes} bytes (maxSchemaBytes)`);
        continue;
      }
      if (tools.length >= this.opts.maxTools) {
        overflow++;
        continue;
      }
      let description = tool.description ?? null;
      if (description !== null && description.length > this.opts.maxDescriptionChars) {
        description = `${description.slice(0, this.opts.maxDescriptionChars)}…`;
        cutDescriptions++;
      }
      tools.push({
        serverId: entry.row.id,
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description,
        parameters: { ...(tool.inputSchema as Record<string, unknown>) },
        active: true,
        needsApproval: defaultNeedsApproval(tool.name),
      });
    }
    if (overflow > 0) warnings.push(`${code}: kept ${this.opts.maxTools} tools, dropped ${overflow} (maxTools)`);
    if (cutDescriptions > 0) warnings.push(`${code}: cut ${cutDescriptions} descriptions to ${this.opts.maxDescriptionChars} chars (maxDescriptionChars)`);
    for (const w of warnings) this.opts.logger.warn(`[mcp] ${w}`);

    entry.tools = tools;
    const merged = await this.mergeKnownRows(entry, tools, warnings);
    return { tools: merged, warnings };
  }

  /**
   * 도구 하나를 부른다. 던지지 않는다 — 실패는 `{ ok: false, error, errorKey }`.
   * Guard 평가 · 승인 관문은 부르는 쪽(RA)이 이 함수 앞에서 한다. 여기서는 listTools 가 받아들인 이름만 부른다.
   */
  async callTool(code: string, toolName: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<McpCallResult> {
    const entry = this.entries.get(code);
    if (!entry || entry.state.status !== 'connected' || !entry.client) {
      return { ok: false, error: `${code}: server is not connected`, errorKey: MCP_SNIPPET_KEYS.notConnected, truncated: false };
    }
    try {
      // 저장 행이 active=false 로 바뀐 도구도 막도록 늘 listTools(캐시 + 저장 행 합치기)를 거친다
      const tools = (await this.listTools(code)).tools;
      if (!tools.some((t) => t.name === toolName)) {
        return { ok: false, error: `${code}: unknown or skipped tool "${toolName}"`, errorKey: MCP_SNIPPET_KEYS.toolNotFound, truncated: false };
      }
    } catch (e) {
      return { ok: false, error: this.redact(entry, errorText(e)), errorKey: MCP_SNIPPET_KEYS.callFailed, truncated: false };
    }

    const timeout = opts.timeoutMs ?? this.opts.callTimeoutMs;
    try {
      const result = await entry.client.callTool(
        { name: toolName, arguments: args },
        { timeout, maxTotalTimeout: timeout, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      const cut = truncateBytes(this.redact(entry, contentToText(result.content, result.structuredContent)), this.opts.maxResultBytes);
      if (result.isError) return { ok: false, error: cut.text, errorKey: MCP_SNIPPET_KEYS.toolFailed, truncated: cut.truncated };
      return { ok: true, text: cut.text, truncated: cut.truncated, bytes: cut.bytes };
    } catch (e) {
      // 취소도 SDK 는 REQUEST_TIMEOUT 코드로 던진다(실측) — 우리 signal 을 먼저 본다
      const errorKey = opts.signal?.aborted
        ? MCP_SNIPPET_KEYS.callAborted
        : e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout
          ? MCP_SNIPPET_KEYS.callTimeout
          : MCP_SNIPPET_KEYS.callFailed;
      return { ok: false, error: `${code}/${toolName}: ${this.redact(entry, errorText(e))}`, errorKey, truncated: false };
    }
  }

  /** MCP `prompts/list` → 챗 `/` 목록(PromptStore 가 로컬 `.prompt.md` 와 합친다) */
  async listPrompts(code: string): Promise<McpPromptRow[]> {
    const entry = this.requireConnected(code);
    try {
      const { prompts: all } = await (entry.client as Client).listPrompts(undefined, { timeout: this.opts.callTimeoutMs });
      // 토큰 상한(3차 검수 권고) — 챗 `/` 목록이 끝없이 늘지 않게
      const prompts = all.slice(0, this.opts.maxPrompts);
      if (all.length > prompts.length) this.opts.logger.warn(`[mcp] ${code}: kept ${prompts.length} prompts, dropped ${all.length - prompts.length} (maxPrompts)`);
      return prompts.map((p) => ({
        serverId: entry.row.id,
        code,
        name: p.name,
        title: p.title ?? null,
        description: p.description ?? null,
        arguments: (p.arguments ?? []).map((a) => ({ name: a.name, description: a.description ?? null, required: a.required ?? false })),
      }));
    } catch (e) {
      throw new McpManagerError(MCP_SNIPPET_KEYS.promptFailed, `${code}: prompts/list failed: ${this.redact(entry, errorText(e))}`);
    }
  }

  /** MCP `prompts/get` → 메시지 글(메시지마다 maxResultBytes 로 자름) */
  async getPrompt(code: string, name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    const entry = this.requireConnected(code);
    try {
      const res = await (entry.client as Client).getPrompt({ name, arguments: args }, { timeout: this.opts.callTimeoutMs });
      return {
        description: res.description ?? null,
        messages: res.messages.map((m) => ({
          role: m.role,
          text: truncateBytes(this.redact(entry, contentToText([m.content as ContentBlock], undefined)), this.opts.maxResultBytes).text,
        })),
      };
    } catch (e) {
      throw new McpManagerError(MCP_SNIPPET_KEYS.promptFailed, `${code}: prompts/get "${name}" failed: ${this.redact(entry, errorText(e))}`);
    }
  }

  /**
   * 연결을 닫고 stdio 자식 pid 가 사라질 때까지 기다린다(넘으면 SIGKILL).
   * 붙는 중이면 그 connect 가 끝나기를 기다린다 — 그 connect 결과는 `closed`. 이미 닫는 중이면 같은 결과를 돌려준다.
   */
  async close(code: string): Promise<McpCloseResult> {
    const entry = this.entries.get(code);
    if (!entry) return { code, exited: true };
    if (entry.closePromise) return entry.closePromise;
    entry.closing = true;
    const closing: Promise<McpCloseResult> = this.doClose(entry, code).finally(() => {
      if (entry.closePromise === closing) entry.closePromise = null;
      entry.closing = false;
    });
    entry.closePromise = closing;
    return closing;
  }

  /** 앱 종료 때 부른다(main `before-quit`) */
  async closeAll(): Promise<McpCloseResult[]> {
    return Promise.all([...this.entries.keys()].map((code) => this.close(code)));
  }

  // ── 안쪽 ───────────────────────────────────────────────

  private async doClose(entry: Entry, code: string): Promise<McpCloseResult> {
    if (entry.pending) await entry.pending.catch(() => undefined);
    const exited = await this.teardown(entry);
    entry.state = { ...entry.state, status: 'closed', pid: null };
    entry.tools = null;
    entry.secrets = [];
    return { code, exited };
  }

  /**
   * 서버가 준 도구 + 저장된 `cmh_ai_mcp_tool` 행. 저장 행이 있으면 그 needsApproval 이 이기고 · active=false 면 목록에서 뺀다.
   * 저장 행을 못 읽으면 【AI 임시 결정】 모든 도구를 needsApproval true 로(사람이 정한 true 를 잃지 않게 막는 쪽).
   * warnings 가 null 이면(캐시에서 부름) 경고를 쌓지 않는다.
   */
  private async mergeKnownRows(entry: Entry, tools: readonly McpToolRow[], warnings: string[] | null): Promise<McpToolRow[]> {
    let known: McpKnownToolRow[];
    try {
      known = await this.knownToolRows(entry.row.id);
    } catch (e) {
      this.opts.logger.warn(`[mcp] ${entry.row.code}: stored tool rows unavailable — every tool needs approval: ${this.redact(entry, errorText(e))}`);
      return tools.map((t) => ({ ...t, needsApproval: true }));
    }
    const byName = new Map<string, McpKnownToolRow>();
    for (const k of known) byName.set(k.name, k);
    const out: McpToolRow[] = [];
    const inactive: string[] = [];
    for (const t of tools) {
      const k = byName.get(t.name);
      if (k && !k.active) {
        inactive.push(t.name);
        continue;
      }
      out.push({ ...t, needsApproval: k ? k.needsApproval : t.needsApproval });
    }
    if (warnings && inactive.length > 0) {
      const w = `${entry.row.code}: skipped ${inactive.length} tools turned off in cmh_ai_mcp_tool (active=false): ${inactive.join(', ')}`;
      warnings.push(w);
      this.opts.logger.warn(`[mcp] ${w}`);
    }
    return out;
  }

  private newEntry(row: McpServerRow): Entry {
    return {
      row: { ...row, args: [...row.args], envKeys: [...row.envKeys] },
      state: { code: row.code, serverId: row.id, status: 'idle', errorMessage: null, errorKey: null, pid: null, protocolVersion: null },
      client: null,
      transport: null,
      secrets: [],
      stderrTail: '',
      spawnedPid: null,
      tools: null,
      pending: null,
      closing: false,
      closePromise: null,
    };
  }

  private requireConnected(code: string): Entry {
    const entry = this.entries.get(code);
    if (!entry || entry.state.status !== 'connected' || !entry.client) {
      throw new McpManagerError(MCP_SNIPPET_KEYS.notConnected, `${code}: server is not connected`);
    }
    return entry;
  }

  private async doConnect(entry: Entry): Promise<McpServerState> {
    const row = entry.row;
    const fail = (errorKey: string, message: string): McpServerState => {
      // 붙는 도중 close 가 들어왔으면 결과는 closed(close 가 이긴다)
      if (entry.closing) return closed();
      entry.state = { ...entry.state, status: 'error', errorKey, errorMessage: this.redact(entry, message), pid: null };
      entry.secrets = [];
      return { ...entry.state };
    };
    const closed = (): McpServerState => {
      entry.state = { ...entry.state, status: 'closed', errorKey: null, errorMessage: null, pid: null };
      entry.secrets = [];
      return { ...entry.state };
    };

    let transport: Transport;
    try {
      if (row.type === 'stdio') {
        if (!row.command) return fail(MCP_SNIPPET_KEYS.invalidConfig, `${row.code}: stdio server has no command`);
        const baseEnv = getDefaultEnvironment();
        // 런타임 확인(합의안 S6) — 비밀값을 꺼내기 전에 싼 것부터
        const found = await findExecutable(row.command, baseEnv.PATH ?? '', process.platform, baseEnv.PATHEXT ?? process.env.PATHEXT);
        if (!found) return fail(MCP_SNIPPET_KEYS.runtimeMissing, `${row.code}: command not found on PATH: ${row.command}`);
        if (entry.closing) return closed();
        const secrets = await this.resolveAll(entry);
        if ('missing' in secrets) return fail(MCP_SNIPPET_KEYS.secretMissing, `${row.code}: secret not available: ${secrets.missing}`);
        if (entry.closing) return closed();
        // 부모 env 전체를 넘기지 않는다 — SDK 기본 목록(HOME · PATH 등) + envKeys 만
        const stdio = new StdioClientTransport({
          command: row.command,
          args: [...row.args],
          env: { ...baseEnv, ...secrets.values },
          stderr: 'pipe',
        });
        stdio.stderr?.on('data', (chunk: Buffer | string) => {
          entry.stderrTail = (entry.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        });
        // pid 를 띄운 즉시 적어 둔다 — connect 가 시간초과로 실패하면 SDK 가 transport.close() 를 기다리지 않고 부르고(pid getter 가 null 이 된다)
        // 그 close 는 stdin 닫고 2초 → SIGTERM 이라, 그 사이 우리 프로세스가 끝나면 자식이 고아로 남았다(시험에서 실측).
        // 인스턴스에만 덮어쓴다 — 하위 클래스로 만들면 SDK 가 «정확히 기본 클래스» 가 아니라고 보고 떠보기를 같은 자식에서 한다(index.mjs readStdioServerParams).
        const start = stdio.start.bind(stdio);
        stdio.start = async () => {
          await start();
          entry.spawnedPid = stdio.pid;
        };
        transport = stdio;
      } else {
        if (!row.url) return fail(MCP_SNIPPET_KEYS.invalidConfig, `${row.code}: http server has no url`);
        let url: URL;
        try {
          url = new URL(row.url);
        } catch {
          return fail(MCP_SNIPPET_KEYS.invalidConfig, `${row.code}: invalid url`);
        }
        // 루프백이 아닌 곳으로 비밀 헤더를 평문(http:)으로 보내지 않는다 — 비밀값을 꺼내기 전에 거부(3차 검수 권고)
        if (url.protocol !== 'https:' && !isLoopback(url.hostname) && entry.row.envKeys.length > 0) {
          return fail(MCP_SNIPPET_KEYS.insecureHttpSecret, `${row.code}: refusing to send secret headers over ${url.protocol} to a non-loopback host`);
        }
        const secrets = await this.resolveAll(entry);
        if ('missing' in secrets) return fail(MCP_SNIPPET_KEYS.secretMissing, `${row.code}: secret not available: ${secrets.missing}`);
        if (entry.closing) return closed();
        const httpOpts: StreamableHTTPClientTransportOptions = { requestInit: { headers: { ...secrets.values } } };
        if (this.opts.httpFetch) httpOpts.fetch = this.opts.httpFetch;
        transport = new StreamableHTTPClientTransport(url, httpOpts);
      }
    } catch (e) {
      return fail(MCP_SNIPPET_KEYS.connectFailed, `${row.code}: ${errorText(e)}`);
    }

    // 2026-07-28 서버면 modern · 아니면 옛 initialize 로(ClientOptions.versionNegotiation · stdio 는 떠보기용 자식을 하나 더 잠깐 띄운다)
    const client = new Client(this.opts.clientInfo, { versionNegotiation: { mode: 'auto' } });
    client.onclose = () => this.onConnectionClosed(entry, client);
    client.onerror = (err) => this.opts.logger.warn(`[mcp] ${row.code}: ${this.redact(entry, errorText(err))}`);
    entry.transport = transport;
    entry.client = client;

    const deadline = AbortSignal.timeout(this.opts.connectTimeoutMs);
    try {
      await client.connect(transport, { timeout: this.opts.connectTimeoutMs, signal: deadline });
    } catch (e) {
      const timedOut = deadline.aborted || (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout);
      await this.teardown(entry);
      await new Promise((r) => setImmediate(r)); // stderr 마지막 조각
      const tail = entry.stderrTail.trim();
      return fail(
        timedOut ? MCP_SNIPPET_KEYS.connectTimeout : MCP_SNIPPET_KEYS.connectFailed,
        `${row.code}: ${timedOut ? `connect timed out after ${this.opts.connectTimeoutMs} ms` : errorText(e)}${tail ? `\nstderr: ${tail.slice(-1000)}` : ''}`,
      );
    }
    if (entry.closing) {
      // connect 도중 close — 띄운 것을 걷고 결과는 closed(3차 검수: 전에는 'connecting' 을 돌려줬다)
      await this.teardown(entry);
      return closed();
    }
    entry.state = {
      ...entry.state,
      status: 'connected',
      errorKey: null,
      errorMessage: null,
      pid: transport instanceof StdioClientTransport ? transport.pid : null,
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    };
    return { ...entry.state };
  }

  /** envKeys 를 모두 꺼낸다 — 하나라도 없으면 그 이름을 돌려준다(값 · 예외 글은 안 남긴다) */
  private async resolveAll(entry: Entry): Promise<{ values: Record<string, string> } | { missing: string }> {
    const values: Record<string, string> = {};
    for (const key of entry.row.envKeys) {
      let value: string | null;
      try {
        value = await this.opts.resolveSecret(entry.row.id, key);
      } catch {
        // resolveSecret 예외 글에 값이 섞일 수 있어 버린다
        return { missing: key };
      }
      if (value === null) return { missing: key };
      values[key] = value;
      if (value.length > 0) entry.secrets.push(value);
    }
    return { values };
  }

  /** client · transport 를 닫고 stdio 자식이 사라질 때까지 기다린다(stdin 닫기 → 1초 → SIGTERM → closeTimeoutMs → SIGKILL) */
  private async teardown(entry: Entry): Promise<boolean> {
    const { client, transport } = entry;
    entry.client = null;
    entry.transport = null;
    const pid = (transport instanceof StdioClientTransport ? transport.pid : null) ?? entry.spawnedPid ?? entry.state.pid;
    entry.spawnedPid = null;
    try {
      if (client) await client.close();
    } catch {
      // 이미 닫힘
    }
    try {
      if (transport) await transport.close();
    } catch {
      // 이미 닫힘
    }
    if (pid === null) return true;
    if (await waitForExit(pid, Math.min(1_000, this.opts.closeTimeoutMs))) return true;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        return true; // 이미 사라짐
      }
      if (await waitForExit(pid, signal === 'SIGTERM' ? this.opts.closeTimeoutMs : 1_000)) return true;
    }
    return false;
  }

  private onConnectionClosed(entry: Entry, client: Client): void {
    if (entry.closing || entry.client !== client || entry.state.status !== 'connected') return;
    const tail = entry.stderrTail.trim();
    entry.state = {
      ...entry.state,
      status: 'error',
      errorKey: MCP_SNIPPET_KEYS.connectionClosed,
      errorMessage: this.redact(entry, `${entry.row.code}: connection closed${tail ? `\nstderr: ${tail.slice(-1000)}` : ''}`),
      pid: null,
    };
    entry.client = null;
    entry.transport = null;
    entry.tools = null;
    entry.secrets = [];
  }

  private redact(entry: Entry, text: string): string {
    return redactSecrets(text, entry.secrets);
  }
}

// ── 순수 도우미(시험에서 직접 부른다) ──────────────────────

/**
 * 비밀값을 `***` 로(긴 값부터 — 짧은 값이 긴 값의 일부일 때).
 * 값마다 서버 · 오류 글에 흔히 되비치는 꼴도 가린다(3차 검수 권고): `encodeURIComponent` · base64(덧붙임 `=` 있고 없고) · base64url ·
 * JSON 이스케이프(`"` · `\\` · 제어문자) · 앞의 `Bearer ` 를 뗀 값(그 값의 꼴들도).
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const variants = new Set<string>();
  for (const s of secrets) for (const v of secretVariants(s)) variants.add(v);
  let out = text;
  for (const s of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(SECRET_MASK);
  }
  return out;
}

function secretVariants(secret: string): string[] {
  const bases = [secret];
  const bearer = /^bearer\s+/i.exec(secret);
  if (bearer) bases.push(secret.slice(bearer[0].length));
  const out: string[] = [];
  for (const b of bases) {
    if (b.length === 0) continue;
    const b64 = Buffer.from(b, 'utf8').toString('base64');
    out.push(b, encodeURIComponent(b), b64, b64.replace(/=+$/, ''), Buffer.from(b, 'utf8').toString('base64url'), JSON.stringify(b).slice(1, -1));
  }
  return out.filter((v) => v.length > 0);
}

/** UTF-8 바이트 상한으로 자르고 끝에 표시를 붙인다 */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length };
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1); // 멀티바이트 글자 중간에서 잘린 조각
  return { text: `${cut}\n…[truncated: ${buf.length} bytes, showing ${maxBytes}]`, truncated: true, bytes: buf.length };
}

/** 내용 블록 → 글. 그림 · 소리의 base64 는 넣지 않는다(토큰 절약) */
export function contentToText(content: readonly ContentBlock[] | undefined, structured: unknown): string {
  const parts: string[] = [];
  for (const block of content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'audio':
        parts.push(`[${block.type} ${block.mimeType}, ~${Math.floor((block.data.length * 3) / 4)} bytes]`);
        break;
      case 'resource':
        parts.push('text' in block.resource ? block.resource.text : `[resource ${block.resource.uri}${block.resource.mimeType ? ` ${block.resource.mimeType}` : ''}]`);
        break;
      case 'resource_link':
        parts.push(`[resource_link ${block.uri}]`);
        break;
      default:
        parts.push(`[${(block as { type: string }).type}]`);
    }
  }
  if (parts.length === 0 && structured !== undefined) return JSON.stringify(structured);
  return parts.join('\n');
}

/** PATH 에서 실행 파일을 찾는다(경로가 든 command 는 그 파일이 있는지만). win32 는 PATHEXT 를 붙여 본다 */
export async function findExecutable(command: string, pathValue: string, platform: NodeJS.Platform, pathExt?: string): Promise<string | null> {
  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  const exts = isWin ? ['', ...(pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const hasDir = command.includes('/') || (isWin && command.includes('\\'));
  const candidates: string[] = [];
  if (hasDir || p.isAbsolute(command)) {
    for (const ext of exts) candidates.push(command + ext);
  } else {
    for (const dir of pathValue.split(isWin ? ';' : ':').filter(Boolean)) {
      for (const ext of exts) candidates.push(p.join(dir, command + ext));
    }
  }
  for (const file of candidates) {
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, isWin ? fsConstants.F_OK : fsConstants.X_OK);
      return file;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** `process.kill(pid, 0)` 이 ESRCH 를 던질 때까지(= 사라짐) 기다린다 */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 있지만 권한 없음
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || /^127(\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]' || hostname === '::1';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
