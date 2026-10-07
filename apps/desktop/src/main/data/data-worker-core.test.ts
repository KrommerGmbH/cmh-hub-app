// 검수 6 S1 — 쓰기 보호 엔티티(cmh_ai_approval)에 ON DELETE CASCADE · SET NULL FK 가 있으면 open 을 거부한다(가짜 정의로 시험).
// DataWorkerCore 를 이 프로세스 안에서 바로 부른다(전송 없음 · ':memory:').
import { createDefaultRegistry, defineEntity, type EntityRegistry, type FieldDefinition } from '@cmh-hub-app/data';
import { describe, expect, it } from 'vitest';
import { RpcError } from '../plugin/plugin-rpc.js';
import { DATA_METHOD, DATA_RPC_ERROR, type DataOpenErrorData } from './data-protocol.js';
import { DataWorkerCore, findProtectedCascades } from './data-worker-core.js';

function fk(name: string, onDelete?: FieldDefinition['onDelete']): FieldDefinition {
  return onDelete === undefined ? { name, type: 'fk', reference: 'cmh_ai_provider' } : { name, type: 'fk', reference: 'cmh_ai_provider', onDelete };
}

function registryWith(entityName: string, field: FieldDefinition): () => EntityRegistry {
  return () => {
    const registry = createDefaultRegistry();
    registry.register(defineEntity({ entityName, fields: [field] }));
    return registry;
  };
}

async function openError(core: DataWorkerCore): Promise<RpcError> {
  try {
    await core.methods()[DATA_METHOD.open]!({ filename: ':memory:' });
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('expected open to fail');
}

describe('findProtectedCascades', () => {
  it('쓰기 보호 엔티티의 cascade · set null fk 만 고른다(이름 꼴이 달라도)', () => {
    const found = findProtectedCascades([
      { entityName: 'cmh_ai_approval', fields: [fk('a_id', 'cascade'), fk('b_id', 'set null'), fk('c_id', 'restrict'), fk('d_id')] },
      { entityName: 'cmhAiApproval', fields: [fk('e_id', 'cascade')] },
      { entityName: 'cmh_ai_model', fields: [fk('provider_id', 'cascade')] },
    ]);
    expect(found).toEqual([
      { entity: 'cmh_ai_approval', field: 'a_id', reference: 'cmh_ai_provider', onDelete: 'cascade' },
      { entity: 'cmh_ai_approval', field: 'b_id', reference: 'cmh_ai_provider', onDelete: 'set null' },
      { entity: 'cmhAiApproval', field: 'e_id', reference: 'cmh_ai_provider', onDelete: 'cascade' },
    ]);
  });

  it('지금 기본 registry 에는 걸리는 것이 없다', () => {
    expect(findProtectedCascades(createDefaultRegistry().all())).toEqual([]);
  });
});

describe('DataWorkerCore.open — 쓰기 보호 엔티티 FK 검사', () => {
  for (const onDelete of ['cascade', 'set null'] as const) {
    it(`cmh_ai_approval 에 ON DELETE ${onDelete.toUpperCase()} fk 가 있으면 열지 않는다 · DataSource 를 만들지 않는다`, async () => {
      let created = 0;
      let failed = 0;
      const core = new DataWorkerCore({
        createRegistry: registryWith('cmh_ai_approval', fk('provider_id', onDelete)),
        create: () => {
          created += 1;
          return Promise.reject(new Error('must not be called'));
        },
        onOpenFailed: () => {
          failed += 1;
        },
      });
      const error = await openError(core);
      expect(error.code).toBe(DATA_RPC_ERROR.openFailed);
      expect(error.message).toContain(`cmh_ai_approval.provider_id → cmh_ai_provider ON DELETE ${onDelete.toUpperCase()}`);
      expect(error.data).toEqual({ name: 'ProtectedEntityCascadeError', reason: 'protectedEntityCascade', backupPath: null } satisfies DataOpenErrorData);
      expect(created).toBe(0);
      expect(failed).toBe(1);
      expect(core.isOpen).toBe(false);
    });
  }

  it('restrict fk 는 연다(대상 delete 를 막을 뿐 승인 줄을 바꾸지 않는다)', async () => {
    const core = new DataWorkerCore({ createRegistry: registryWith('cmh_ai_approval', fk('provider_id', 'restrict')) });
    const result = await core.methods()[DATA_METHOD.open]!({ filename: ':memory:' });
    expect(result).toEqual(expect.objectContaining({ filename: ':memory:' }));
    expect(core.isOpen).toBe(true);
    await core.close();
  });

  it('보호 엔티티가 아니면 cascade fk 여도 연다 · registry 는 DataSource 에 그대로 넘긴다', async () => {
    const core = new DataWorkerCore({ createRegistry: registryWith('cmh_ai_other', fk('provider_id', 'cascade')) });
    await core.methods()[DATA_METHOD.open]!({ filename: ':memory:' });
    const health = (await core.methods()[DATA_METHOD.health]!(undefined)) as { entities: number };
    expect(health.entities).toBe(createDefaultRegistry().all().length + 1);
    await core.close();
  });
});
