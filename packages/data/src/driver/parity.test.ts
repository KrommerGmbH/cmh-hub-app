// PLAN R1 §9 완료 기준 — 같은 Criteria 를 SqliteDriver(메모리 DB)와 AdminApiDriver(가짜 transport · 서버 응답 고정 JSON)에 넣어
// ① 같은 elements(· total · aggregations) ② 가짜 transport 가 받은 본문 = criteria.parse()
// 고정 JSON 은 Shopware Admin API `Accept: application/json` 응답 꼴로 손으로 쓴 것(apiAlias · extensions · _uniqueIdentifier · translated ·
// 날짜시각 `+00:00` 꼴 · 비밀칸 없음). 서버 실측 응답이 아니다 — 서버 꼴과 다르면 이 파일을 실측으로 바꿔야 한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Criteria } from '../criteria.js';
import { createDefaultRegistry } from '../definition/index.js';
import { DataSourceFactory, type DataSource } from '../repository.js';
import { IDS, seededLocal } from '../test-support/fixtures.js';
import { AdminApiError, type AdminApiTransport } from './admin-api/admin-api-driver.js';
import { CriteriaError, DataWriteError } from './types.js';

const CREATED = '2026-10-07T09:00:00.000+00:00';
const extras = (alias: string, id: string) => ({ apiAlias: alias, extensions: {}, _uniqueIdentifier: id, translated: [] });

const SERVER_PROVIDER_P1 = {
  id: IDS.p1, code: 'openai', name: 'OpenAI', kind: 'remote', baseUrl: null, companyId: null, modelsUrl: null, priceUrl: null,
  active: true, freeTier: false, dailyLimit: 1000, rpmLimit: null, rpmHeadroom: 3, usedToday: 0,
  usedTodayDate: '2026-10-07T00:00:00.000+00:00', usedMinute: 0, usedMinuteAt: '2026-10-07T10:34:56.000+00:00',
  createdAt: CREATED, updatedAt: null, models: null, ...extras('cmh_ai_provider', IDS.p1),
};
const SERVER_PROVIDER_P2 = {
  id: IDS.p2, code: 'local-gguf', name: 'Local GGUF', kind: 'local', baseUrl: null, companyId: null, modelsUrl: null, priceUrl: null,
  active: true, freeTier: true, dailyLimit: null, rpmLimit: null, rpmHeadroom: 3, usedToday: 0,
  usedTodayDate: null, usedMinute: 0, usedMinuteAt: null,
  createdAt: CREATED, updatedAt: null, models: null, ...extras('cmh_ai_provider', IDS.p2),
};
const modelBase = {
  inactiveReason: null, description: null, outputTokenLimit: null, abilities: null, enabledByUser: null, priceOutPerMtok: null,
  priceCurrency: null, priceSource: null, priceCheckedAt: null, lastError: null, lastFailedAt: null, createdAt: CREATED, updatedAt: null,
};

/** POST /api/search/cmh-ai-model — active = true · provider 연관 · code ASC */
const SERVER_MODELS_RESPONSE = {
  total: 3,
  data: [
    { ...modelBase, id: IDS.m3, providerId: IDS.p2, code: 'gemma-4-e2b', label: 'Gemma 4 E2B', contextWindow: 128000, active: true, lastSeenAt: null, thinking: false, toolCalling: null, priceInPerMtok: null, provider: SERVER_PROVIDER_P2, agents: null, ...extras('cmh_ai_model', IDS.m3) },
    { ...modelBase, id: IDS.m1, providerId: IDS.p1, code: 'gpt-5', label: 'GPT 5', contextWindow: 400000, active: true, lastSeenAt: '2026-10-06T08:00:00.000+00:00', thinking: true, toolCalling: true, priceInPerMtok: 1.25, provider: SERVER_PROVIDER_P1, agents: null, ...extras('cmh_ai_model', IDS.m1) },
    { ...modelBase, id: IDS.m2, providerId: IDS.p1, code: 'gpt-5-mini', label: 'GPT 5 mini', contextWindow: 400000, active: true, lastSeenAt: '2026-10-07T08:00:00.000+00:00', thinking: true, toolCalling: null, priceInPerMtok: 0.25, provider: SERVER_PROVIDER_P1, agents: null, ...extras('cmh_ai_model', IDS.m2) },
  ],
  aggregations: { byProvider: { buckets: [{ key: IDS.p1, count: 2, apiAlias: 'aggregation_bucket' }, { key: IDS.p2, count: 1, apiAlias: 'aggregation_bucket' }], apiAlias: 'byProvider_aggregation' } },
};

/** POST /api/search/cmh-ai-mcp-server — tools 연관(name ASC) · count 집계 */
const SERVER_MCP_RESPONSE = {
  total: 1,
  data: [
    {
      id: IDS.s1, code: 'cmh-crawler', name: 'CMH Crawler', type: 'stdio', command: 'node', args: ['dist/index.js', '--port', 3000], url: null,
      envKeys: { PROXY: true }, active: true, gatewayManaged: false, description: null, createdAt: CREATED, updatedAt: null,
      tools: [
        { id: IDS.t1, serverId: IDS.s1, name: 'crawler_fetch_product', title: null, description: null, parameters: { type: 'object', properties: { url: { type: 'string' } } }, active: true, needsApproval: false, createdAt: CREATED, updatedAt: null, server: null, ...extras('cmh_ai_mcp_tool', IDS.t1) },
        { id: IDS.t2, serverId: IDS.s1, name: 'crawler_list_adapters', title: null, description: null, parameters: null, active: true, needsApproval: true, createdAt: CREATED, updatedAt: null, server: null, ...extras('cmh_ai_mcp_tool', IDS.t2) },
      ],
      serverSecrets: null, agentMcpServers: null, skillMcpServers: null, ...extras('cmh_ai_mcp_server', IDS.s1),
    },
  ],
  aggregations: { n: { count: 1, apiAlias: 'n_aggregation' } },
};

interface Call {
  path: string;
  body: unknown;
}
function fakeTransport(responses: Record<string, unknown>): { transport: AdminApiTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: AdminApiTransport = async (path, body) => {
    calls.push({ path, body: JSON.parse(JSON.stringify(body)) as unknown });
    if (!(path in responses)) return { status: 404, data: { errors: [{ status: '404', detail: `no fixture for ${path}` }] } };
    return { status: 200, data: responses[path] ?? null };
  };
  return { transport, calls };
}

let local: DataSource;
beforeEach(async () => {
  local = await seededLocal();
});
afterEach(async () => {
  await local.close();
});

describe('대조 — SqliteDriver ↔ AdminApiDriver(고정 응답)', () => {
  it('n:1 연관 · 필터 · 정렬 · total · terms 집계', async () => {
    const criteria = () =>
      new Criteria(1, 10)
        .addFilter(Criteria.equals('active', true))
        .addAssociation('provider')
        .addSorting(Criteria.sort('code', 'ASC'))
        .addAggregation(Criteria.terms('byProvider', 'providerId'));
    const fake = fakeTransport({ '/api/search/cmh-ai-model': SERVER_MODELS_RESPONSE });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });

    const a = await local.repository('cmh_ai_model').search(criteria());
    const b = await server.repository('cmh_ai_model').search(criteria());

    expect(fake.calls).toEqual([{ path: '/api/search/cmh-ai-model', body: criteria().parse() }]);
    expect(b.elements).toEqual(a.elements);
    expect(b.total).toBe(a.total);
    expect(b.aggregations).toEqual(a.aggregations);
    expect(a.elements.map((e) => e['code'])).toEqual(['gemma-4-e2b', 'gpt-5', 'gpt-5-mini']); // 빈 결과끼리 같은 것이 아님을 확인
  });

  it('1:n 연관 · JSON 칸 · count 집계', async () => {
    const criteria = () => {
      const c = new Criteria(1, 25).addAggregation(Criteria.count('n', 'id'));
      c.getAssociation('tools').addSorting(Criteria.sort('name', 'ASC'));
      return c;
    };
    const fake = fakeTransport({ '/api/search/cmh-ai-mcp-server': SERVER_MCP_RESPONSE });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });

    const a = await local.repository('cmh_ai_mcp_server').search(criteria());
    const b = await server.repository('cmh_ai_mcp_server').search(criteria());

    expect(fake.calls[0]?.body).toEqual(criteria().parse());
    expect(b.elements).toEqual(a.elements);
    expect(b.aggregations).toEqual(a.aggregations);
    expect((a.elements[0]?.['tools'] as unknown[]).length).toBe(2);
  });

  it('total-count-mode 0 → 둘 다 null', async () => {
    const c = () => new Criteria(1, 10).addFilter(Criteria.equals('active', true)).addAssociation('provider').addSorting(Criteria.sort('code')).setTotalCountMode(0);
    const fake = fakeTransport({ '/api/search/cmh-ai-model': { ...SERVER_MODELS_RESPONSE, aggregations: [] } });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });
    const a = await local.repository('cmh_ai_model').search(c());
    const b = await server.repository('cmh_ai_model').search(c());
    expect([a.total, b.total]).toEqual([null, null]);
    expect(b.elements).toEqual(a.elements);
  });

  it('같은 Criteria 오류는 둘 다 같은 예외 · 서버는 부르지도 않는다', async () => {
    const fake = fakeTransport({});
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });
    for (const c of [new Criteria().addFilter(Criteria.equals('nope', 1)), { filter: [{ type: 'fuzzy', field: 'code', value: 'x' }] }]) {
      await expect(local.repository('cmh_ai_model').search(c as Criteria)).rejects.toThrow(CriteriaError);
      await expect(server.repository('cmh_ai_model').search(c as Criteria)).rejects.toThrow(CriteriaError);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe('AdminApiDriver — 쓰기 · 오류', () => {
  it('upsert · delete = POST /api/_action/sync (camelCase 속성 · 없는 id 는 만든다)', async () => {
    const fake = fakeTransport({ '/api/_action/sync': {} });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport, registry: createDefaultRegistry() });
    const w = await server.repository('cmh_ai_mcp_server').upsert([{ code: 'x', name: 'X', type: 'stdio', env_keys: { A: true }, active: '0' as unknown as boolean }]);
    await server.repository('cmh_ai_mcp_server').delete([IDS.s1, IDS.s1]);
    expect(fake.calls).toEqual([
      { path: '/api/_action/sync', body: [{ action: 'upsert', entity: 'cmh_ai_mcp_server', payload: [{ code: 'x', name: 'X', type: 'stdio', envKeys: { A: true }, active: false, id: w.ids[0] }] }] },
      { path: '/api/_action/sync', body: [{ action: 'delete', entity: 'cmh_ai_mcp_server', payload: [{ id: IDS.s1 }] }] },
    ]);
  });

  it('비밀칸(apiAware false)은 기본으로 보내지 않는다 — allowSecretFields 로만', async () => {
    const fake = fakeTransport({ '/api/_action/sync': {} });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });
    await expect(server.repository('cmh_ai_provider').upsert([{ code: 'x', name: 'X', apiKeyEnc: 'ENC:v10:blob' }])).rejects.toThrow(/비밀칸 'apiKeyEnc'/);
    await expect(server.repository('cmh_ai_provider').upsert([{ id: IDS.p1, api_key_enc: 'ENC:v10:blob' }])).rejects.toThrow(DataWriteError);
    expect(fake.calls).toEqual([]);
    // null 로 지우는 것도 같은 칸이라 막는다(명시적 옵트인만)
    await expect(server.repository('cmh_ai_provider').upsert([{ id: IDS.p1, apiKeyEnc: null }])).rejects.toThrow(/비밀칸/);

    const optIn = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport, allowSecretFields: true });
    await optIn.repository('cmh_ai_provider').upsert([{ id: IDS.p1, apiKeyEnc: 'server-side-secret' }]);
    expect(fake.calls).toEqual([{ path: '/api/_action/sync', body: [{ action: 'upsert', entity: 'cmh_ai_provider', payload: [{ id: IDS.p1, apiKeyEnc: 'server-side-secret' }] }] }]);
  });

  it('id 없는 새 줄 — 로컬과 같은 필수 칸 검사(serverRequired 포함) · 서버는 부르지 않는다', async () => {
    const fake = fakeTransport({ '/api/_action/sync': {} });
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });
    await expect(server.repository('cmh_ai_mcp_server').upsert([{ code: 'x', name: 'X' }])).rejects.toThrow(/필수 칸 'type'/);
    await expect(local.repository('cmh_ai_mcp_server').upsert([{ code: 'x', name: 'X' }])).rejects.toThrow(/필수 칸 'type'/);
    await expect(server.repository('cmh_ai_provider').upsert([{ code: 'x' }])).rejects.toThrow(/필수 칸 'name'/);
    expect(fake.calls).toEqual([]);
    // id 를 주면 새 줄인지 모른다 → 서버에 맡긴다
    await server.repository('cmh_ai_mcp_server').upsert([{ id: IDS.s1, name: 'renamed' }]);
    expect(fake.calls).toHaveLength(1);
  });

  it('로그인 전(null) · 서버 오류 = AdminApiError', async () => {
    const none = await DataSourceFactory.create({ dataSource: 'server', transport: async () => null });
    await expect(none.repository('cmh_ai_model').search(new Criteria())).rejects.toThrow(/로그인 전/);
    const fake = fakeTransport({});
    const server = await DataSourceFactory.create({ dataSource: 'server', transport: fake.transport });
    await expect(server.repository('cmh_ai_model').search(new Criteria())).rejects.toThrow(AdminApiError);
    await expect(server.repository('cmh_ai_model').search(new Criteria())).rejects.toThrow(/404 — no fixture/);
  });
});
