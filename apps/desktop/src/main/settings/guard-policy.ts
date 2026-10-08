// R7-a — Guard 정책 평가기. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// Aside Guard 꼴(research/01 «Guard»): 작업 단위 모드 guard(기본) / full · 도구 권한 allow / ask / deny · 겹치면 deny 가 이긴다.
// 합의안 5(PLAN «opus 검수 반영»): 승인 엔티티 cmh_ai_approval 쓰기는 main 의 UI IPC(사람 클릭)만 → 여기서는 어떤 정책이든 항상 deny.
// 처음 보는 외부 MCP 도구(known=false)는 최소 ask · 마켓 쓰기는 결과가 allow 여도 승인 관문(cmh_ai_approval)을 따로 거친다(requiresApproval).
//
// 도구 이름 규칙(검수 차단 1): `:` 로 나눈 모든 마디가 ASCII `[A-Za-z0-9_.-]+` 여야 한다(소문자로 맞춘 뒤 `^[a-z0-9_.-]+$`).
// 공백 · 제어문자 · zero-width · 전각 · 비ASCII 가 하나라도 있으면 deny — 겉보기만 같은 이름으로 deny 규칙 · 승인 엔티티 검사를 비껴가지 못하게.
// (소문자로 바꾸기 «전에» 검사한다 — Kelvin 기호 U+212A 처럼 toLowerCase 하면 ASCII 'k' 가 되는 글자도 막으려고.)
// 쓰기 보호 엔티티 목록 · 이름 맞추기는 `approval-entity.ts` 한 곳(3차 검수 권고) — 플러그인 매니페스트 · 권한 검사와 같은 목록을 쓴다.
// 검수 5 차단 1(E1 · E2): 승인 결정 도구 이름(market_approval_decide 등) · 승인 엔티티로 가는 연관 칸(approvals 등) 쓰기도 내장 deny — 표는 approval-entity.ts.
// 검수 5 차단 2(E4): 마켓 MCP 서버(`mcp:<마켓 서버>:*`)의 읽기 꼴이 아닌 도구도 마켓 쓰기(requiresApproval) — 서버 code 목록은 MARKET_MCP_SERVER_CODES.
// 검수 9: 마켓 서버는 code 말고 serverInfo.name · command · args · url 로도 알아본다(identifyMcpServer · GuardRequest.server) · 서버 목록은 KNOWN_MCP_SERVERS 한 곳.

import {
  APPROVAL_ASSOCIATION_PATTERN,
  APPROVAL_DECISION_TOOL_PATTERN,
  WRITE_PROTECTED_ENTITIES,
  isApprovalDecisionToolName,
  isApprovalRequestToolName,
  isWriteProtectedEntity,
  mentionsWriteProtectedEntity,
  normalizeEntityName,
  toolNameWords,
} from './approval-entity.js';

export { normalizeEntityName };

export const GUARD_MODES = ['guard', 'full'] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export const TOOL_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

// whileUnlocked 는 Aside 값 — 앱 «잠금» 이 아직 정의되지 않아(합의 ⑨) 기본은 ask
export const CREDENTIAL_ACCESS = ['always', 'whileUnlocked', 'never', 'ask'] as const;
export type CredentialAccess = (typeof CREDENTIAL_ACCESS)[number];

export interface GuardPolicy {
  readonly defaultMode: GuardMode;
  /**
   * 키 = 글롭(`:` 구분 · `*` 한 마디 · `**` 0 마디 이상 · 마디 안 `*` 는 그 마디 안 아무 글자) · 값 = 결정.
   * deny 규칙만: 마디 전체가 `*` 이면 «한 마디 이상»으로 넓혀 읽는다(evaluateGuard 주석).
   */
  readonly tools: Readonly<Record<string, ToolDecision>>;
  /** 키 = 사이트 이름(예 naver) · 값 = 에이전트의 자격증명 접근 */
  readonly credentials: Readonly<Record<string, CredentialAccess>>;
}

export interface GuardTarget {
  /** 범용 DAL 도구(dal_update 등)가 건드리는 엔티티 이름(예 'cmh_ai_approval') */
  readonly entity?: string;
  /** 인자(중첩 data · JSON 글 안 포함)에서 찾은 승인 엔티티 연관 칸 키(예 'approvals') — 읽기 꼴 도구가 아니면 deny(검수 5 E2) */
  readonly association?: string;
}

export interface GuardRequest {
  /** 예 'mcp:cmh-shop-api-mcp:dal_update' · 'market:naver:save' · 'browser:navigate' · 'skill:<name>:script' */
  readonly tool: string;
  /** 처음 보는 외부 도구면 false */
  readonly known: boolean;
  /** 도구 인자에서 꺼낸 대상. entity 가 cmh_ai_approval 이면 읽기 꼴 도구 말고는 deny */
  readonly target?: GuardTarget;
  /** 서버 칸 `cmh_ai_mcp_tool.needs_approval` — true 면 결과가 allow/ask 여도 requiresApproval */
  readonly needsApproval?: boolean;
  /**
   * true = 모델에게 도구를 보일지 정하는 평가(인자가 아직 없다). 이때만 «target 없는 범용 DAL 쓰기 deny» 를 건너뛴다 —
   * 실제 호출 때(listing 없음 · 기본) 인자의 entity 로 다시 평가해서 막는다. 빠지면 호출로 보고 막는 쪽이다.
   */
  readonly listing?: boolean;
  /**
   * MCP 서버를 알아본 결과(mcp-server-manager.ts 가 연결할 때 identifyMcpServer 로 정한다 · 검수 9 🟡2).
   * market=true 면 서버 code 가 MARKET_MCP_SERVER_CODES 에 없어도 마켓 서버로 본다. 없으면 서버 code 로만 본다.
   */
  readonly server?: GuardServerInfo;
}

/** MCP 서버를 알아본 결과 — Guard 가 보는 칸만 */
export interface GuardServerInfo {
  /** 마켓 쓰기를 할 수 있는 서버인가(KNOWN_MCP_SERVERS 의 market) */
  readonly market: boolean;
  /** 알아본 서버 패키지 이름(KNOWN_MCP_SERVERS 의 packageName) · 못 알아봤거나 둘 이상에 맞으면 null */
  readonly knownServer: string | null;
}

export interface GuardResult {
  readonly decision: ToolDecision;
  /** true 면 Guard 를 지나도 cmh_ai_approval 행을 만들고 사람 클릭까지 멈춘다(RA) */
  readonly requiresApproval: boolean;
  /** 결정을 낸 규칙. 정책에 맞는 규칙이 없으면 null · 내장 규칙이면 그 글롭 */
  readonly matchedPattern: string | null;
}

/** 내장 규칙 — 승인 상태 엔티티. 읽기 말고는 정책과 상관없이 deny(합의안 5) · 목록은 approval-entity.ts 의 WRITE_PROTECTED_ENTITIES */
export const APPROVAL_ENTITY = 'cmh_ai_approval';
export const APPROVAL_ENTITY_PATTERN = 'entity:cmh_ai_approval:*';
/** 쓰기 보호 엔티티 deny 의 matchedPattern(`entity:<엔티티>:*`) */
function protectedPattern(name: string): string {
  const n = normalizeEntityName(name);
  const hit = WRITE_PROTECTED_ENTITIES.find((e) => n.replace(/[_.]/g, '').includes(e.replace(/[_.]/g, '')));
  return `entity:${hit ?? APPROVAL_ENTITY}:*`;
}
/** target 없는 범용 DAL 쓰기 deny 의 matchedPattern */
export const DAL_WRITE_WITHOUT_TARGET_PATTERN = 'builtin:dal-write-without-target';

/**
 * 읽기 꼴 동작 이름. 이름을 `-` → `_` 로 맞추고 앞붙이 `dal_` 를 뗀 것이 이 표에 있어야 읽기다.
 * 이 표에 없으면 전부 쓰기로 본다(모르면 막는 쪽) — dal_update · dal_create · dal_delete · dal_upsert · dal_sync · field_save · save:draft …
 * 늘릴 때는 이 표만 고친다.
 */
export const READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'search', 'get', 'list', 'count', 'aggregate', 'find']);

/**
 * 【AI 임시 결정】 도구 이름 낱말(toolNameWords) 중 읽기 꼴 — 쓰기 낱말이 없고 이 낱말이 하나라도 있어야 «읽기 꼴 도구».
 * 처음 보는 MCP 도구의 needsApproval 기본값(mcp-server-manager.ts defaultNeedsApproval) · 마켓 MCP 서버 쓰기 판별이 같이 쓴다.
 * 실제 도구 이름(cmh-mcp packages 의 registerTool 이름 · 2026-10-07 읽음)에 맞춰 골랐다 — 근거 없는 낱말은 넣지 않았다. 늘릴 때는 이 표만.
 */
export const READ_TOOL_WORDS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'search',
  'read',
  'find',
  'count',
  'aggregate',
  'snapshot',
  'status',
  'extract',
  'screenshot',
  'wait',
  'pending',
  'brief',
  'detail',
  'details',
  'capabilities',
  'help',
  'lookup',
  'view',
  'show',
  'describe',
  'info',
  'schema',
  'overview',
  'metrics',
  'stats',
]);

/**
 * 【AI 임시 결정】 쓰기 꼴 낱말 — 읽기 낱말과 같이 있어도 이것이 이긴다(`browser_api_patch` · `search_and_delete` → 쓰기).
 * 명사로도 흔한 낱말(type · act · run · order)은 넣지 않았다 — 읽기 낱말이 없는 이름은 어차피 쓰기로 본다.
 */
export const WRITE_TOOL_WORDS: ReadonlySet<string> = new Set([
  'save',
  'send',
  'delete',
  'del',
  'update',
  'upsert',
  'upload',
  'submit',
  'create',
  'write',
  'remove',
  'publish',
  'post',
  'put',
  'patch',
  'set',
  'insert',
  'apply',
  'commit',
  'approve',
  'reject',
  'decide',
  'hold',
  'done',
  'import',
  'execute',
  'exec',
  'evaluate',
  'eval',
  'click',
  'press',
  'login',
  'logout',
  'pay',
  'purchase',
  'buy',
  'refund',
  'cancel',
  'transfer',
  'move',
  'rename',
  'reset',
  'clear',
  'close',
  'release',
  'claim',
  'assign',
  'change',
  'edit',
  'modify',
  'replace',
  'sync',
  'drop',
  'truncate',
  'kill',
  'restart',
  'install',
]);

/**
 * 도구 이름이 읽기 꼴인가 — 낱말 중 쓰기 낱말이 하나도 없고 읽기 낱말이 하나라도 있을 때만 true. 모르는 이름은 false(막는 쪽).
 * 예: browser_snapshot · market_product_search · dal_get · getPrice → true / browser_api · browser_api_patch · market_task_done → false.
 */
export function isReadLikeToolName(name: string): boolean {
  const words = toolNameWords(name);
  if (words.some((w) => WRITE_TOOL_WORDS.has(w))) return false;
  return words.some((w) => READ_TOOL_WORDS.has(w));
}

/** 우리가 아는 MCP 서버 한 줄 */
export interface KnownMcpServer {
  /** cmh-mcp `packages/<이 이름>`(= package.json name) */
  readonly packageName: string;
  /** MCP initialize 의 serverInfo.name(서버 소스의 `new McpServer({ name })`) */
  readonly serverInfoNames: readonly string[];
  /** 서버 테이블 `cmh_ai_mcp_server.code` 로 쓰이는 이름(CmhAiAgent `src/Service/Agent/CmhAiMcpSeeder.php` 의 code) — 사용자가 고른 code 와만 맞춘다 */
  readonly codes: readonly string[];
  /** true 면 `mcp:<이 서버>:<도구>` 는 읽기 꼴(isNoApprovalToolName)이 아니면 마켓 쓰기(requiresApproval) */
  readonly market: boolean;
  /**
   * 【AI 임시 결정 · 나중에 테이블 행】 이 서버의 읽기 전용 도구(이름이 읽기 꼴이 아니어도 needsApproval false · 마켓 쓰기 아님 · 검수 9 🟢).
   * cmh-mcp 소스를 읽고 «쓰지 않고 돈을 쓰지 않는» 것만 넣었다(근거는 줄마다). 다음 차례에 서버 테이블 행으로 옮긴다.
   */
  readonly readOnlyTools: ReadonlySet<string>;
}

/**
 * 【AI 임시 결정】 우리가 아는 MCP 서버 — 마켓 서버 판별(검수 9 🟡2)과 서버별 읽기 전용 도구(검수 9 🟢)의 단 하나 목록.
 * 근거(cmh-mcp · CmhAiAgent 저장소 · 2026-10-08 읽음):
 *  - serverInfo.name: `cmh-market-mcp/src/index.ts:18` · `cmh-camoufox-mcp/src/index.ts:13`('camoufox-mcp') · `cmh-gateway-mcp/src/index.ts:46` ·
 *    `cmh-naver-api-mcp/src/index.ts:14` · `cmh-crawler-mcp/src/index.ts:12` · `cmh-openrouter-mcp/src/index.ts:131`('openrouter-mcp') · `cmh-shop-api-mcp/src/index.ts:32`
 *  - code: `CmhAiMcpSeeder.php:359`('cmh-market-mcp') · `:452`('cmh-shop-api-mcp') · `:534`('camoufox') · `:576`('cmh-crawler-mcp') · `:593`('cmh-openrouter-mcp')
 *  - cmh-gateway-mcp 를 마켓으로 둔 까닭: 하위 서버 도구를 `<서버키>__<도구>` 로 그대로 내보낸다(`cmh-gateway-mcp/src/filter.ts:57-64`) —
 *    마켓 · camoufox 도구도 이 길로 온다(검수 9 `camoufox__browser_api`). 서버키는 사람이 정해서 읽기 전용 표는 붙이지 않았다.
 * 🔴 다음 차례에 서버 테이블(`cmh_ai_mcp_server` 행의 마켓 표시)에서 읽는다 — 여기 목록은 그때까지의 기본값.
 */
export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = Object.freeze([
  {
    packageName: 'cmh-market-mcp',
    serverInfoNames: ['cmh-market-mcp'],
    codes: ['cmh-market-mcp'],
    market: true,
    readOnlyTools: new Set([
      // 서버 `POST /api/_action/cmh-ai/open-api/keyword-volume` · `tag-suggest`(openapi.service.ts:219-221 · :297) — 마켓에 저장 안 함(openapi.tools.ts:18 · :35).
      // 서버는 쿼터 사용량 칸 · 캐시만 쓴다(CmhAiAgent `CmhAiOpenApiQuota.php:92-131`)
      'market_keyword_volume',
      'market_tag_suggest',
      // GET `talk/threads`(shopware-client.ts:444 · CmhAiKnowledgeController.php:324) · GET `talk/order-candidates`(talk.service.ts:156-157)
      'talk_threads',
      'talk_order_candidates',
    ]),
  },
  {
    packageName: 'cmh-camoufox-mcp',
    serverInfoNames: ['camoufox-mcp', 'cmh-camoufox-mcp'],
    codes: ['camoufox', 'camoufox-mcp', 'cmh-camoufox-mcp'],
    market: true,
    readOnlyTools: new Set([
      // GET 주소 이동(goTo · http/https 만 · core/guard.ts:6-19) + 기본 알림창 닫기(사람이 고른 선택자 없음 · navigation.ts:27-36 · serve.ts goto)
      'browser_navigate',
      // cmh_ai_screen 을 읽고 이동(goto-screen.ts:2-4 · :216 · :267) · 도구는 선택자를 넘기지 않는다(navigation.ts:137-139)
      'browser_goto_screen',
      // 휠 · scrollIntoView 만(interaction.ts:197-246)
      'browser_scroll',
      // 마우스 옮기기 · 굴리기만 · 누르지 않음(page/idle.ts:30-32 · 결과 clicked:false)
      'browser_idle_like_human',
      // 기록된 요청 목록 · 본문 읽기(network.ts:24-27 · :42-46)
      'browser_network_requests',
      'browser_network_body',
      // 뺀 것: browser_back · browser_forward · browser_refresh(page.goBack/goForward/reload — POST 를 다시 보내는지 모릅니다) ·
      //        browser_page_dump(파일을 쓴다 · inspection.ts:113-140 writeDump) · browser_close_popups(사람이 준 선택자를 누른다 · popup.ts:213-214)
    ]),
  },
  {
    packageName: 'cmh-gateway-mcp',
    serverInfoNames: ['cmh-gateway-mcp'],
    codes: ['cmh-gateway-mcp'],
    market: true,
    readOnlyTools: new Set<string>(),
  },
  {
    packageName: 'cmh-naver-api-mcp',
    serverInfoNames: ['cmh-naver-api-mcp'],
    codes: ['cmh-naver-api-mcp'],
    market: false,
    // 서버 `POST /api/_action/cmh-ai/open-api/check/{kind}` · datalab(check.ts:76-110 · datalab.ts:83) — 판별 · 조회만 · 서버는 쿼터 칸 · 캐시만 쓴다
    readOnlyTools: new Set(['naver_check', 'naver_check_adult', 'naver_check_errata', 'naver_datalab_shopping_insight']),
  },
  {
    packageName: 'cmh-crawler-mcp',
    serverInfoNames: ['cmh-crawler-mcp'],
    codes: ['cmh-crawler-mcp'],
    market: false,
    // 식별자 계산만(library.ts:167-186) · 환경변수만 읽음(cmh-crawler `src/api.ts:154-176`).
    // 뺀 것: crawler_fetch_product · crawler_fetch_content · crawler_fetch_quotes · crawler_page_capture — 브라우저가 기본으로 유료 프록시를 쓴다
    // (cmh-crawler `src/engine/browser/browsers.ts:457-460` 환경변수 프록시 · `src/engine/proxy/index.ts` 머리 주석 «프록시 아이피 구입»)
    readOnlyTools: new Set(['crawler_check_identifier', 'crawler_proxy_usage']),
  },
  {
    packageName: 'cmh-openrouter-mcp',
    serverInfoNames: ['openrouter-mcp', 'cmh-openrouter-mcp'],
    codes: ['cmh-openrouter-mcp'],
    market: false,
    // GET https://openrouter.ai/api/v1/models 목록만(index.ts:93-104 · :247-262) — 요금이 붙는지는 OpenRouter 문서로 확인 안 함
    readOnlyTools: new Set(['openrouter_models']),
  },
  {
    packageName: 'cmh-shop-api-mcp',
    serverInfoNames: ['cmh-shop-api-mcp'],
    codes: ['cmh-shop-api-mcp'],
    market: false,
    // GET 두 번(importer.ts:58-61 · 설명 «읽기만 합니다» :47)
    readOnlyTools: new Set(['importer_profiles']),
  },
] satisfies KnownMcpServer[]);

/** 이름 맞추기 — 소문자 · `-` `_` `.` 떼기(`cmh_market_mcp` · `CMH-MARKET-MCP` 도 같은 이름) */
function compactServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]/g, '');
}

/**
 * 【AI 임시 결정】 마켓 MCP 서버 code — `mcp:<이 code>:<도구>` 는 읽기 꼴 도구(isNoApprovalToolName)가 아니면 마켓 쓰기(requiresApproval).
 * KNOWN_MCP_SERVERS 의 market 줄에서 만든다(목록은 한 곳) · 그대로 비교하는 표라 소문자 꼴만 담는다(code 는 서버 code 규칙상 소문자).
 * 근거: CmhAiAgent `src/Service/Agent/CmhAiMcpSeeder.php:359`('cmh-market-mcp') · `:534`('camoufox') · 패키지 이름 · serverInfo.name('camoufox-mcp').
 * 사용자가 다른 code 로 가져와도 연결 때 serverInfo.name · command · args · url 로 알아본다(identifyMcpServer · GuardRequest.server).
 */
export const MARKET_MCP_SERVER_CODES: ReadonlySet<string> = new Set(
  KNOWN_MCP_SERVERS.filter((s) => s.market).flatMap((s) => [s.packageName, ...s.serverInfoNames, ...s.codes].map((n) => n.toLowerCase())),
);

/** identifyMcpServer 입력 — 서버 테이블 행의 칸과 initialize 의 serverInfo.name */
export interface McpServerIdentityInput {
  readonly code: string;
  readonly name?: string | null;
  readonly command?: string | null;
  readonly args?: readonly string[];
  readonly url?: string | null;
  readonly serverInfoName?: string | null;
}

/** 경로 · 주소에서 이름 마디 후보를 뗀다(`/` `\` `?` `#` `:` 로 나누고 뒤의 `@판` 을 뗀다) */
function pathSegments(text: string): string[] {
  return text
    .split(/[\\/?#:\s]+/)
    .map((s) => s.replace(/@[^@]*$/, ''))
    .filter((s) => s.length > 0)
    .map(compactServerName);
}

/**
 * MCP 서버를 알아본다(검수 9 🟡2) — 사용자가 고른 code 말고도 serverInfo.name · command · args 경로 · url 경로의 이름 마디로 맞춘다.
 * ①code · name(사람이 정함) · serverInfo.name(서버가 밝힘)은 KNOWN_MCP_SERVERS 의 packageName · serverInfoNames · codes 와 이름 맞추기 비교
 * ②command · args · url 은 경로 마디 하나가 packageName · serverInfoNames 와 같을 때(짧은 code `camoufox` 는 경로에서 안 본다 — camoufox 브라우저 설치 경로와 헷갈림)
 * market = 맞은 줄 중 하나라도 market · knownServer = 맞은 줄이 꼭 하나일 때 그 packageName(둘 이상이면 null — 읽기 전용 표를 붙이지 않는다).
 */
export function identifyMcpServer(input: McpServerIdentityInput): GuardServerInfo {
  const names = [input.code, input.name ?? '', input.serverInfoName ?? ''].map(compactServerName).filter((n) => n.length > 0);
  const segments = [input.command ?? '', ...(input.args ?? []), input.url ?? ''].flatMap(pathSegments);
  const hits = KNOWN_MCP_SERVERS.filter((s) => {
    const byName = [s.packageName, ...s.serverInfoNames, ...s.codes].map(compactServerName);
    const byPath = [s.packageName, ...s.serverInfoNames].map(compactServerName);
    return names.some((n) => byName.includes(n)) || segments.some((g) => byPath.includes(g));
  });
  return { market: hits.some((s) => s.market), knownServer: hits.length === 1 ? (hits[0]?.packageName ?? null) : null };
}

/** knownServer(패키지 이름)의 읽기 전용 도구 표에 이 도구 이름이 있나(정확히 같은 이름만) */
export function isKnownReadOnlyTool(knownServer: string | null | undefined, toolName: string): boolean {
  if (knownServer === null || knownServer === undefined) return false;
  return KNOWN_MCP_SERVERS.find((s) => s.packageName === knownServer)?.readOnlyTools.has(toolName) === true;
}

/**
 * 승인 관문이 따로 필요 없는 도구 이름인가 — ①읽기 꼴 이름(isReadLikeToolName) ②서버별 읽기 전용 표(isKnownReadOnlyTool)
 * ③승인 요청 도구(market_approval_hold · market_approval_form_create — approval-entity.ts isApprovalRequestToolName · 검수 9 🟡1).
 * needsApproval 기본값(mcp-server-manager.ts defaultNeedsApproval) · 마켓 MCP 서버 쓰기 판별(isMarketWrite)이 같이 쓴다.
 */
export function isNoApprovalToolName(toolName: string, knownServer: string | null = null): boolean {
  return isReadLikeToolName(toolName) || isKnownReadOnlyTool(knownServer, toolName) || isApprovalRequestToolName(toolName);
}

/**
 * 범용 DAL 쓰기 동작 이름인가 — `[._-]` 를 떼고 소문자로 붙인 꼴이 `dal` 로 시작하고, 뒤 글이 읽기 동작(READ_ACTIONS)이 아니면 쓰기.
 * `dal_update` · `dalUpdate` · `DalDelete` · `dal-update` · `dal.update` · `dalupdate` · `DAL_UPDATE` 모두 쓰기 · `dal_search` · `dal.get` 은 읽기(검수 5 권고 6).
 * ⚠️ `dal` 로 시작하는 다른 이름(예 `dalle_generate`)도 쓰기로 본다 — 막는 쪽으로 틀린다.
 */
export function isDalWriteActionName(action: string): boolean {
  const compact = normalizeEntityName(action).replace(/[^a-z0-9]/g, '');
  if (!compact.startsWith('dal')) return false;
  return !READ_ACTIONS.has(compact.slice(3));
}

/** 도구 이름 전체 길이 상한 — 이보다 길면 deny(글롭 평가 비용 상한) */
export const TOOL_NAME_MAX = 512;

const SEVERITY: Readonly<Record<ToolDecision, number>> = { allow: 0, ask: 1, deny: 2 };

/** 도구 이름 한 마디(원래 글자 그대로 검사) */
const TOOL_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** 정책 글롭 한 마디 — 도구 마디 글자 + `*` */
const PATTERN_SEGMENT = /^[A-Za-z0-9_.*-]+$/;

/** 모양이 맞으면 소문자 마디 목록 · 틀리면 null(→ deny) */
function toolSegments(name: string): string[] | null {
  if (name.length === 0 || name.length > TOOL_NAME_MAX) return null;
  const raw = name.split(':');
  if (!raw.every((s) => TOOL_SEGMENT.test(s))) return null;
  return raw.map((s) => s.toLowerCase());
}

/** 동작 이름이 읽기 꼴인가(`dal_search` · `get` · `list` …) */
export function isReadActionName(action: string): boolean {
  const n = normalizeEntityName(action);
  return READ_ACTIONS.has(n.startsWith('dal_') ? n.slice(4) : n);
}

// ---------------------------------------------------------------- 글롭

type GlobToken =
  | { readonly kind: 'lit'; readonly text: string }
  | { readonly kind: 'seg'; readonly text: string } // 마디 안 `*` 가 있는 한 마디
  | { readonly kind: 'one' } // `*` — 아무 마디 하나
  | { readonly kind: 'many' }; // `**` — 0 마디 이상

/**
 * 글롭 → 토큰. widenStar=true(deny 규칙)면 마디 전체 `*` 를 «한 마디 이상»(`*` + `**`)으로 넓힌다.
 * 이어진 `**` 는 하나로 접는다(평가 비용이 `**` 개수로 늘지 않게).
 */
function compileGlob(pattern: string, widenStar: boolean): GlobToken[] {
  const out: GlobToken[] = [];
  const pushMany = (): void => {
    if (out[out.length - 1]?.kind !== 'many') out.push({ kind: 'many' });
  };
  for (const raw of pattern.toLowerCase().split(':')) {
    if (raw === '**') pushMany();
    else if (raw === '*') {
      out.push({ kind: 'one' });
      if (widenStar) pushMany();
    } else if (raw.includes('*')) out.push({ kind: 'seg', text: raw });
    else out.push({ kind: 'lit', text: raw });
  }
  return out;
}

/**
 * 마디 안 글롭(`*` 만 특수 글자). 정규식 없이 탐욕 + 되돌림 한 칸 —
 * 마지막 `*` 자리 하나만 기억하고 실패하면 거기서 한 글자 더 먹는다. 최악 O(패턴 × 마디) · 지수 시간 없음.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p;
      starT = t;
      p += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function tokenMatchesSegment(token: GlobToken, segment: string): boolean {
  switch (token.kind) {
    case 'lit':
      return token.text === segment;
    case 'seg':
      return wildcardMatch(token.text, segment);
    case 'one':
      return true;
    case 'many':
      return true;
  }
}

/** (토큰 자리, 마디 자리) 메모 — 상태 수 (P+1)(T+1) 을 넘지 않는다 */
function globMatches(tokens: readonly GlobToken[], segments: readonly string[]): boolean {
  const width = segments.length + 1;
  const memo = new Uint8Array((tokens.length + 1) * width); // 0 모름 · 1 맞음 · 2 안 맞음
  const go = (pi: number, ti: number): boolean => {
    const slot = pi * width + ti;
    const known = memo[slot];
    if (known === 1) return true;
    if (known === 2) return false;
    let ok: boolean;
    const token = tokens[pi];
    if (token === undefined) ok = ti === segments.length;
    else if (token.kind === 'many') ok = go(pi + 1, ti) || (ti < segments.length && go(pi, ti + 1));
    else {
      const segment = segments[ti];
      ok = segment !== undefined && tokenMatchesSegment(token, segment) && go(pi + 1, ti + 1);
    }
    memo[slot] = ok ? 1 : 2;
    return ok;
  };
  return go(0, 0);
}

/** 글롭이 도구 이름에 맞나(allow 꼴 — `*` 는 한 마디). 대소문자는 가리지 않는다(대문자로 deny 규칙을 비껴가지 못하게) */
export function matchToolPattern(pattern: string, tool: string): boolean {
  const segments = toolSegments(tool);
  if (segments === null) return false;
  return globMatches(compileGlob(pattern, false), segments);
}

// ---------------------------------------------------------------- 내장 규칙

/** 이름 안 어느 마디에 승인 엔티티가 있으면 쓰기인가 — 있으면 그 마디. 읽기는 `…:cmh_ai_approval:<읽기 동작>` 으로 끝날 때뿐 */
function approvalEntityWriteSegment(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i] ?? '';
    if (!mentionsWriteProtectedEntity(s)) continue;
    // 마디 일부(cmh_ai_approval_update 등)는 동작을 가려낼 수 없어 쓰기로 본다
    if (!isWriteProtectedEntity(s)) return s;
    const action = segments[i + 1];
    // 동작이 없거나(entity:cmh_ai_approval) · 마지막 마디가 아니거나 · 읽기 꼴이 아니면 쓰기
    if (action === undefined || i + 2 !== segments.length || !isReadActionName(action)) return s;
  }
  return null;
}

/** target.entity 검사. 엔티티 이름이 깨졌으면(공백 안 · 비ASCII 등) 'malformed' */
function approvalTargetWrite(target: GuardTarget | undefined, segments: readonly string[]): 'malformed' | boolean {
  const entity = target?.entity;
  if (entity === undefined) return false;
  const n = normalizeEntityName(entity);
  if (!/^[a-z0-9_.]+$/.test(n)) return 'malformed';
  if (!mentionsWriteProtectedEntity(n)) return false;
  const action = segments[segments.length - 1];
  return action === undefined || !isReadActionName(action);
}

/**
 * 3차 검수 차단 4: 마지막 마디가 `dal_` 로 시작하는 범용 DAL 쓰기 도구인데 target.entity 가 없으면 deny.
 * 어느 엔티티를 쓰는지 모르면 승인 엔티티 보호를 할 수 없다(dal_update({}) · entity 를 다른 칸 이름으로 넘기기 등).
 */
function isUntargetedDalWrite(target: GuardTarget | undefined, segments: readonly string[], rawTool: string): boolean {
  if (target?.entity !== undefined) return false;
  // 소문자로 바꾸기 전 이름의 마지막 마디로 본다 — segments 는 이미 소문자라 camelCase 경계가 뭉개진다(RA 검수 4 남은 것)
  const action = rawTool.split(':').pop() ?? segments[segments.length - 1];
  return action !== undefined && isDalWriteActionName(action);
}

/** 마지막 마디(원래 글자)가 읽기 꼴 도구인가 — 정확한 읽기 동작(dal_search 등) 또는 읽기 꼴 낱말 이름(product_list 등) */
function isReadLikeLastSegment(rawTool: string): boolean {
  const last = rawTool.split(':').pop() ?? '';
  return isReadActionName(last) || isReadLikeToolName(last);
}

/**
 * 마켓 쓰기인가:
 * ①`market:<마켓>:<동작…>` — 동작 마디가 전부 읽기 꼴일 때만 읽기 · 나머지는 모두 쓰기
 * ②`mcp:<마켓 서버>:<도구>` — 서버 code 가 marketServers 에 있거나 GuardRequest.server.market(검수 9 🟡2)이면,
 *   도구 이름이 isNoApprovalToolName(읽기 꼴 · 서버별 읽기 전용 표 · 승인 요청 도구)이 아닐 때 쓰기(검수 5 E4 · ToolRouter 는 `mcp:` 이름만 만든다)
 *   서버별 읽기 전용 표는 server.knownServer 로 · 없으면 code 로 알아본 패키지로 본다.
 */
function isMarketWrite(segments: readonly string[], rawTool: string, marketServers: ReadonlySet<string>, server: GuardServerInfo | undefined): boolean {
  if (segments[0] === 'market') {
    const actions = segments.slice(2);
    return actions.length === 0 || !actions.every(isReadActionName);
  }
  if (segments[0] !== 'mcp' || segments.length < 3) return false;
  const code = segments[1] ?? '';
  // 기본 목록이면 code 를 이름 맞추기(`cmh_market_mcp` · `CMH-Market-MCP`)로도 본다 · 세 번째 인자로 바꿔 넣은 목록은 그대로 비교만
  const byCode = identifyMcpServer({ code });
  const codeIsMarket = marketServers.has(code) || (marketServers === MARKET_MCP_SERVER_CODES && byCode.market);
  if (!codeIsMarket && server?.market !== true) return false;
  const knownServer = server !== undefined ? server.knownServer : byCode.knownServer;
  return !isNoApprovalToolName(rawTool.split(':').slice(2).join(':'), knownServer);
}

/**
 * 도구 호출 한 번을 평가한다. 차례:
 * ①모양이 깨진 이름 · 깨진 target.entity → deny ②승인 엔티티 쓰기(이름 어느 마디든 · target.entity) → deny(내장)
 * ②' 승인 결정 도구 이름(market_approval_decide 등 · listing 포함) → deny(내장 · APPROVAL_DECISION_TOOL_PATTERN)
 * ②'' 읽기 꼴이 아닌 도구 인자에 승인 엔티티 연관 칸(target.association) → deny(내장 · APPROVAL_ASSOCIATION_PATTERN)
 * ②''' target 없는 범용 DAL 쓰기(`…:dal_update` 등 · listing 평가 제외) → deny(내장)
 * ③정책 글롭 전부 중 deny > ask > allow ④맞는 규칙 없음 → guard 는 ask · full 은 allow ⑤known=false 면 최소 ask
 * ⑥deny 가 아니면 마켓 쓰기(`market:*` · `mcp:<마켓 서버>:*` · request.server.market) · needsApproval 은 requiresApproval
 * marketServers 는 마켓 MCP 서버 code 목록(기본 MARKET_MCP_SERVER_CODES · 소문자로 비교한다).
 *
 * deny 규칙의 마디 전체 `*` 는 «한 마디 이상»으로 넓혀 읽는다(allow · ask 는 그대로 한 마디):
 * `mcp:evil:*` deny 를 `mcp:evil:a:b` 처럼 마디를 하나 더 붙여 비껴가지 못하게(검수 1-3). 막는 쪽만 넓히면 잘못 넓어도 덜 열린다.
 */
export function evaluateGuard(policy: GuardPolicy, request: GuardRequest, marketServers: ReadonlySet<string> = MARKET_MCP_SERVER_CODES): GuardResult {
  const segments = toolSegments(request.tool);
  if (segments === null) return { decision: 'deny', requiresApproval: false, matchedPattern: null };
  const targetWrite = approvalTargetWrite(request.target, segments);
  if (targetWrite === 'malformed') return { decision: 'deny', requiresApproval: false, matchedPattern: null };
  if (targetWrite === true) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: protectedPattern(request.target?.entity ?? '') };
  }
  const nameWrite = approvalEntityWriteSegment(segments);
  if (nameWrite !== null) return { decision: 'deny', requiresApproval: false, matchedPattern: protectedPattern(nameWrite) };
  if (isApprovalDecisionToolName(request.tool)) return { decision: 'deny', requiresApproval: false, matchedPattern: APPROVAL_DECISION_TOOL_PATTERN };
  if (request.target?.association !== undefined && !isReadLikeLastSegment(request.tool)) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: APPROVAL_ASSOCIATION_PATTERN };
  }
  if (request.listing !== true && isUntargetedDalWrite(request.target, segments, request.tool)) {
    return { decision: 'deny', requiresApproval: false, matchedPattern: DAL_WRITE_WITHOUT_TARGET_PATTERN };
  }

  let decision: ToolDecision | null = null;
  let matchedPattern: string | null = null;
  // 같은 무게면 먼저 적힌 규칙(객체 키 차례)이 matchedPattern 이 된다
  for (const [pattern, value] of Object.entries(policy.tools)) {
    if (!globMatches(compileGlob(pattern, value === 'deny'), segments)) continue;
    if (decision === null || SEVERITY[value] > SEVERITY[decision]) {
      decision = value;
      matchedPattern = pattern;
    }
  }
  if (decision === null) decision = policy.defaultMode === 'guard' ? 'ask' : 'allow';
  if (!request.known && decision === 'allow') decision = 'ask';

  const lowerMarketServers = marketServers === MARKET_MCP_SERVER_CODES ? marketServers : new Set([...marketServers].map((c) => c.toLowerCase()));
  const requiresApproval = decision !== 'deny' && (isMarketWrite(segments, request.tool, lowerMarketServers, request.server) || request.needsApproval === true);
  return { decision, requiresApproval, matchedPattern };
}

/**
 * MCP 도구의 Guard 이름 `mcp:<서버 code>:<도구 이름>`. 어느 쪽이든 `:` 가 들어 있거나 마디 글자 규칙을 어기면 예외 —
 * 도구 이름의 `:` 가 마디를 늘려 `mcp:<서버>:*` 규칙을 비껴가지 못하게(MCP 규격 도구 이름은 `[A-Za-z0-9_.-]`).
 */
export function mcpToolName(serverCode: string, toolName: string): string {
  for (const [label, value] of [['server code', serverCode], ['tool name', toolName]] as const) {
    if (value.includes(':')) throw new Error(`guard: MCP ${label} must not contain ":"`);
    if (!TOOL_SEGMENT.test(value)) throw new Error(`guard: MCP ${label} must match ${TOOL_SEGMENT.source}`);
  }
  return `mcp:${serverCode}:${toolName}`;
}

/** 사이트 자격증명 접근. 사이트가 정책에 없으면 ask(합의 ⑨ — 앱 잠금 미정의라 쓸 때마다 사람 확인) */
export function credentialAccessFor(policy: GuardPolicy, site: string): CredentialAccess {
  const key = site.trim().toLowerCase();
  for (const [name, access] of Object.entries(policy.credentials)) {
    if (name.trim().toLowerCase() === key) return access;
  }
  return 'ask';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertToolPattern(pattern: string): void {
  if (pattern.length === 0) throw new Error('guard policy: empty tool pattern');
  if (pattern.length > TOOL_NAME_MAX) throw new Error(`guard policy: pattern longer than ${TOOL_NAME_MAX}`);
  for (const segment of pattern.split(':')) {
    if (segment.length === 0) throw new Error(`guard policy: empty segment in pattern "${pattern}"`);
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`guard policy: "**" must be a whole segment in pattern "${pattern}"`);
    }
    if (/\s/.test(segment)) throw new Error(`guard policy: whitespace in pattern "${pattern}"`);
    // 도구 이름에 올 수 없는 글자(비ASCII 등)는 어떤 도구에도 맞지 않는다 — 조용히 죽은 규칙이 되지 않게 거부
    if (!PATTERN_SEGMENT.test(segment)) throw new Error(`guard policy: invalid character in pattern "${pattern}"`);
  }
}

/** 정책 JSON(설정 테이블 값) 검증. 모르는 키 · 모르는 값 · 깨진 글롭 · 대소문자만 다른 사이트 중복은 예외 — 고칠 사람은 프로그래머/설정 화면이다 */
export function parseGuardPolicy(raw: unknown): GuardPolicy {
  if (!isPlainObject(raw)) throw new Error('guard policy: must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'defaultMode' && key !== 'tools' && key !== 'credentials') {
      throw new Error(`guard policy: unknown key "${key}"`);
    }
  }
  const mode = raw['defaultMode'];
  if (!(GUARD_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`guard policy: unknown defaultMode ${JSON.stringify(mode)}`);
  }

  // 프로토타입 없는 객체 — 키 "__proto__" 규칙도 잃지 않는다
  const tools: Record<string, ToolDecision> = Object.create(null) as Record<string, ToolDecision>;
  const rawTools = raw['tools'] ?? {};
  if (!isPlainObject(rawTools)) throw new Error('guard policy: tools must be an object');
  for (const [pattern, value] of Object.entries(rawTools)) {
    assertToolPattern(pattern);
    if (!(TOOL_DECISIONS as readonly unknown[]).includes(value)) {
      throw new Error(`guard policy: unknown decision ${JSON.stringify(value)} for "${pattern}"`);
    }
    tools[pattern] = value as ToolDecision;
  }

  const credentials: Record<string, CredentialAccess> = Object.create(null) as Record<string, CredentialAccess>;
  const rawCredentials = raw['credentials'] ?? {};
  if (!isPlainObject(rawCredentials)) throw new Error('guard policy: credentials must be an object');
  const seenSites = new Set<string>();
  for (const [site, value] of Object.entries(rawCredentials)) {
    const key = site.trim().toLowerCase();
    if (key.length === 0) throw new Error('guard policy: empty credential site');
    // credentialAccessFor 는 대소문자를 가리지 않는다 — 'Naver' · 'naver' 가 둘 다 있으면 어느 값이 이길지 모른다
    if (seenSites.has(key)) throw new Error(`guard policy: duplicate credential site "${site}" (case-insensitive)`);
    seenSites.add(key);
    if (!(CREDENTIAL_ACCESS as readonly unknown[]).includes(value)) {
      throw new Error(`guard policy: unknown credential access ${JSON.stringify(value)} for "${site}"`);
    }
    credentials[site] = value as CredentialAccess;
  }

  return { defaultMode: mode as GuardMode, tools, credentials };
}
