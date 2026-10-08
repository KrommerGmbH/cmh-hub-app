import { describe, expect, it } from 'vitest';
import {
  HOST_METHODS,
  LogRateLimiter,
  createHostMethods,
  entitySchemaFromDefinitions,
  findApprovalAssociationKey,
  unknownHostMethod,
  type PermissionDeniedInfo,
  type PluginDataAccess,
  type PluginEntitySchema,
} from './plugin-host-api.js';
import { APPROVAL_CASCADE_DELETE_ENTITIES, PLUGIN_RESERVED_ENTITIES, checkEntityAccess, isApprovalCascadeDeleteEntity, isPluginReservedEntity } from './plugin-permissions.js';
import { parseManifest, type PluginManifest } from './plugin-manifest.js';
import { RPC_ERROR, RpcEndpoint, RpcError, type RpcMessage } from './plugin-rpc.js';

function manifestOf(input: Record<string, unknown>): PluginManifest {
  const result = parseManifest({ name: 'matrix', version: '1.0.0', minAppVersion: '0.1.0', main: 'main.mjs', activationEvents: ['onStartup'], ...input });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.manifest;
}

const MANIFEST = manifestOf({
  contributes: { settings: [{ key: 'greeting', type: 'string', default: 'hi' }, { key: 'limit', type: 'number' }] },
  permissions: ['entity:cmh_ai_prompt:read', 'entity:hello_note:crud', 'entity:cmh_ai_approval:read'],
});

class FakeData implements PluginDataAccess {
  readonly calls: string[] = [];
  async search(entity: string) { this.calls.push(`search:${entity}`); return { total: 0 }; }
  async get(entity: string, id: string) { this.calls.push(`get:${entity}:${id}`); return null; }
  async upsert(entity: string) { this.calls.push(`upsert:${entity}`); return { written: 1 }; }
  async delete(entity: string) { this.calls.push(`delete:${entity}`); return { deleted: 1 }; }
}

function setup(manifest = MANIFEST, settings: Record<string, unknown> = {}) {
  const data = new FakeData();
  const denied: PermissionDeniedInfo[] = [];
  const logs: string[] = [];
  const methods = createHostMethods({
    manifest,
    data,
    settings: { get: (plugin, key) => settings[`${plugin}/${key}`] },
    onPermissionDenied: (info) => denied.push(info),
    onLog: (plugin, level, message) => logs.push(`${plugin}:${level}:${message}`),
  });
  const call = async (method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; code: number; message: string }> => {
    const handler = methods[method];
    if (!handler) {
      const error = unknownHostMethod(method);
      return error ? { ok: false, code: error.code, message: error.message } : { ok: false, code: RPC_ERROR.methodNotFound, message: 'not found' };
    }
    try {
      return { ok: true, value: await handler(params) };
    } catch (error) {
      const e = error as RpcError;
      return { ok: false, code: e.code, message: e.message };
    }
  };
  return { data, denied, logs, call };
}

describe('host:* — 권한 표(deny by default)', () => {
  // [메서드, params, 통과?, 거부 코드]
  const matrix: Array<[string, unknown, boolean, number?]> = [
    ['host:log', { level: 'info', message: 'x' }, true],
    ['host:data.search', { entity: 'cmh_ai_prompt' }, true],
    ['host:data.get', { entity: 'cmh_ai_prompt', id: 'a' }, true],
    ['host:data.search', { entity: 'cmh_ai_task' }, false, RPC_ERROR.permissionDenied],
    ['host:data.upsert', { entity: 'cmh_ai_prompt', rows: [] }, false, RPC_ERROR.permissionDenied], // read 만 선언
    ['host:data.upsert', { entity: 'hello_note', rows: [{}] }, true],
    ['host:data.delete', { entity: 'hello_note', ids: ['1'] }, true],
    ['host:data.delete', { entity: 'cmh_ai_task', ids: ['1'] }, false, RPC_ERROR.permissionDenied],
    ['host:data.search', { entity: 'cmh_ai_approval' }, true], // 읽기는 선언하면 된다
    ['host:data.upsert', { entity: 'cmh_ai_approval', rows: [{ status: 'approved' }] }, false, RPC_ERROR.permissionDenied],
    ['host:data.upsert', { entity: 'cmhAiApproval', rows: [] }, false, RPC_ERROR.permissionDenied],
    ['host:settings.get', { key: 'greeting' }, true],
    ['host:settings.get', { key: 'other-plugin.secret' }, false, RPC_ERROR.permissionDenied],
    ['host:nope', {}, false, RPC_ERROR.permissionDenied],
    ['host:data.drop', { entity: 'hello_note' }, false, RPC_ERROR.permissionDenied],
    ['host:data.search', {}, false, RPC_ERROR.invalidParams],
    ['host:data.get', { entity: 'cmh_ai_prompt' }, false, RPC_ERROR.invalidParams],
    ['host:settings.get', {}, false, RPC_ERROR.invalidParams],
  ];
  for (const [method, params, allowed, code] of matrix) {
    it(`${method} ${JSON.stringify(params)} → ${allowed ? 'allow' : `deny(${code})`}`, async () => {
      const { call } = setup();
      const result = await call(method, params);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.code).toBe(code);
    });
  }

  it('거부되면 자료층을 부르지 않고 거부 기록을 남긴다', async () => {
    const { call, data, denied } = setup();
    await call('host:data.search', { entity: 'cmh_ai_task' });
    await call('host:data.upsert', { entity: 'cmh_ai_approval', rows: [] });
    await call('host:settings.get', { key: 'secret' });
    expect(data.calls).toEqual([]);
    expect(denied).toEqual([
      { plugin: 'matrix', method: 'host:data.search', entity: 'cmh_ai_task', operation: 'read', reason: 'permission "entity:cmh_ai_task:read" not declared' },
      { plugin: 'matrix', method: 'host:data.upsert', entity: 'cmh_ai_approval', operation: 'write', reason: 'writes to cmh_ai_approval are only allowed from the app UI' },
      { plugin: 'matrix', method: 'host:settings.get', reason: 'setting "secret" is not declared in contributes.settings' },
    ]);
  });

  it('settings.get — 자기 이름 공간 · 값이 없거나 타입이 다르면 선언한 default(없으면 null)', async () => {
    const { call } = setup(MANIFEST, { 'matrix/greeting': 'hallo', 'other/greeting': 'stolen', 'matrix/limit': 'not-a-number' });
    expect(await call('host:settings.get', { key: 'greeting' })).toEqual({ ok: true, value: 'hallo' });
    expect(await call('host:settings.get', { key: 'limit' })).toEqual({ ok: true, value: null });
    const fresh = setup(MANIFEST, {});
    expect(await fresh.call('host:settings.get', { key: 'greeting' })).toEqual({ ok: true, value: 'hi' });
  });

  it('옛 이름(repository.* · log)은 같은 검사를 지난다', async () => {
    const { call } = setup();
    expect((await call('repository.search', { entity: 'cmh_ai_task' })).ok).toBe(false);
    expect((await call('repository.search', { entity: 'cmh_ai_prompt' })).ok).toBe(true);
  });

  it('HOST_METHODS 의 이름은 전부 처리기가 있다', () => {
    const methods = createHostMethods({ manifest: MANIFEST });
    for (const name of HOST_METHODS) expect(typeof methods[name]).toBe('function');
  });

  it('unknownHostMethod — host: 만 permissionDenied · 그 밖은 null(Method not found 로)', () => {
    expect(unknownHostMethod('host:fs.read')?.code).toBe(RPC_ERROR.permissionDenied);
    expect(unknownHostMethod('ping')).toBeNull();
  });

  it('RpcEndpoint 에 꽂으면 모르는 host:* 는 permissionDenied 로 답한다', async () => {
    const sent: RpcMessage[] = [];
    const ep = new RpcEndpoint({ send: (m) => sent.push(m), methods: createHostMethods({ manifest: MANIFEST }), unknownMethod: unknownHostMethod });
    ep.handleMessage({ jsonrpc: '2.0', id: 1, method: 'host:exec', params: {} });
    ep.handleMessage({ jsonrpc: '2.0', id: 2, method: 'other', params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: RPC_ERROR.permissionDenied, message: 'permission denied: host method "host:exec" is not available to plugins' } },
      { jsonrpc: '2.0', id: 2, error: { code: RPC_ERROR.methodNotFound, message: 'method "other" not found' } },
    ]);
  });
});

describe('LogRateLimiter', () => {
  it('초당 상한 · 다음 창에서 버린 개수를 한 번 알린다', () => {
    let now = 10_000;
    const limiter = new LogRateLimiter(2, () => now);
    const dropped: number[] = [];
    const results = [1, 2, 3, 4].map(() => limiter.accept((n) => dropped.push(n)));
    expect(results).toEqual([true, true, false, false]);
    now += 1_000;
    expect(limiter.accept((n) => dropped.push(n))).toBe(true);
    expect(dropped).toEqual([2]);
  });
});

// ───────────── 검수 8 🔴1 · 🟡3 — 연관 · 점 경로 · 승인 연관 쓰기 · cascade 삭제 ─────────────

const CONVERSATION = 'cmh_ai_conversation';
const MESSAGE = 'cmh_ai_conversation_message';
/** packages/data/src/definition/entities/cmh-ai.ts:127(conversation.messages) · :148(message.conversation) 을 줄인 정의 — 시험이 better-sqlite3 를 싣지 않게 값은 여기 적는다 */
const CHAT_SCHEMA = entitySchemaFromDefinitions([
  { entityName: CONVERSATION, associations: [{ kind: 'oneToMany', propertyName: 'messages', reference: MESSAGE, referenceField: 'conversation_id' }] },
  { entityName: MESSAGE, associations: [{ kind: 'manyToOne', propertyName: 'conversation', storageName: 'conversation_id', reference: CONVERSATION }] },
]);

function chatSetup(permissions: string[], schema?: PluginEntitySchema) {
  const data = new FakeData();
  const denied: PermissionDeniedInfo[] = [];
  const methods = createHostMethods({ manifest: manifestOf({ permissions }), data, ...(schema ? { schema } : {}), onPermissionDenied: (info) => denied.push(info) });
  const call = async (method: string, params: unknown): Promise<{ ok: true } | { ok: false; code: number; message: string }> => {
    try {
      await methods[method]!(params);
      return { ok: true };
    } catch (error) {
      const e = error as RpcError;
      return { ok: false, code: e.code, message: e.message };
    }
  };
  return { data, denied, call };
}

describe('host:data.search — 연관 · 점 경로(schema 없음 = 늘 거부)', () => {
  const READ_CONVERSATION = [`entity:${CONVERSATION}:read`];
  const search = (criteria: unknown) => ({ entity: CONVERSATION, criteria });

  it('검수 8 재현 — associations.messages · contains messages.content 는 거부 · 자료층을 부르지 않는다', async () => {
    const { data, denied, call } = chatSetup(READ_CONVERSATION);
    expect(await call('host:data.search', search({ associations: { messages: {} } }))).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(await call('host:data.search', search({ filter: [{ type: 'contains', field: 'messages.content', value: '모델' }] }))).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(data.calls).toEqual([]);
    expect(denied).toHaveLength(2);
  });

  it('filter(중첩 multi · not) · post-filter · sort · aggregations(field · terms sort) 의 점 경로 모두 거부', async () => {
    const { data, call } = chatSetup(READ_CONVERSATION);
    const dotted = { type: 'equals', field: 'messages.role', value: 'user' };
    const cases: unknown[] = [
      { filter: [{ type: 'multi', operator: 'and', queries: [{ type: 'not', operator: 'or', queries: [dotted] }] }] },
      { 'post-filter': [dotted] },
      { sort: [{ field: 'messages.createdAt', order: 'DESC' }] },
      { aggregations: [{ type: 'count', name: 'n', field: 'messages.id' }] },
      { aggregations: [{ type: 'terms', name: 't', field: 'title', sort: { field: 'messages.content' } }] },
    ];
    for (const criteria of cases) expect(await call('host:data.search', search(criteria))).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(data.calls).toEqual([]);
  });

  it('term · query · grouping · includes · fields 에 값이 있으면 · 모르는 키 · 모르는 filter/aggregation type · 중첩 aggregation 은 거부', async () => {
    const { data, call } = chatSetup(READ_CONVERSATION);
    const cases: unknown[] = [
      { term: 'secret' },
      { query: [{ score: 1, query: { type: 'contains', field: 'messages.content', value: 'x' } }] },
      { grouping: ['messages.role'] },
      { includes: { [MESSAGE]: ['content'] } },
      { fields: ['messages.content'] },
      { unknownKey: 1 },
      { filter: [{ type: 'nested', field: 'title', value: 'x' }] },
      { aggregations: [{ type: 'entity', name: 'e', field: 'id', definition: MESSAGE }] },
      { aggregations: [{ type: 'terms', name: 't', field: 'title', aggregation: { type: 'count', name: 'c', field: 'messages.id' } }] },
    ];
    for (const criteria of cases) expect(await call('host:data.search', search(criteria))).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(data.calls).toEqual([]);
  });

  it('자기 칸 · `<entity>.` 접두 한 번 · 빈 unsupported 키는 통과', async () => {
    const { data, call } = chatSetup(READ_CONVERSATION);
    const criteria = {
      page: 1,
      limit: 10,
      filter: [{ type: 'multi', operator: 'or', queries: [{ type: 'contains', field: 'title', value: 'a' }, { type: 'equals', field: `${CONVERSATION}.title`, value: 'b' }] }],
      sort: [{ field: 'createdAt', order: 'DESC' }],
      aggregations: [{ type: 'terms', name: 't', field: 'title', sort: { field: 'title' } }],
      term: '',
      includes: {},
      'total-count-mode': 1,
    };
    expect(await call('host:data.search', search(criteria))).toEqual({ ok: true });
    expect(data.calls).toEqual([`search:${CONVERSATION}`]);
  });

  it('`<entity>.` 접두를 두 번 붙이면 연관으로 본다 → schema 없으면 거부(자료층보다 좁게)', async () => {
    const { call } = chatSetup(READ_CONVERSATION);
    expect(await call('host:data.search', search({ filter: [{ type: 'equals', field: `${CONVERSATION}.${CONVERSATION}.title`, value: 'x' }] }))).toMatchObject({ ok: false });
  });

  it('꼴이 틀리면 invalidParams — criteria · filter · sort 가 객체 아님 · field 가 글자 아님', async () => {
    const { call } = chatSetup(READ_CONVERSATION);
    for (const criteria of ['x', [1], { filter: 'x' }, { filter: [1] }, { sort: [1] }, { filter: [{ type: 'equals', field: 1, value: 'x' }] }]) {
      expect(await call('host:data.search', search(criteria))).toMatchObject({ ok: false, code: RPC_ERROR.invalidParams });
    }
  });
});

describe('host:data.search — schema 로 연관 대상을 풀면 대상마다 read 검사', () => {
  it('두 엔티티를 다 선언했으면 associations · 점 경로 허락', async () => {
    const { data, call } = chatSetup([`entity:${CONVERSATION}:read`, `entity:${MESSAGE}:read`], CHAT_SCHEMA);
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { messages: { filter: [{ type: 'equals', field: 'conversation.title', value: 'x' }] } } } })).toEqual({ ok: true });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { filter: [{ type: 'contains', field: 'messages.content', value: 'x' }] } })).toEqual({ ok: true });
    expect(data.calls).toEqual([`search:${CONVERSATION}`, `search:${CONVERSATION}`]);
  });

  it('대상(message)을 선언 안 했으면 거부 — 거부 기록의 entity 는 대상', async () => {
    const { data, denied, call } = chatSetup([`entity:${CONVERSATION}:read`], CHAT_SCHEMA);
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { messages: {} } } })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied, message: expect.stringMatching(/not declared/) as unknown });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { filter: [{ type: 'contains', field: 'messages.content', value: 'x' }] } })).toMatchObject({ ok: false });
    expect(denied.map((d) => d.entity)).toEqual([MESSAGE, MESSAGE]);
    expect(data.calls).toEqual([]);
  });

  it('정의에 없는 연관(서버에만 있는 approvals 등) · 점이 든 연관 이름은 거부', async () => {
    const { call } = chatSetup([`entity:${CONVERSATION}:read`, `entity:${MESSAGE}:read`, 'entity:cmh_ai_approval:read'], CHAT_SCHEMA);
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { approvals: {} } } })).toMatchObject({ ok: false, message: expect.stringMatching(/unknown association/) as unknown });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { 'messages.conversation': {} } } })).toMatchObject({ ok: false });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { filter: [{ type: 'equals', field: 'approvals.status', value: 'x' }] } })).toMatchObject({ ok: false });
  });

  it('associations 안 associations 도 대상마다(message → conversation 은 선언했으니 통과 · 깊이 상한 8)', async () => {
    const { call } = chatSetup([`entity:${CONVERSATION}:read`, `entity:${MESSAGE}:read`], CHAT_SCHEMA);
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { messages: { associations: { conversation: {} } } } } })).toEqual({ ok: true });
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) deep = { associations: { messages: { associations: { conversation: deep } } } };
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: deep })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
  });
});

describe('host:data.upsert · delete — 승인 행을 바꾸는 길(검수 8 🟡3)', () => {
  it('rows 안(중첩 객체 · 배열)에 승인 연관 키가 있으면 거부 · 없으면 통과', async () => {
    const { data, call } = chatSetup(['entity:hello_note:crud']);
    const bad: unknown[] = [
      [{ id: 'a', approvals: [{ status: 'approved' }] }],
      [{ id: 'a', nested: { deeper: [{ cmhAiApprovals: [] }] } }],
      [{ id: 'a', CmhAiDecidedApprovals: [] }],
      [{ id: 'a', cmh_ai_approvals: [] }],
    ];
    for (const rows of bad) expect(await call('host:data.upsert', { entity: 'hello_note', rows })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(await call('host:data.upsert', { entity: 'hello_note', rows: [{ id: 'a', note: 'approvals 는 값이면 괜찮다', tags: ['approval'] }] })).toEqual({ ok: true });
    expect(data.calls).toEqual(['upsert:hello_note']);
  });

  it('findApprovalAssociationKey — 아주 깊은 JSON 에도 스택이 넘치지 않는다', () => {
    let deep: unknown = { approvals: [] };
    for (let i = 0; i < 20_000; i += 1) deep = [deep];
    expect(findApprovalAssociationKey(deep)).toBe('approvals');
    expect(findApprovalAssociationKey([{ a: 1 }, 'x', null])).toBeNull();
  });

  it('지우면 승인 행이 바뀌는 엔티티(cmh_ai_task · cmh_ai_run · media · user)는 crud 를 선언해도 delete 거부 · 다른 엔티티는 통과', async () => {
    const { data, call } = chatSetup(['entity:cmh_ai_task:crud', 'entity:cmh_ai_run:crud', 'entity:media:crud', 'entity:user:crud', 'entity:hello_note:crud']);
    expect(APPROVAL_CASCADE_DELETE_ENTITIES).toEqual(['cmh_ai_task', 'cmh_ai_run', 'media', 'user']);
    for (const entity of APPROVAL_CASCADE_DELETE_ENTITIES) {
      expect(await call('host:data.delete', { entity, ids: ['a'] })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    }
    expect(isApprovalCascadeDeleteEntity('cmhAiTask')).toBe(true);
    expect(isApprovalCascadeDeleteEntity('CMH-AI-RUN')).toBe(true);
    expect(await call('host:data.delete', { entity: 'hello_note', ids: ['a'] })).toEqual({ ok: true });
    // upsert 는 막지 않는다(지울 때만 승인 행이 바뀐다)
    expect(await call('host:data.upsert', { entity: 'cmh_ai_task', rows: [{ id: 'a' }] })).toEqual({ ok: true });
    expect(data.calls).toEqual(['delete:hello_note', 'upsert:cmh_ai_task']);
  });
});

describe('예약 엔티티 system_config · 연관 hop 대상 막기(검수 10 🟡4)', () => {
  /** 시험용 정의 — conversation 에서 system_config · 승인 엔티티로 가는 연관이 «있다고 치고» hop 대상 검사만 본다(실제 정의에는 없다) */
  const SCHEMA = entitySchemaFromDefinitions([
    {
      entityName: CONVERSATION,
      associations: [
        { kind: 'oneToMany', propertyName: 'messages', reference: MESSAGE, referenceField: 'conversation_id' },
        { kind: 'manyToOne', propertyName: 'config', storageName: 'config_id', reference: 'system_config' },
        { kind: 'oneToMany', propertyName: 'approvalRows', reference: 'cmh_ai_approval', referenceField: 'conversation_id' },
      ],
    },
    { entityName: MESSAGE, associations: [{ kind: 'manyToOne', propertyName: 'conversation', storageName: 'conversation_id', reference: CONVERSATION }] },
  ]);

  it('host:data.* 루트로 system_config — 매니페스트 검증을 우회해 선언이 있어도 넷 다 거부(이름 꼴만 다른 것도)', async () => {
    const forged = { ...manifestOf({}), permissions: [{ kind: 'entity' as const, entity: 'system_config', access: 'crud' as const, raw: 'entity:system_config:crud' }] };
    const data = new FakeData();
    const methods = createHostMethods({ manifest: forged, data });
    const calls: Array<[string, unknown]> = [
      ['host:data.search', { entity: 'system_config' }],
      ['host:data.get', { entity: 'system_config', id: 'a' }],
      ['host:data.upsert', { entity: 'system_config', rows: [{ id: 'a' }] }],
      ['host:data.delete', { entity: 'system_config', ids: ['a'] }],
      ['host:data.search', { entity: 'systemConfig' }],
    ];
    for (const [method, params] of calls) {
      await expect((async () => methods[method]!(params))()).rejects.toMatchObject({ code: RPC_ERROR.permissionDenied });
    }
    expect(data.calls).toEqual([]);
    expect(checkEntityAccess(forged.permissions, 'system_config', 'read').allowed).toBe(false);
    expect(PLUGIN_RESERVED_ENTITIES).toEqual(['system_config']);
    expect(isPluginReservedEntity('SYSTEM-CONFIG')).toBe(true);
  });

  it('연관 hop 대상이 system_config · 승인 엔티티면 read 를 선언해도 거부(승인 엔티티 루트 read 는 그대로 허락)', async () => {
    const { data, denied, call } = chatSetup([`entity:${CONVERSATION}:read`, `entity:${MESSAGE}:read`, 'entity:cmh_ai_approval:read'], SCHEMA);
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { config: {} } } })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { filter: [{ type: 'equals', field: 'config.configurationKey', value: 'x' }] } })).toMatchObject({ ok: false });
    expect(await call('host:data.search', { entity: CONVERSATION, criteria: { associations: { approvalRows: {} } } })).toMatchObject({ ok: false, code: RPC_ERROR.permissionDenied });
    expect(await call('host:data.search', { entity: MESSAGE, criteria: { sort: [{ field: 'conversation.approvalRows.status' }] } })).toMatchObject({ ok: false });
    expect(denied.map((d) => d.entity)).toEqual(['system_config', 'system_config', 'cmh_ai_approval', 'cmh_ai_approval']);
    expect(await call('host:data.search', { entity: 'cmh_ai_approval' })).toEqual({ ok: true });
    expect(data.calls).toEqual(['search:cmh_ai_approval']);
  });
});
