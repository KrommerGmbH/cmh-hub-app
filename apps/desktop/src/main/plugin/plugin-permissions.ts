// R2-a — 플러그인 권한 검사. main 쪽 RPC 핸들러가 플러그인의 요청 하나하나마다 부른다(플러그인 쪽 검사는 믿지 않는다).
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 원칙 8(촘촘한 제어): 매니페스트 `permissions` 에 선언이 없으면 거부 · 승인 엔티티 쓰기는 선언이 있어도(매니페스트 검증을 우회해도) 늘 거부.

import { isWriteProtectedEntity, normalizeEntityName } from '../settings/approval-entity.js';
import type { PluginPermission } from './plugin-manifest.js';

export type EntityOperation = 'read' | 'write';

export interface PermissionDecision {
  readonly allowed: boolean;
  /** 거부 까닭(영문 · 플러그인에게 그대로 돌려준다) */
  readonly reason: string;
}

const ALLOW: PermissionDecision = Object.freeze({ allowed: true, reason: 'declared' });

export function checkEntityAccess(permissions: readonly PluginPermission[], entity: string, operation: EntityOperation): PermissionDecision {
  if (isPluginReservedEntity(entity)) return { allowed: false, reason: `${entity} is reserved for the app and cannot be accessed by plugins` };
  if (operation === 'write' && isWriteProtectedEntity(entity)) {
    return { allowed: false, reason: `writes to ${entity} are only allowed from the app UI` };
  }
  const granted = permissions.some((p) => p.kind === 'entity' && p.entity === entity && (operation === 'read' || p.access === 'crud'));
  return granted ? ALLOW : { allowed: false, reason: `permission "entity:${entity}:${operation === 'read' ? 'read' : 'crud'}" not declared` };
}

/**
 * 플러그인이 정의 · 확장 · 읽기 · 쓰기 · 연관으로 거쳐 가기를 모두 못 하는 엔티티(검수 10 🟡4) — 매니페스트 검증(plugin-manifest.ts)과
 * host:data.* 검사(checkEntityAccess · plugin-host-api.ts 연관 hop)가 이 한 목록을 쓴다.
 *  - `system_config` — 앱 설정 테이블(`settings/data-settings-backend.ts` SYSTEM_CONFIG_ENTITY). 플러그인 설정은 host:settings.get 으로만.
 * app-services.ts PLUGIN_BLOCKED_ENTITIES(자료 어댑터 · 루트 이름)와 같은 이름을 플러그인 층에서 한 번 더 막는다(이중 방어).
 * 【AI 임시 결정】 늘릴 때는 이 목록만 고친다.
 */
export const PLUGIN_RESERVED_ENTITIES: readonly string[] = Object.freeze(['system_config']);

const RESERVED_COMPACT: ReadonlySet<string> = new Set(PLUGIN_RESERVED_ENTITIES.map((e) => normalizeEntityName(e).replace(/[_.]/g, '')));

/** 플러그인이 어떤 길로도 못 닿는 엔티티인가(구분 글자 · 대소문자만 다른 이름도 같은 것으로) */
export function isPluginReservedEntity(entity: string): boolean {
  const n = normalizeEntityName(entity).replace(/[_.]/g, '');
  return n.length > 0 && RESERVED_COMPACT.has(n);
}

/** 연관으로 거쳐 갈 수 없는 대상 — 예약 엔티티 + 쓰기 보호(승인) 엔티티. 승인 엔티티는 루트 read 만 선언으로 허락하고 연관 hop 은 늘 거부 */
export function isBlockedAssociationTarget(entity: string): boolean {
  return isPluginReservedEntity(entity) || isWriteProtectedEntity(entity);
}

/**
 * 지우면 승인 행(`cmh_ai_approval`)이 같이 지워지거나(CASCADE) 칸이 비는(SET NULL) 엔티티 — 플러그인 `host:data.delete` 는 선언이 있어도 늘 거부(검수 8 🟡3).
 * 근거(CmhAiAgent 저장소 `src/Migration/Migration1790100000CmhAiAgentSchema.php` · 2026-10-08 읽음):
 *  - `:352` `fk.cmh_ai_approval.task_id` → `cmh_ai_task` ON DELETE CASCADE(승인 행이 지워진다)
 *  - `:351` `fk.cmh_ai_approval.run_id` → `cmh_ai_run` ON DELETE SET NULL
 *  - `:350` `fk.cmh_ai_approval.evidence_media_id` → `media` ON DELETE SET NULL
 *  - `:349` `fk.cmh_ai_approval.decided_by_user_id` → `user` ON DELETE SET NULL(누가 결정했는지가 사라진다)
 * 【AI 임시 결정 · 나중에 테이블/정의에서】 지금은 손으로 적은 목록 — 엔티티 정의(onDelete)나 서버 FK 테이블에서 읽어 오도록 바꿀 자리.
 */
export const APPROVAL_CASCADE_DELETE_ENTITIES: readonly string[] = Object.freeze(['cmh_ai_task', 'cmh_ai_run', 'media', 'user']);

const CASCADE_COMPACT: ReadonlySet<string> = new Set(APPROVAL_CASCADE_DELETE_ENTITIES.map((e) => normalizeEntityName(e).replace(/[_.]/g, '')));

/** 지우면 승인 행이 바뀌는 엔티티인가(구분 글자 · 대소문자만 다른 이름도 같은 것으로) */
export function isApprovalCascadeDeleteEntity(entity: string): boolean {
  const n = normalizeEntityName(entity).replace(/[_.]/g, '');
  return n.length > 0 && CASCADE_COMPACT.has(n);
}

/** `host:example.com` 은 그 호스트만 · `host:*.example.com` 은 하위 도메인만(example.com 자체는 아님 — 따로 적는다) */
export function checkHostAccess(permissions: readonly PluginPermission[], url: string): PermissionDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid url' };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, reason: 'only https is allowed' };
  const host = parsed.hostname.toLowerCase();
  const granted = permissions.some((p) => {
    if (p.kind !== 'host') return false;
    if (p.host.startsWith('*.')) return host.endsWith(p.host.slice(1)) && host.length > p.host.length - 1;
    return host === p.host;
  });
  return granted ? ALLOW : { allowed: false, reason: `permission "host:${host}" not declared` };
}

/** `tool:a:b` 는 그 이름만 · 마지막 마디 `*` 는 한 마디 아무거나(예 tool:mcp:cmh-shop-api-mcp:*) */
export function checkToolAccess(permissions: readonly PluginPermission[], tool: string): PermissionDecision {
  const granted = permissions.some((p) => {
    if (p.kind !== 'tool') return false;
    if (p.tool === tool) return true;
    if (!p.tool.endsWith(':*')) return false;
    const prefix = p.tool.slice(0, -1);
    return tool.startsWith(prefix) && !tool.slice(prefix.length).includes(':') && tool.length > prefix.length;
  });
  return granted ? ALLOW : { allowed: false, reason: `permission "tool:${tool}" not declared` };
}
