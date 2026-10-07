// R2-a — 플러그인 권한 검사. main 쪽 RPC 핸들러가 플러그인의 요청 하나하나마다 부른다(플러그인 쪽 검사는 믿지 않는다).
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 원칙 8(촘촘한 제어): 매니페스트 `permissions` 에 선언이 없으면 거부 · 승인 엔티티 쓰기는 선언이 있어도(매니페스트 검증을 우회해도) 늘 거부.

import { isWriteProtectedEntity } from '../settings/approval-entity.js';
import type { PluginPermission } from './plugin-manifest.js';

export type EntityOperation = 'read' | 'write';

export interface PermissionDecision {
  readonly allowed: boolean;
  /** 거부 까닭(영문 · 플러그인에게 그대로 돌려준다) */
  readonly reason: string;
}

const ALLOW: PermissionDecision = Object.freeze({ allowed: true, reason: 'declared' });

export function checkEntityAccess(permissions: readonly PluginPermission[], entity: string, operation: EntityOperation): PermissionDecision {
  if (operation === 'write' && isWriteProtectedEntity(entity)) {
    return { allowed: false, reason: `writes to ${entity} are only allowed from the app UI` };
  }
  const granted = permissions.some((p) => p.kind === 'entity' && p.entity === entity && (operation === 'read' || p.access === 'crud'));
  return granted ? ALLOW : { allowed: false, reason: `permission "entity:${entity}:${operation === 'read' ? 'read' : 'crud'}" not declared` };
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
