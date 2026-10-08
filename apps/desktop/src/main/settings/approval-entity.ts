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
 * hold(market_approval_hold 는 `cmh_ai_approval` 행을 만든다) · create(market_approval_form_create)도 쓰기라서 넣었다(합의안 5: 승인 엔티티 쓰기는 main UI IPC 만).
 * 늘릴 때는 이 표만 고친다.
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
]);

/** 승인 도구 이름 중 읽기 꼴 낱말 — 결정 낱말이 없고 이 낱말이 하나라도 있어야 읽기로 본다(market_approval_pending) */
export const APPROVAL_READ_WORDS: ReadonlySet<string> = new Set(['pending', 'list', 'get', 'search', 'read', 'find', 'count', 'view', 'show', 'status', 'detail', 'brief']);

/** 승인 결정 도구 deny 의 matchedPattern */
export const APPROVAL_DECISION_TOOL_PATTERN = 'builtin:approval-decision-tool';

/**
 * 도구 이름(Guard 이름 `mcp:<서버>:<도구>` 그대로 줘도 된다 — 출처 마디 · MCP 서버 code 는 빼고 본다)이 승인 결정 · 쓰기 도구인가.
 * ①붙인 꼴에 `approval` 이 없으면 false ②결정 낱말(APPROVAL_DECISION_WORDS)이 있으면 true ③읽기 낱말(APPROVAL_READ_WORDS)이 없으면 true(모르면 막는 쪽)
 * 예: market_approval_decide · market_approval_hold · marketApprovalDecide · approval → true / market_approval_pending → false.
 */
export function isApprovalDecisionToolName(toolName: string): boolean {
  const parts = toolName.split(':');
  // 출처 마디(`mcp` · `market` · `browser` …)와 MCP 서버 code 는 빼고 도구 · 동작 마디만 본다(서버 이름 낱말에 걸려 엉뚱한 도구가 막히지 않게)
  const skip = parts[0] === 'mcp' && parts.length >= 3 ? 2 : parts.length > 1 ? 1 : 0;
  const words = toolNameWords(parts.slice(skip).join(':'));
  if (!words.join('').includes(APPROVAL_TOOL_NOUN)) return false;
  if (words.some((w) => APPROVAL_DECISION_WORDS.has(w))) return true;
  return !words.some((w) => APPROVAL_READ_WORDS.has(w));
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
