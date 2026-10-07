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
