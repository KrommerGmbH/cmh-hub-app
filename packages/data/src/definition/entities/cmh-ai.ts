// R1 1차 엔티티 여섯 — 칸 이름 · 종류 · 필수 · 비밀(!api)은 서버 CmhAiAgent 와 같다(2026-10-07 대조).
// 근거: CmhAiAgent/src/Core/Content/<이름>/*Definition.php · 기본값 · UNIQUE · FK 동작은
// src/Migration/Migration1790100000CmhAiAgentSchema.php(:537 provider · :562 model · :886 conversation · :972 message · :997 mcp_server · :1016 mcp_tool)
// + Migration1790100100(free_tier) · 1790100200(inactive_reason) · 1790100300(company_id).
// 합의안 2: 서버에 없는 새 칸(license · local_path · unread …)은 1차에 넣지 않는다(서버 마이그레이션은 사장님 승인 대상).
import { defineEntity } from '../define-entity.js';
import type { EntityDefinition } from '../types.js';

/** Shopware `Defaults::LIVE_VERSION` — 서버 cmh_ai_conversation.agent_version_id 기본값(Migration1790100000:11 · :891) */
export const LIVE_VERSION_ID = '0fa91ce3e96a4bc2be4bd9ce752c3425';

export const cmhAiProviderDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_provider',
  fields: [
    { name: 'code', type: 'string', required: true, maxLength: 64 },
    { name: 'name', type: 'string', required: true, maxLength: 255 },
    { name: 'kind', type: 'string', maxLength: 16, defaultValue: 'local' },
    { name: 'base_url', type: 'string', maxLength: 500 },
    // 서버도 IdField(FK 없음 · Migration1790100300) — 회사 격리용
    { name: 'company_id', type: 'id' },
    { name: 'models_url', type: 'string', maxLength: 500 },
    { name: 'price_url', type: 'string', maxLength: 500 },
    // 비밀칸 — 값은 safeStorage 암호 blob(평문 0 · PLAN R1 §9)
    { name: 'api_key_enc', type: 'text', apiAware: false },
    { name: 'active', type: 'bool', defaultValue: true },
    { name: 'free_tier', type: 'bool', defaultValue: false },
    { name: 'daily_limit', type: 'int' },
    { name: 'rpm_limit', type: 'int' },
    { name: 'rpm_headroom', type: 'int', defaultValue: 3 },
    { name: 'used_today', type: 'int', defaultValue: 0 },
    { name: 'used_today_date', type: 'date' },
    { name: 'used_minute', type: 'int', defaultValue: 0 },
    { name: 'used_minute_at', type: 'datetime' },
  ],
  associations: [{ kind: 'oneToMany', propertyName: 'models', reference: 'cmh_ai_model', referenceField: 'provider_id' }],
  uniques: [['code']],
});

export const cmhAiModelDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_model',
  fields: [
    { name: 'provider_id', type: 'fk', required: true, reference: 'cmh_ai_provider', onDelete: 'cascade' },
    { name: 'code', type: 'string', required: true, maxLength: 191 },
    { name: 'label', type: 'string', maxLength: 255 },
    { name: 'context_window', type: 'int' },
    { name: 'active', type: 'bool', defaultValue: true },
    { name: 'inactive_reason', type: 'string', maxLength: 16 },
    { name: 'last_seen_at', type: 'datetime' },
    { name: 'description', type: 'text' },
    { name: 'output_token_limit', type: 'int' },
    { name: 'abilities', type: 'string', maxLength: 500 },
    { name: 'thinking', type: 'bool' },
    { name: 'tool_calling', type: 'bool' },
    { name: 'enabled_by_user', type: 'bool' },
    // 서버 decimal(12,4) · DAL FloatField
    { name: 'price_in_per_mtok', type: 'float' },
    { name: 'price_out_per_mtok', type: 'float' },
    { name: 'price_currency', type: 'string', maxLength: 3 },
    { name: 'price_source', type: 'string', maxLength: 16 },
    { name: 'price_checked_at', type: 'datetime' },
    { name: 'last_error', type: 'text' },
    { name: 'last_failed_at', type: 'datetime' },
  ],
  associations: [{ kind: 'manyToOne', propertyName: 'provider', storageName: 'provider_id', reference: 'cmh_ai_provider' }],
  uniques: [['provider_id', 'code']],
});

export const cmhAiMcpServerDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_mcp_server',
  fields: [
    { name: 'code', type: 'string', required: true, maxLength: 64 },
    { name: 'name', type: 'string', required: true, maxLength: 255 },
    { name: 'type', type: 'string', required: true, maxLength: 32, defaultValue: 'stdio' },
    { name: 'command', type: 'string', maxLength: 255 },
    { name: 'args', type: 'json' },
    { name: 'url', type: 'string', maxLength: 500 },
    { name: 'env_keys', type: 'json' },
    { name: 'active', type: 'bool', defaultValue: true },
    { name: 'gateway_managed', type: 'bool', defaultValue: false },
    { name: 'description', type: 'text' },
  ],
  // 서버의 serverSecrets · agentMcpServers · skillMcpServers 는 그 엔티티가 로컬에 생길 때 더한다(다음 차례)
  associations: [{ kind: 'oneToMany', propertyName: 'tools', reference: 'cmh_ai_mcp_tool', referenceField: 'server_id' }],
  uniques: [['code']],
});

export const cmhAiMcpToolDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_mcp_tool',
  fields: [
    { name: 'server_id', type: 'fk', required: true, reference: 'cmh_ai_mcp_server', onDelete: 'cascade' },
    { name: 'name', type: 'string', required: true, maxLength: 64 },
    { name: 'title', type: 'string', maxLength: 255 },
    { name: 'description', type: 'text' },
    { name: 'parameters', type: 'json' },
    { name: 'active', type: 'bool', defaultValue: true },
    { name: 'needs_approval', type: 'bool', defaultValue: false },
  ],
  associations: [{ kind: 'manyToOne', propertyName: 'server', storageName: 'server_id', reference: 'cmh_ai_mcp_server' }],
  uniques: [['server_id', 'name']],
});

export const cmhAiConversationDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_conversation',
  fields: [
    // user · customer 는 Shopware 코어 테이블 — 로컬에 없으니 FK 제약 없이 id 칸만(서버는 ON DELETE SET NULL)
    { name: 'user_id', type: 'fk' },
    { name: 'customer_id', type: 'fk' },
    // cmh_ai_agent 는 다음 차례 — 그때 reference 를 단다(서버 FK 는 (agent_id, agent_version_id) 묶음)
    { name: 'agent_id', type: 'fk', required: true },
    // 서버 ReferenceVersionField — 로컬 1차는 live 판 하나만
    { name: 'agent_version_id', type: 'id', required: true, defaultValue: LIVE_VERSION_ID },
    { name: 'counterpart_type', type: 'string', required: true, maxLength: 32, defaultValue: 'user' },
    // cmh_ai_capability 도 다음 차례(서버 ON DELETE SET NULL)
    { name: 'capability_id', type: 'fk' },
    { name: 'title', type: 'string', maxLength: 255, defaultValue: '' },
    { name: 'status', type: 'string', maxLength: 32, defaultValue: 'active' },
    { name: 'summary', type: 'text' },
    { name: 'summary_upto_seq', type: 'int', defaultValue: 0 },
    { name: 'token_total', type: 'int', defaultValue: 0 },
  ],
  // 서버의 runs(cmh_ai_run) · user · customer · agent · capability 연관은 로컬에 대상이 생길 때 더한다
  associations: [
    { kind: 'oneToMany', propertyName: 'messages', reference: 'cmh_ai_conversation_message', referenceField: 'conversation_id' },
  ],
});

export const cmhAiConversationMessageDefinition: EntityDefinition = defineEntity({
  entityName: 'cmh_ai_conversation_message',
  fields: [
    { name: 'conversation_id', type: 'fk', required: true, reference: 'cmh_ai_conversation', onDelete: 'cascade' },
    { name: 'seq', type: 'int', required: true },
    { name: 'role', type: 'string', required: true, maxLength: 32 },
    { name: 'kind', type: 'string', maxLength: 32, defaultValue: 'normal' },
    { name: 'content', type: 'text' },
    { name: 'content_hash', type: 'string', maxLength: 32 },
    { name: 'attachments', type: 'json' },
    // cmh_ai_chat_run · cmh_ai_run 은 다음 차례(서버 ON DELETE SET NULL)
    { name: 'chat_run_id', type: 'fk' },
    { name: 'run_id', type: 'fk' },
    { name: 'tokens', type: 'int', defaultValue: 0 },
    { name: 'status', type: 'string', maxLength: 32, defaultValue: 'done' },
  ],
  associations: [
    { kind: 'manyToOne', propertyName: 'conversation', storageName: 'conversation_id', reference: 'cmh_ai_conversation' },
  ],
  uniques: [['conversation_id', 'seq']],
});

/** 1차 정의 셋 — 등록 차례 = FK 차례(부모 먼저) */
export const CMH_AI_DEFINITIONS: readonly EntityDefinition[] = [
  cmhAiProviderDefinition,
  cmhAiModelDefinition,
  cmhAiMcpServerDefinition,
  cmhAiMcpToolDefinition,
  cmhAiConversationDefinition,
  cmhAiConversationMessageDefinition,
];
