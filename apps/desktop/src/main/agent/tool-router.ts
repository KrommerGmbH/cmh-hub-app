// RA — 도구 출처 셋을 하나로 모은다: ①MCP(켠 서버의 도구) ②앱 내장 도구(`app:<이름>`) ③브라우저 도구(`browser:<이름>` · 1차는 인터페이스만).
// electron 을 import 하지 않는 순수 모듈. 근거: cmhcore `.plan/CmhHub/cmh-hub-app/PLAN.md` «✅ opus 검수 반영 — 합의안» · `#### [ ] RA.`
// 🔴 Guard 평가 · 승인 관문은 여기서 하지 않는다 — AgentRunner 가 `call` 앞에서 한다. 여기는 «이름 → 출처» 와 «모델에게 줄 목록» 만.
// 🔴 call 은 던지지 않는다 — 모든 실패는 `{ ok: false, error }`.
//
// 이름이 둘이다: ①Guard 이름(`mcp:<서버 code>:<도구>` 등 · `:` 로 마디를 나눔 · guard-policy.ts 규칙) ②모델 이름(OpenAI function name).
// 모델 이름은 `[A-Za-z0-9_-]` 64자 안으로 바꾼다 — OpenAI function name 규칙(a-z A-Z 0-9 _ - · 최대 64자)은 OpenAI API 문서의 것이고
// 이 저장소 안에서 근거 파일은 못 찾았다(node_modules 검색 0건). 어느 공급자든 받는 쪽으로 좁혀 둔다.
import type { ChatToolDefinition } from '../models/model-provider.js';
import { errorText } from '../models/model-provider.js';
import type { McpCallOptions, McpCallResult, McpServerManager, McpServerState, McpToolList } from '../mcp/mcp-server-manager.js';
import { mcpToolName } from '../settings/guard-policy.js';

export type ToolSource = 'mcp' | 'app' | 'browser';

/** 도구 결과. truncated = 도구 쪽에서 이미 잘랐다 */
export type ToolCallResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string; truncated: boolean };

export interface ToolCallContext {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RoutedTool {
  /** Guard 이름 — evaluateGuard 의 `tool` */
  readonly name: string;
  /** 모델 이름 — ChatToolDefinition.function.name */
  readonly modelName: string;
  readonly source: ToolSource;
  readonly description: string | null;
  readonly parameters: Record<string, unknown>;
  /** 처음 보는 외부 도구면 false(Guard 가 최소 ask) */
  readonly known: boolean;
  /** true 면 Guard 가 allow 여도 승인 관문 */
  readonly needsApproval: boolean;
  /** false 면 모델에게 주는 목록에서 뺀다(공급자 없는 웹 검색 등) — 불리면 여전히 오류 결과 */
  readonly available: boolean;
}

// ---------------------------------------------------------------- 출처 ①: MCP

/** McpServerManager 에서 쓰는 것만(시험에서 가짜로 갈아 끼우려고) */
export interface McpToolSource {
  listStates(): ReadonlyArray<Pick<McpServerState, 'code' | 'status'>>;
  listTools(code: string): Promise<McpToolList>;
  callTool(code: string, toolName: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<McpCallResult>;
}

/** 진짜 매니저가 McpToolSource 꼴에 맞는지 컴파일 때 확인하는 자리 */
export function mcpToolSource(manager: McpServerManager): McpToolSource {
  return manager;
}

export interface McpRouteOptions {
  readonly manager: McpToolSource;
  /** 모델에게 보여 줄 서버 code(«켠 서버만» · 토큰 절약). 없으면 연결된 서버 전부 */
  readonly serverCodes?: readonly string[];
  /**
   * 이 도구를 전에 사람이 본 적이 있나(Guard `known`). 기본: 전부 false → 처음 보는 외부 MCP 도구 기본 ask(합의안 5).
   * 다음 차례: `cmh_ai_mcp_tool` 행이 있으면 true.
   */
  readonly isKnown?: (serverCode: string, toolName: string) => boolean;
}

// ---------------------------------------------------------------- 출처 ②: 앱 내장

export interface AppTool {
  /** `app:` 뒤 이름 — 한 마디(`[A-Za-z0-9_.-]`) */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly needsApproval?: boolean;
  /** false 를 돌려주면 모델 목록에서 뺀다 */
  readonly available?: () => boolean;
  /** 던져도 된다 — router 가 받아 `{ ok: false }` 로 바꾼다 */
  run(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolCallResult> | ToolCallResult;
}

/** 1차 본보기 — 받은 text 를 그대로 돌려준다 */
export function createEchoTool(): AppTool {
  return {
    name: 'echo',
    description: 'Return the given text unchanged.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run(args) {
      const text = args['text'];
      if (typeof text !== 'string') return { ok: false, error: 'echo: "text" must be a string', truncated: false };
      return { ok: true, text, truncated: false };
    },
  };
}

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** 웹 검색 공급자 — ⏸ 어느 공급자를 쓸지 미정(PLAN RA «웹 검색 공급자는 ⏸»). 정해지면 이 꼴로 주입 */
export interface WebSearchProvider {
  readonly id: string;
  search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<WebSearchHit[]>;
}

export const WEB_SEARCH_NO_PROVIDER = '검색 공급자 없음';
const WEB_SEARCH_MAX_HITS = 10;

/** `app:web_search` 자리. 공급자가 없으면 목록에서 빠지고(available false) 불리면 «검색 공급자 없음» 오류 */
export function createWebSearchTool(provider: WebSearchProvider | null): AppTool {
  return {
    name: 'web_search',
    description: 'Search the public web. Returns title, url and snippet per hit.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: WEB_SEARCH_MAX_HITS } },
      required: ['query'],
    },
    available: () => provider !== null,
    async run(args, ctx) {
      if (provider === null) return { ok: false, error: WEB_SEARCH_NO_PROVIDER, truncated: false };
      const query = args['query'];
      if (typeof query !== 'string' || query.trim().length === 0) {
        return { ok: false, error: 'web_search: "query" must be a non-empty string', truncated: false };
      }
      const rawLimit = args['limit'];
      const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), WEB_SEARCH_MAX_HITS) : 5;
      const hits = await provider.search(query, ctx.signal ? { limit, signal: ctx.signal } : { limit });
      return { ok: true, text: JSON.stringify(hits.slice(0, limit)), truncated: hits.length > limit };
    },
  };
}

// ---------------------------------------------------------------- 출처 ③: 브라우저(1차는 인터페이스만)

export interface BrowserToolInfo {
  /** `browser:` 뒤 이름 — 한 마디 */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** 사람이 본 적 있는 도구인가. 기본 false(Guard 최소 ask) — 다리를 붙일 때 근거(저장 행)가 있어야 true(RA 검수 4 권고 9) */
  readonly known?: boolean;
  /** 기본 true(승인 관문) — 다리가 읽기 도구라고 명시(false)해야 빠진다(RA 검수 4 권고 9) */
  readonly needsApproval?: boolean;
}

/**
 * 브라우저 도구 다리. 연결은 다음 차례 — 네이버는 U11 크롬 확장 브리지 길만(Electron pane 자동화 0 · PLAN RA «9. 예외»).
 * 🔴 Guard 의 마켓 쓰기 규칙(`isMarketWrite`)은 `market:*` 와 `mcp:<마켓 서버 code>:*`(guard-policy.ts MARKET_MCP_SERVER_CODES)에만 걸린다 —
 * `browser:*` 로 들어오는 마켓 쓰기는 다리가 needsApproval true 를 붙여야 승인 관문을 지난다(기본이 true · 이름 규칙은 다리를 붙일 때 정한다).
 * listTools 는 ToolRouterOptions.browserListTimeoutMs 안에 끝나야 한다 — 넘으면 그 출처를 빼고 errors 에 적는다(검수 5 권고 1).
 */
export interface BrowserToolBridge {
  listTools(): Promise<BrowserToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolCallResult>;
}

// ---------------------------------------------------------------- router

export interface ToolDefinitionLimits {
  /** 모델에게 줄 도구 수 상한 */
  readonly maxTools: number;
  /** 도구 설명 글 상한(넘으면 자르고 `…`) */
  readonly maxDescriptionChars: number;
  /** 도구 정의 JSON 글자 합 상한(토큰 어림 · 넘는 도구부터 뺀다) */
  readonly maxTotalChars: number;
  /** false 를 돌려준 도구는 뺀다(예: Guard 가 이름만으로 deny 하는 도구 — 토큰 절약) */
  readonly filter?: (tool: RoutedTool) => boolean;
}

/** 【임시 기본값 · 근거 없음】 다음 차례에 `cmh_ai_agent` 테이블 값으로 */
export const TOOL_DEFINITION_DEFAULTS: ToolDefinitionLimits = {
  maxTools: 32,
  maxDescriptionChars: 300,
  maxTotalChars: 24_000,
};

export interface ToolDefinitionSet {
  readonly tools: ChatToolDefinition[];
  /** 상한 · filter 로 뺀 도구의 Guard 이름 */
  readonly dropped: string[];
  /**
   * 이번에 모델에게 보여 준 도구만 담은 이름 표(키 = 모델 이름과 Guard 이름 · 값 = 그때의 도구). run 마다 한 번 받아 고정한다 —
   * AgentRunner 는 이 표로만 찾는다(RA 검수 4 권고 3 · 10): refresh 로 등록 차례가 바뀌어도 이 run 안에서 이름이 다른 도구로 넘어가지 않고,
   * 상한 · filter · available 로 빠진 도구는 이름을 알아도 불리지 않는다.
   */
  readonly byName: ReadonlyMap<string, RoutedTool>;
}

export interface ToolRouterOptions {
  readonly mcp?: McpRouteOptions;
  readonly appTools?: readonly AppTool[];
  readonly browser?: BrowserToolBridge;
  /** 브라우저 다리 listTools 시간 상한(ms) — 기본 BROWSER_LIST_TIMEOUT_MS */
  readonly browserListTimeoutMs?: number;
  readonly logger?: { warn: (message: string) => void };
}

/** 【AI 임시 결정】 브라우저 다리 listTools 시간 상한 기본값 10초 — 근거 없음 · 다리를 붙일 때(U11 크롬 확장 브리지) 잰 값으로 바꾼다 */
export const BROWSER_LIST_TIMEOUT_MS = 10_000;

/** p 가 ms 안에 안 끝나면 예외(타이머는 끝나면 치운다) */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Route =
  | { readonly kind: 'mcp'; readonly serverCode: string; readonly toolName: string }
  | { readonly kind: 'app'; readonly tool: AppTool }
  | { readonly kind: 'browser'; readonly toolName: string };

interface CatalogEntry {
  readonly tool: RoutedTool;
  readonly route: Route;
}

const MODEL_NAME_MAX = 64;
const MODEL_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** FNV-1a 32비트 — 긴 이름을 줄일 때 꼬리표(결정적) */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Guard 이름 → 모델 이름 후보. `:` → `__` · 그 밖 허용 밖 글자 → `_` · 64자 넘으면 앞 55자 + `_` + 해시 8자 */
export function toModelName(guardName: string): string {
  const base = guardName.replace(/:/g, '__').replace(MODEL_NAME_CHARS, '_');
  if (base.length <= MODEL_NAME_MAX) return base;
  return `${base.slice(0, MODEL_NAME_MAX - 9)}_${fnv1a(guardName)}`;
}

function nameSegmentOk(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

export class ToolRouter {
  private readonly mcp: McpRouteOptions | undefined;
  private readonly appTools: readonly AppTool[];
  private readonly browser: BrowserToolBridge | undefined;
  private readonly browserListTimeoutMs: number;
  private readonly logger: { warn: (message: string) => void };
  /** 차례 = 등록 차례(앱 → 브라우저 → MCP 서버 차례). 상한으로 뺄 때 뒤에서부터 빠진다 */
  private catalog: CatalogEntry[] = [];
  private byGuardName = new Map<string, CatalogEntry>();
  private byModelName = new Map<string, CatalogEntry>();

  constructor(options: ToolRouterOptions = {}) {
    this.mcp = options.mcp;
    this.appTools = options.appTools ?? [];
    this.browser = options.browser;
    this.browserListTimeoutMs = options.browserListTimeoutMs ?? BROWSER_LIST_TIMEOUT_MS;
    this.logger = options.logger ?? { warn: () => undefined };
    for (const t of this.appTools) {
      if (!nameSegmentOk(t.name)) throw new Error(`tool router: app tool name must match [A-Za-z0-9_.-]+ ("${t.name}")`);
    }
    if (new Set(this.appTools.map((t) => t.name)).size !== this.appTools.length) throw new Error('tool router: duplicate app tool name');
    this.rebuild(this.appEntries());
  }

  /**
   * 세 출처에서 도구 목록을 다시 모은다. 던지지 않는다 — 출처 하나가 실패하면 그 출처를 빼고 `errors` 에 적는다
   * (부르는 쪽이 조용히 넘기지 않게 이벤트로 낸다).
   */
  async refresh(): Promise<{ errors: string[] }> {
    const errors: string[] = [];
    const entries = this.appEntries();

    if (this.browser) {
      try {
        const browser = this.browser;
        const infos = await withTimeout(
          Promise.resolve().then(() => browser.listTools()),
          this.browserListTimeoutMs,
          'browser: tools list',
        );
        for (const info of infos) {
          if (!nameSegmentOk(info.name)) {
            errors.push(`browser: skipped tool "${info.name.slice(0, 80)}" — name must match [A-Za-z0-9_.-]+`);
            continue;
          }
          entries.push({
            // 다리를 붙이기 전까지는 막는 쪽 기본값 — known false · needsApproval true(명시한 값만 바꾼다)
            tool: this.routed(`browser:${info.name}`, 'browser', info.description, info.parameters, info.known === true, info.needsApproval !== false, true),
            route: { kind: 'browser', toolName: info.name },
          });
        }
      } catch (e) {
        errors.push(`browser: tools list failed: ${errorText(e)}`);
      }
    }

    if (this.mcp) {
      const { manager, serverCodes, isKnown } = this.mcp;
      const connected = manager.listStates().filter((s) => s.status === 'connected').map((s) => s.code);
      const codes = serverCodes ? serverCodes.filter((c) => connected.includes(c)) : connected;
      for (const code of serverCodes ?? []) {
        if (!connected.includes(code)) errors.push(`mcp: server "${code}" is not connected — its tools are not offered`);
      }
      for (const code of codes) {
        let list: McpToolList;
        try {
          list = await manager.listTools(code);
        } catch (e) {
          errors.push(`mcp: ${code}: tools list failed: ${errorText(e)}`);
          continue;
        }
        for (const w of list.warnings) this.logger.warn(`[agent] ${w}`);
        for (const row of list.tools) {
          let guardName: string;
          try {
            guardName = mcpToolName(code, row.name);
          } catch (e) {
            errors.push(`mcp: ${code}: skipped tool "${row.name.slice(0, 80)}": ${errorText(e)}`);
            continue;
          }
          const known = isKnown ? isKnown(code, row.name) : false;
          entries.push({
            tool: this.routed(guardName, 'mcp', row.description, row.parameters, known, row.needsApproval, true),
            route: { kind: 'mcp', serverCode: code, toolName: row.name },
          });
        }
      }
    }

    this.rebuild(entries);
    return { errors };
  }

  /** 지금 목록 전체(available false 포함) */
  list(): RoutedTool[] {
    return this.catalog.map((e) => e.tool);
  }

  /** 모델이 부른 이름(모델 이름 또는 Guard 이름) → 도구. 없으면 null */
  lookup(name: string): RoutedTool | null {
    return (this.byModelName.get(name) ?? this.byGuardName.get(name))?.tool ?? null;
  }

  /** 모델에게 줄 OpenAI function 목록 — available · filter · 도구 수 · 설명 길이 · 글자 합 상한으로 자른다 */
  definitions(limits: ToolDefinitionLimits = TOOL_DEFINITION_DEFAULTS): ToolDefinitionSet {
    const tools: ChatToolDefinition[] = [];
    const dropped: string[] = [];
    const byName = new Map<string, RoutedTool>();
    let total = 0;
    for (const { tool } of this.catalog) {
      if (!tool.available) continue; // 공급자 없는 도구는 «뺀 것» 이 아니라 «없는 것»
      if (limits.filter && !limits.filter(tool)) {
        dropped.push(tool.name);
        continue;
      }
      let description = tool.description ?? '';
      if (description.length > limits.maxDescriptionChars) description = `${description.slice(0, limits.maxDescriptionChars)}…`;
      const def: ChatToolDefinition = {
        type: 'function',
        function: description.length > 0
          ? { name: tool.modelName, description, parameters: tool.parameters }
          : { name: tool.modelName, parameters: tool.parameters },
      };
      const size = JSON.stringify(def).length;
      if (tools.length >= limits.maxTools || total + size > limits.maxTotalChars) {
        dropped.push(tool.name);
        continue;
      }
      tools.push(def);
      byName.set(tool.modelName, tool);
      byName.set(tool.name, tool);
      total += size;
    }
    if (dropped.length > 0) this.logger.warn(`[agent] tool definitions: dropped ${dropped.length} (${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ', …' : ''})`);
    return { tools, dropped, byName };
  }

  /** Guard 이름으로 부른다. 던지지 않는다 */
  async call(guardName: string, args: Record<string, unknown>, ctx: ToolCallContext = {}): Promise<ToolCallResult> {
    const entry = this.byGuardName.get(guardName);
    if (!entry) return { ok: false, error: `unknown tool "${guardName}"`, truncated: false };
    try {
      switch (entry.route.kind) {
        case 'app':
          return await entry.route.tool.run(args, ctx);
        case 'browser': {
          if (!this.browser) return { ok: false, error: 'browser bridge is not connected', truncated: false };
          return await this.browser.callTool(entry.route.toolName, args, ctx);
        }
        case 'mcp': {
          if (!this.mcp) return { ok: false, error: 'mcp manager is not configured', truncated: false };
          const opts: McpCallOptions = {};
          if (ctx.signal) opts.signal = ctx.signal;
          if (ctx.timeoutMs !== undefined) opts.timeoutMs = ctx.timeoutMs;
          const r = await this.mcp.manager.callTool(entry.route.serverCode, entry.route.toolName, args, opts);
          return r.ok ? { ok: true, text: r.text, truncated: r.truncated } : { ok: false, error: r.error, truncated: r.truncated };
        }
      }
    } catch (e) {
      return { ok: false, error: `${guardName}: ${errorText(e)}`, truncated: false };
    }
  }

  private appEntries(): CatalogEntry[] {
    return this.appTools.map((t) => ({
      tool: this.routed(`app:${t.name}`, 'app', t.description, t.parameters, true, t.needsApproval === true, t.available ? t.available() : true),
      route: { kind: 'app', tool: t } as const,
    }));
  }

  private routed(
    name: string,
    source: ToolSource,
    description: string | null,
    parameters: Record<string, unknown>,
    known: boolean,
    needsApproval: boolean,
    available: boolean,
  ): RoutedTool {
    // modelName 은 rebuild 가 겹침을 풀며 채운다
    return { name, modelName: '', source, description, parameters, known, needsApproval, available };
  }

  /**
   * 모델 이름 겹침 풀기 — 겹치면 `_2` · `_3` …(64자 안으로).
   * 겹침은 Guard 이름 차례(정렬)로 푼다 — 같은 도구 모음이면 등록 차례와 상관없이 같은 이름이 나온다(RA 검수 4 R5).
   * catalog 차례(상한으로 뺄 때의 차례)는 등록 차례 그대로 둔다.
   */
  private rebuild(entries: CatalogEntry[]): void {
    const unique: CatalogEntry[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.tool.name)) {
        this.logger.warn(`[agent] duplicate tool name "${e.tool.name}" — kept the first`);
        continue;
      }
      seen.add(e.tool.name);
      unique.push(e);
    }
    const modelNameOf = new Map<string, string>();
    const taken = new Set<string>();
    for (const name of [...seen].sort()) {
      const base = toModelName(name);
      let modelName = base;
      for (let n = 2; taken.has(modelName); n += 1) {
        const suffix = `_${n}`;
        modelName = `${base.slice(0, MODEL_NAME_MAX - suffix.length)}${suffix}`;
      }
      taken.add(modelName);
      modelNameOf.set(name, modelName);
    }
    const byGuardName = new Map<string, CatalogEntry>();
    const byModelName = new Map<string, CatalogEntry>();
    const catalog: CatalogEntry[] = [];
    for (const e of unique) {
      const modelName = modelNameOf.get(e.tool.name) ?? toModelName(e.tool.name);
      const entry: CatalogEntry = { tool: { ...e.tool, modelName }, route: e.route };
      byGuardName.set(entry.tool.name, entry);
      byModelName.set(modelName, entry);
      catalog.push(entry);
    }
    this.catalog = catalog;
    this.byGuardName = byGuardName;
    this.byModelName = byModelName;
  }
}
