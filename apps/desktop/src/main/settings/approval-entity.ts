// 승인 엔티티(쓰기 보호 엔티티) 목록과 이름 맞추기 — 한 곳에만 둔다(3차 검수 권고).
// electron 을 import 하지 않는 순수 모듈. Guard(`guard-policy.ts`) · 플러그인 매니페스트(`plugin-manifest.ts`) · 플러그인 권한(`plugin-permissions.ts`)이 import 한다.
// 합의안 5(PLAN «opus 검수 반영»): 승인 상태 엔티티 쓰기는 main 의 UI IPC(사람 클릭)만 — 에이전트 · 플러그인 · 외부 도구는 정책과 상관없이 막는다.
// 늘릴 때는 WRITE_PROTECTED_ENTITIES 만 고친다(이름은 서버 Shopware 엔티티 이름 snake_case 그대로).

/** 쓰기를 막는 엔티티. 지금은 승인 엔티티 하나 */
export const WRITE_PROTECTED_ENTITIES: readonly string[] = Object.freeze(['cmh_ai_approval']);

/**
 * 엔티티 · 동작 이름 맞추기: trim · camelCase 경계에 `_` · 소문자 · `-` → `_`.
 * camelCase 경계(`cmhAiApproval` → `cmh_ai_approval`)를 넣은 까닭: 소문자만 하면 `cmhaiapproval` 이 되어 보호 목록과 어긋난다(3차 검수 재현).
 */
export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/-/g, '_');
}

/** 구분 글자(`_` · `.`)까지 뗀 꼴 — `cmh.ai.approval` · `cmhaiapproval` 처럼 구분만 다른 이름도 같은 것으로 본다 */
function compactEntityName(name: string): string {
  return normalizeEntityName(name).replace(/[_.]/g, '');
}

const PROTECTED_COMPACT: readonly string[] = WRITE_PROTECTED_ENTITIES.map(compactEntityName);

/** 이름이 쓰기 보호 엔티티 그 자체인가(맞춘 뒤 비교) */
export function isWriteProtectedEntity(name: string): boolean {
  const n = compactEntityName(name);
  return n.length > 0 && PROTECTED_COMPACT.includes(n);
}

/**
 * 이름 안 어딘가에 쓰기 보호 엔티티 이름이 들어 있는가(`cmh_ai_approval_update` 처럼 마디 일부).
 * 동작을 가려낼 수 없는 이름은 쓰기로 보려고 Guard 가 쓴다(모르면 막는 쪽).
 */
export function mentionsWriteProtectedEntity(name: string): boolean {
  const n = compactEntityName(name);
  return PROTECTED_COMPACT.some((p) => n.includes(p));
}

/**
 * 도구 이름 → 소문자 낱말 목록. camelCase 경계(`marketApprovalDecide` · `HTTPPost`)와 `[._-]` · 그 밖 영숫자 아닌 글자에서 나눈다.
 * 비ASCII 글자도 구분 글자로 본다(Guard 는 비ASCII 이름을 따로 deny 한다). 정규식은 겹친 반복이 없어 길이에 선형이다.
 */
export function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

// ---------------------------------------------------------------- 승인 결정 도구(RA·Guard 검수 5 차단 1 · E1)

/**
 * 승인 엔티티를 가리키는 이름 조각 — 낱말을 붙인 꼴(`cmhaiapprovaldecide`)에 이 글이 들어 있으면 승인 도구로 본다(`approvals` 도 걸린다).
 * 실제 도구: cmh-mcp `packages/cmh-market-mcp/src/domains/approval/approval.tools.ts:55`(market_approval_hold) ·
 * `:99`(market_approval_pending) · `:115`(market_approval_decide) · `:142`(market_approval_form_create).
 */
export const APPROVAL_TOOL_NOUN = 'approval';

/**
 * 승인 도구 이름에 이 낱말이 하나라도 있으면 «승인 결정 · 쓰기 도구» — 정책과 상관없이 deny.
 * 검수 9 🟡4 뒤로는 isApprovalDecisionToolName 이 화이트리스트(APPROVAL_READ_WORDS · APPROVAL_NOUN_WORDS)로 판정한다 —
 * 이 표는 «이 낱말이 있으면 화이트리스트를 보기 전에 바로 deny» 하는 빠른 길로만 남겼다(이름 · 꼴은 그대로 · 바깥에서 읽는다).
 * hold · create 가 들어 있어도 승인 요청 도구 두 개(APPROVAL_REQUEST_TOOL_NAMES)는 그 앞에서 빠진다.
 */
export const APPROVAL_DECISION_WORDS: ReadonlySet<string> = new Set([
  'decide',
  'decision',
  'approve',
  'approved',
  'reject',
  'rejected',
  'resolve',
  'set',
  'update',
  'upsert',
  'patch',
  'put',
  'post',
  'hold',
  'create',
  'insert',
  'save',
  'write',
  'delete',
  'remove',
  'submit',
  'confirm',
  'grant',
  'deny',
  'accept',
  'decline',
  'answer',
  'respond',
  'reply',
  'choose',
  'pick',
  'mark',
  'cancel',
  'revoke',
  'sync',
  'edit',
  'change',
  'modify',
  'done',
  'complete',
  'finish',
  'skip',
  'toggle',
  'override',
]);

/** 승인 도구 이름 중 읽기 꼴 낱말 — 승인 도구는 이 낱말이 하나는 있어야 읽기로 본다(market_approval_pending) */
export const APPROVAL_READ_WORDS: ReadonlySet<string> = new Set(['pending', 'list', 'get', 'search', 'read', 'find', 'count', 'view', 'show', 'status', 'detail', 'brief']);

/**
 * 【AI 임시 결정】 승인 도구 이름에 읽기 낱말과 같이 와도 되는 명사(검수 9 🟡4 화이트리스트).
 * 근거: 실제 도구 이름 `market_approval_pending`(approval.tools.ts:99)의 `market` · 엔티티 이름 `cmh_ai_approval` 의 `cmh` · `ai` ·
 * 서버 이름 꼴 `…-mcp` 의 `mcp`. 이 밖의 낱말(toggle · flip · override · and · ok · 비영어 …)이 하나라도 있으면 읽기로 보지 않는다. 늘릴 때는 이 표만.
 */
export const APPROVAL_NOUN_WORDS: ReadonlySet<string> = new Set(['market', 'cmh', 'ai', 'mcp']);

/**
 * 【AI 임시 결정】 승인 «요청» 도구 — 승인 행(decision='pending')을 만들어 사람에게 묻기만 한다. deny 하지 않고 승인 관문도 따로 세우지 않는다
 * (사람에게 묻는 것을 사람에게 또 묻는 꼴이라 뜻이 없다 · 검수 9 🟡1 · 메인 세션 결정 1). camoufox `browser_api` POST · `browser_api_patch` 는
 * 이 도구가 돌려준 approvalId 를 사람이 승인해야 보낸다(cmh-camoufox-mcp `src/net/api.ts:117` checkApproval · 검수 9 원문).
 * 결정을 실어 보낼 수 없는 근거(cmh-mcp · CmhAiAgent 저장소 · 2026-10-08 읽음):
 *  - 도구 인자 꼴은 zod 객체(`approval.tools.ts:62-93` · `approval-form.service.ts:34-49`)라 decision · chosen · approvalId 같은 모르는 키는 버려진다.
 *    `payload`(record)는 `cmh_ai_task.payload` 로만 간다(`CmhAiApprovalService.php:257`).
 *  - 서버 hold 는 두 갈래 모두 `decision = 'pending'` 으로만 넣는다(`CmhAiApprovalService.php:137` · `:273`).
 *  - hold 안에서 결정까지 적는 길은 MCP elicitInput 확인 창 하나(`approval.service.ts:305-330`)이고, 클라이언트가 elicitation 능력을
 *    알렸을 때만 돈다(`approval.service.ts:146-147`). 이 앱의 MCP Client 는 능력을 알리지 않는다(mcp-server-manager.ts `new Client` 주석).
 */
export const APPROVAL_REQUEST_TOOL_NAMES: readonly string[] = Object.freeze(['market_approval_hold', 'market_approval_form_create']);

/** 승인 결정 도구 deny 의 matchedPattern */
export const APPROVAL_DECISION_TOOL_PATTERN = 'builtin:approval-decision-tool';

/** Guard 이름(`mcp:<서버>:<도구>` · `market:<마켓>:<동작>` · 도구 이름만)에서 도구 · 동작 마디만 뗀다 — 출처 마디 · MCP 서버 code 는 뺀다 */
function toolPartOf(toolName: string): string {
  const parts = toolName.split(':');
  // 출처 마디(`mcp` · `market` · `browser` …)와 MCP 서버 code 는 빼고 도구 · 동작 마디만 본다(서버 이름 낱말에 걸려 엉뚱한 도구가 막히지 않게)
  const skip = parts[0] === 'mcp' && parts.length >= 3 ? 2 : parts.length > 1 ? 1 : 0;
  return parts.slice(skip).join(':');
}

/**
 * 도구 이름이 승인 요청 도구(APPROVAL_REQUEST_TOOL_NAMES)인가 — 대소문자만 가리지 않고 정확히 같아야 한다(낱말 맞추기 아님).
 * 게이트웨이 꼴 `<서버키>__market_approval_hold`(cmh-gateway-mcp `src/filter.ts:57-64`)도 받는다 — 단 앞붙이에 승인 낱말 · 결정 낱말이 없어야 한다.
 * Guard 이름 `mcp:<서버>:<도구>` 그대로 줘도 된다.
 */
export function isApprovalRequestToolName(toolName: string): boolean {
  const part = toolPartOf(toolName);
  const cut = part.lastIndexOf('__');
  const base = (cut >= 0 ? part.slice(cut + 2) : part).toLowerCase();
  if (!APPROVAL_REQUEST_TOOL_NAMES.includes(base)) return false;
  if (cut < 0) return true;
  const prefixWords = toolNameWords(part.slice(0, cut));
  if (prefixWords.join('').includes(APPROVAL_TOOL_NOUN)) return false;
  return !prefixWords.some((w) => APPROVAL_DECISION_WORDS.has(w));
}

/** 승인 도구 이름에서 `approval` 이 든 낱말로 받는 꼴 — 이 밖(`approvalz` · `approvalflip` …)은 화이트리스트를 지나지 못한다 */
const APPROVAL_WORD_FORMS: ReadonlySet<string> = new Set(['approval', 'approvals']);

/** 한 마디의 낱말이 화이트리스트(승인 낱말 꼴 · 명사 · 읽기 낱말)만으로 되어 있고 읽기 낱말이 하나는 있나 */
function isReadOnlyApprovalSegment(words: readonly string[]): boolean {
  let hasRead = false;
  for (const w of words) {
    if (APPROVAL_WORD_FORMS.has(w) || APPROVAL_NOUN_WORDS.has(w)) continue;
    if (!APPROVAL_READ_WORDS.has(w)) return false;
    hasRead = true;
  }
  return hasRead;
}

/**
 * 도구 이름(Guard 이름 `mcp:<서버>:<도구>` 그대로 줘도 된다 — 출처 마디 · MCP 서버 code 는 빼고 본다)이 승인 결정 · 쓰기 도구인가.
 * ①붙인 꼴에 `approval` 이 없으면 false ②승인 요청 도구(isApprovalRequestToolName — hold · form_create)면 false
 * ③결정 낱말(APPROVAL_DECISION_WORDS)이 어느 마디에든 있으면 true
 * ④화이트리스트(검수 9 🟡4) — `approval` 이 든 마디마다: 낱말이 모두 `approval(s)` · 명사(APPROVAL_NOUN_WORDS) · 읽기 낱말(APPROVAL_READ_WORDS)이고
 *   읽기 낱말이 하나는 있어야 한다. 하나라도 어기면 true(모르면 막는 쪽 · `approval_status_toggle` · `approval_view_and_ok` · `approval` 만 → true).
 *   마디가 쓰기 보호 엔티티 이름 그 자체이고 뒤에 마디가 있으면(`entity:cmh_ai_approval:dal_search` 의 가운데) 여기서 보지 않는다 — Guard 의
 *   approvalEntityWriteSegment(guard-policy.ts)가 «다음 마디가 마지막 · 읽기 동작» 일 때만 읽기로 보고 먼저 막는다.
 *   `approval` 이 마디 하나 안에 없고 마디를 건너 나뉘었으면(`appro:val_list`) true.
 * 예: market_approval_decide · marketApprovalDecide · approval → true / market_approval_pending · approvals_list · market_approval_hold → false.
 */
export function isApprovalDecisionToolName(toolName: string): boolean {
  const part = toolPartOf(toolName);
  const words = toolNameWords(part);
  if (!words.join('').includes(APPROVAL_TOOL_NOUN)) return false;
  if (isApprovalRequestToolName(toolName)) return false;
  if (words.some((w) => APPROVAL_DECISION_WORDS.has(w))) return true;
  let checked = false;
  const segments = part.split(':');
  for (const [i, segment] of segments.entries()) {
    if (isWriteProtectedEntity(segment)) {
      // 엔티티 이름 뒤에 동작 마디가 없으면(`cmhaiapproval` 만) 무엇을 하는지 몰라 막는다
      if (i === segments.length - 1) return true;
      checked = true;
      continue;
    }
    const segmentWords = toolNameWords(segment);
    if (!segmentWords.join('').includes(APPROVAL_TOOL_NOUN)) continue;
    checked = true;
    if (!isReadOnlyApprovalSegment(segmentWords)) return true;
  }
  return !checked;
}

// ---------------------------------------------------------------- 승인 엔티티로 가는 연관 칸(검수 5 차단 1 · E2)

/**
 * 다른 엔티티에서 `cmh_ai_approval` 로 가는 연관(association) 칸 이름. DAL 쓰기 인자 안(중첩 data 포함)에 이 키가 있으면
 * 연관 쓰기로 승인 행을 만들거나 바꿀 수 있다 → 읽기 도구가 아니면 정책과 상관없이 deny.
 * 근거(CmhAiAgent 저장소 · 2026-10-07 읽음):
 *  - `approvals` — `src/Core/Content/Run/CmhAiRunDefinition.php:85`(cmh_ai_run.approvals) · `src/Core/Content/Task/CmhAiTaskDefinition.php:93`(cmh_ai_task.approvals)
 *  - `cmhAiApprovals` — `src/Core/Extension/MediaExtension.php:32`(media.cmhAiApprovals)
 *  - `cmhAiDecidedApprovals` — `src/Core/Extension/UserExtension.php:40`(user.cmhAiDecidedApprovals)
 * 서버에 연관이 늘면 이 표만 고친다.
 */
export const APPROVAL_ASSOCIATION_KEYS: readonly string[] = Object.freeze(['approvals', 'cmhAiApprovals', 'cmhAiDecidedApprovals']);

/** 연관 칸 deny 의 matchedPattern */
export const APPROVAL_ASSOCIATION_PATTERN = 'builtin:approval-association';

const ASSOCIATION_COMPACT: ReadonlySet<string> = new Set(APPROVAL_ASSOCIATION_KEYS.map(compactEntityName));

/** 객체 키가 승인 엔티티로 가는 연관 칸인가(`approvals` · `cmh_ai_approvals` · `CmhAiDecidedApprovals` 처럼 구분 · 대소문자만 다른 꼴 포함) */
export function isApprovalAssociationKey(key: string): boolean {
  const n = compactEntityName(key);
  return n.length > 0 && ASSOCIATION_COMPACT.has(n);
}
