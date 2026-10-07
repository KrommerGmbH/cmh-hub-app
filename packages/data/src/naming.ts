// R1 — 칸 이름: 저장 = snake_case(서버 CmhAiAgent 테이블과 같은 이름) · 속성 = camelCase(Shopware 응답 꼴)
import { randomUUID } from 'node:crypto';

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** 엔티티 이름 → Admin API 경로 조각 (`cmh_ai_provider` → `cmh-ai-provider`) */
export function entityNameToPath(entityName: string): string {
  return entityName.replace(/_/g, '-');
}

/** id = uuid v4 를 하이픈 없는 32자 hex 로(Shopware 가 API 로 주고받는 id 꼴) */
export function newId(): string {
  return randomUUID().replace(/-/g, '');
}

const ID_PATTERN = /^[0-9a-f]{32}$/;
export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
