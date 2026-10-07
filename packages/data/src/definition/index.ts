export * from './types.js';
export { defineEntity, DEFAULT_FIELDS, translationTableName, translationForeignKey, type EntityDefinitionInput } from './define-entity.js';
export { EntityRegistry, ResolvedEntityDefinition, EntityDefinitionError } from './registry.js';
export * from './entities/cmh-ai.js';
import { EntityRegistry } from './registry.js';
import { CMH_AI_DEFINITIONS } from './entities/cmh-ai.js';

/** 1차 정의 여섯을 등록한 새 레지스트리 — 플러그인이 extendFields 로 고치므로 싱글톤이 아니다 */
export function createDefaultRegistry(): EntityRegistry {
  const registry = new EntityRegistry();
  for (const d of CMH_AI_DEFINITIONS) registry.register(d);
  return registry;
}
