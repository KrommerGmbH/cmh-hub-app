export * from './types.js';
export { defineEntity, DEFAULT_FIELDS, translationTableName, translationForeignKey, type EntityDefinitionInput } from './define-entity.js';
export { EntityRegistry, ResolvedEntityDefinition, EntityDefinitionError } from './registry.js';
export * from './entities/cmh-ai.js';
export * from './entities/system-config.js';
import { EntityRegistry } from './registry.js';
import { CMH_AI_DEFINITIONS } from './entities/cmh-ai.js';
import { LOCAL_APP_DEFINITIONS } from './entities/system-config.js';

/** 1차 정의(cmh_ai_* 여섯 + 로컬 앱 전용 system_config)를 등록한 새 레지스트리 — 플러그인이 extendFields 로 고치므로 싱글톤이 아니다 */
export function createDefaultRegistry(): EntityRegistry {
  const registry = new EntityRegistry();
  for (const d of CMH_AI_DEFINITIONS) registry.register(d);
  for (const d of LOCAL_APP_DEFINITIONS) registry.register(d);
  return registry;
}
