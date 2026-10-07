import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, defineEntity, EntityDefinitionError, EntityRegistry } from './index.js';

describe('EntityRegistry', () => {
  it('1차 정의 여섯 · 서버와 같은 이름', () => {
    const r = createDefaultRegistry();
    expect(r.all().map((d) => d.entityName)).toEqual([
      'cmh_ai_provider',
      'cmh_ai_model',
      'cmh_ai_mcp_server',
      'cmh_ai_mcp_tool',
      'cmh_ai_conversation',
      'cmh_ai_conversation_message',
    ]);
    const p = r.get('cmh_ai_provider');
    expect(p.field('apiKeyEnc')).toBe(p.field('api_key_enc'));
    expect(p.field('api_key_enc')?.apiAware).toBe(false);
    expect(p.field('cmh_ai_provider.baseUrl')?.name).toBe('base_url');
    expect(p.field('created_at')?.required).toBe(true);
    expect(p.primaryKey.name).toBe('id');
  });

  it('같은 엔티티 두 번 · 모르는 엔티티 = 예외', () => {
    const r = createDefaultRegistry();
    expect(() => r.register(defineEntity({ entityName: 'cmh_ai_provider', fields: [] }))).toThrow(EntityDefinitionError);
    expect(() => r.get('cmh_ai_nope')).toThrow(/모르는 엔티티/);
  });

  it('extendFields — 더하기 · 같은 칸 두 번이면 예외(저장 이름 · 속성 이름 · 한 번에 두 번)', () => {
    const r = createDefaultRegistry();
    r.extendFields('cmh_ai_model', [{ name: 'license', type: 'string' }]);
    expect(r.get('cmh_ai_model').field('license')?.type).toBe('string');
    expect(() => r.extendFields('cmh_ai_model', [{ name: 'license', type: 'string' }])).toThrow(/이미 있다/);
    expect(() => r.extendFields('cmh_ai_model', [{ name: 'code', type: 'string' }])).toThrow(/이미 있다/);
    expect(() => r.extendFields('cmh_ai_model', [{ name: 'provider', type: 'string' }])).toThrow(/이미 있다/);
    expect(() => r.extendFields('cmh_ai_model', [{ name: 'a_b', type: 'int' }, { name: 'a_b', type: 'int' }])).toThrow(/두 번/);
    // 실패한 묶음은 하나도 들어가지 않는다
    expect(() => r.extendFields('cmh_ai_model', [{ name: 'local_path', type: 'string' }, { name: 'code', type: 'string' }])).toThrow();
    expect(r.get('cmh_ai_model').field('local_path')).toBeNull();
    expect(() => r.extendFields('cmh_ai_nope', [{ name: 'x', type: 'int' }])).toThrow(/모르는 엔티티/);
  });

  it('번역 PK · fk 는 막는다', () => {
    const r = new EntityRegistry();
    expect(() => r.register(defineEntity({ entityName: 'x', fields: [{ name: 'other_id', type: 'fk', translated: true }] }))).toThrow(EntityDefinitionError);
  });
});
