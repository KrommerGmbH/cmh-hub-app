import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Criteria } from '../../criteria.js';
import type { DataSource } from '../../repository.js';
import { codes, CREATED_AT, IDS, seededLocal } from '../../test-support/fixtures.js';
import { CriteriaError, DataWriteError } from '../types.js';

let ds: DataSource;
beforeEach(async () => {
  ds = await seededLocal();
});
afterEach(async () => {
  await ds.close();
});

const models = () => ds.repository('cmh_ai_model');
const providers = () => ds.repository('cmh_ai_provider');
const byCode = () => new Criteria().addSorting(Criteria.sort('code', 'ASC'));

describe('SqliteDriver filter 8종', () => {
  it('equals (bool · snake_case 칸 이름도 받는다)', async () => {
    const r = await providers().search(new Criteria().addFilter(Criteria.equals('active', true)).addSorting(Criteria.sort('code')));
    expect(codes(r.elements)).toEqual(['local-gguf', 'openai']);
    const s = await models().search(byCode().addFilter(Criteria.equals('provider_id', IDS.p2)));
    expect(codes(s.elements)).toEqual(['gemma-4-e2b', 'qwen3.5-0.8b']);
  });

  it('equals null = IS NULL', async () => {
    const r = await models().search(byCode().addFilter(Criteria.equals('priceInPerMtok', null)));
    expect(codes(r.elements)).toEqual(['gemma-4-e2b']);
  });

  it('equalsAny (SDK 는 값을 | 로 잇는다)', async () => {
    const c = byCode().addFilter(Criteria.equalsAny('code', ['gpt-5', 'legacy']));
    expect(c.parse().filter?.[0]).toEqual({ type: 'equalsAny', field: 'code', value: 'gpt-5|legacy' });
    expect(codes((await models().search(c)).elements)).toEqual(['gpt-5', 'legacy']);
  });

  it('contains · prefix · suffix', async () => {
    expect(codes((await models().search(byCode().addFilter(Criteria.contains('code', 'gpt')))).elements)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(codes((await models().search(byCode().addFilter(Criteria.prefix('code', 'gpt-5-')))).elements)).toEqual(['gpt-5-mini']);
    expect(codes((await models().search(byCode().addFilter(Criteria.suffix('code', 'b')))).elements)).toEqual(['gemma-4-e2b', 'qwen3.5-0.8b']);
  });

  it('LIKE 특수문자(% _)는 글자 그대로', async () => {
    expect(codes((await providers().search(byCode().addFilter(Criteria.contains('name', '100%')))).elements)).toEqual(['old_provider']);
    expect(codes((await providers().search(byCode().addFilter(Criteria.contains('code', '_')))).elements)).toEqual(['old_provider']);
  });

  it('range gt · gte · lt · lte (수 · 글자로 온 수 · 날짜시각)', async () => {
    const a = byCode().addFilter(Criteria.range('contextWindow', { gte: '128000', lt: '400001' }));
    expect(codes((await models().search(a)).elements)).toEqual(['gemma-4-e2b', 'gpt-5', 'gpt-5-mini']);
    const b = byCode().addFilter({ type: 'range', field: 'priceInPerMtok', parameters: { gt: 0, lte: 1.25 } } as never);
    expect(codes((await models().search(b)).elements)).toEqual(['gpt-5', 'gpt-5-mini']);
    const d = byCode().addFilter(Criteria.range('lastSeenAt', { gt: '2026-10-07T00:00:00+00:00' }));
    expect(codes((await models().search(d)).elements)).toEqual(['gpt-5-mini']);
  });

  it('equalsAny 빈 배열 · [null] — 지금 동작 고정(서버 실측 전)', async () => {
    // SDK 는 빈 배열을 '' 로 잇는다 → 값 0개 → 0건(SQL 은 0 = 1). 서버가 같은 값에 무엇을 주는지는 실측 안 함
    const empty = Criteria.equalsAny('code', []);
    expect(empty).toEqual({ type: 'equalsAny', field: 'code', value: '' });
    expect((await models().search(byCode().addFilter(empty))).elements).toEqual([]);
    expect((await models().search({ filter: [{ type: 'equalsAny', field: 'code', value: [] }] } as never)).elements).toEqual([]);
    // 배열 [null] = IS NULL · SDK 꼴(null 을 '|' 로 이으면 '' → 0건)과 다르다
    const onlyNull = await models().search({ filter: [{ type: 'equalsAny', field: 'priceInPerMtok', value: [null] }], sort: [{ field: 'code', order: 'ASC' }] } as never);
    expect(codes(onlyNull.elements)).toEqual(['gemma-4-e2b']);
    expect(Criteria.equalsAny('code', [null])).toEqual({ type: 'equalsAny', field: 'code', value: '' });
  });

  it("range/equals datetime — 'YYYY-MM-DD HH:mm:ss' 는 UTC 로 읽는다 (TZ=Asia/Seoul)", async () => {
    const saved = process.env['TZ'];
    process.env['TZ'] = 'Asia/Seoul';
    try {
      // Node 는 TZ 를 바꾸면 바로 쓴다 — 정말 바뀌었는지부터(안 바뀌면 이 시험은 아무것도 증명하지 않는다)
      expect(new Date(2026, 9, 7).getTimezoneOffset()).toBe(-540);
      // 쓰기: 시간대 없는 Shopware 저장 꼴 → UTC 그대로(KST 로 읽었다면 2026-10-06T15:30Z)
      await providers().upsert([{ id: IDS.p2, usedMinuteAt: '2026-10-07 00:30:00', usedTodayDate: '2026-10-07 01:00:00' }]);
      expect(await providers().get(IDS.p2)).toMatchObject({ usedMinuteAt: '2026-10-07T00:30:00.000Z', usedTodayDate: '2026-10-07' });
      // 거르기: p1.usedMinuteAt = 2026-10-07T10:34:56Z(고정 자료 '12:34:56+02:00')
      const eq = await providers().search(byCode().addFilter(Criteria.equals('usedMinuteAt', '2026-10-07 10:34:56')));
      expect(codes(eq.elements)).toEqual(['openai']);
      const eqT = await providers().search(byCode().addFilter(Criteria.equals('usedMinuteAt', '2026-10-07T10:34:56.000')));
      expect(codes(eqT.elements)).toEqual(['openai']);
      const lt = await providers().search(byCode().addFilter(Criteria.range('usedMinuteAt', { lt: '2026-10-07 00:30:00.001' })));
      expect(codes(lt.elements)).toEqual(['local-gguf']);
      // 날짜만 = UTC 자정
      const day = await providers().search(byCode().addFilter(Criteria.range('usedMinuteAt', { gte: '2026-10-07', lt: '2026-10-08' })));
      expect(codes(day.elements)).toEqual(['local-gguf', 'openai']);
      // 시간대가 붙은 값은 그 시간대대로(바뀌지 않음)
      const zoned = await providers().search(byCode().addFilter(Criteria.equals('usedMinuteAt', '2026-10-07T19:34:56+09:00')));
      expect(codes(zoned.elements)).toEqual(['openai']);
    } finally {
      if (saved === undefined) delete process.env['TZ'];
      else process.env['TZ'] = saved;
    }
  });

  it('not(and)', async () => {
    const r = await models().search(byCode().addFilter(Criteria.not('and', [Criteria.equals('active', true)])));
    expect(codes(r.elements)).toEqual(['legacy', 'qwen3.5-0.8b']);
  });

  it('multi(or)', async () => {
    const c = byCode().addFilter(Criteria.multi('or', [Criteria.equals('providerId', IDS.p2), Criteria.range('priceInPerMtok', { gt: '2' })]));
    expect(codes((await models().search(c)).elements)).toEqual(['gemma-4-e2b', 'legacy', 'qwen3.5-0.8b']);
  });

  it('not · multi 중첩', async () => {
    const c = byCode().addFilter(
      Criteria.multi('AND', [
        Criteria.equals('active', true),
        Criteria.not('or', [Criteria.prefix('code', 'gpt-5-'), Criteria.equals('thinking', false)]),
      ]),
    );
    expect(codes((await models().search(c)).elements)).toEqual(['gpt-5']);
  });

  it('연관 칸 경로 — n:1 (provider.freeTier) · 1:n (models.code)', async () => {
    expect(codes((await models().search(byCode().addFilter(Criteria.equals('provider.freeTier', true)))).elements)).toEqual(['gemma-4-e2b', 'qwen3.5-0.8b']);
    expect(codes((await providers().search(byCode().addFilter(Criteria.equals('models.code', 'legacy')))).elements)).toEqual(['old_provider']);
  });
});

describe('SqliteDriver sort · page · total', () => {
  it('두 칸 정렬', async () => {
    const c = new Criteria().addSorting(Criteria.sort('active', 'DESC')).addSorting(Criteria.sort('code', 'ASC'));
    expect(codes((await models().search(c)).elements)).toEqual(['gemma-4-e2b', 'gpt-5', 'gpt-5-mini', 'legacy', 'qwen3.5-0.8b']);
  });

  it('page/limit', async () => {
    const c = new Criteria(2, 2).addSorting(Criteria.sort('code', 'ASC'));
    const r = await models().search(c);
    expect(codes(r.elements)).toEqual(['gpt-5-mini', 'legacy']);
    expect(r.total).toBe(5);
  });

  it('total-count-mode 0 = 안 셈(null) · 1 · 2 = 셈', async () => {
    const make = (mode: 0 | 1 | 2) => new Criteria(1, 2).addSorting(Criteria.sort('code')).setTotalCountMode(mode);
    expect((await models().search(make(0))).total).toBeNull();
    expect((await models().search(make(1))).total).toBe(5);
    expect((await models().search(make(2))).total).toBe(5);
    expect((await models().search(make(1).addFilter(Criteria.equals('active', false)))).total).toBe(2);
  });

  it('naturalSorting: true = 예외(SQLite 에 자연 정렬이 없다 · 조용히 무시 0) · false 는 보통 정렬', async () => {
    await expect(models().search(new Criteria().addSorting(Criteria.naturalSorting('code')))).rejects.toThrow(/naturalSorting/);
    await expect(models().search(new Criteria().addSorting(Criteria.sort('code', 'ASC', true)))).rejects.toThrow(CriteriaError);
    expect(codes((await models().search(new Criteria().addSorting(Criteria.sort('code', 'ASC', false)))).elements)).toEqual(['gemma-4-e2b', 'gpt-5', 'gpt-5-mini', 'legacy', 'qwen3.5-0.8b']);
  });

  it('searchIds · get', async () => {
    const r = await models().searchIds(byCode().addFilter(Criteria.equals('providerId', IDS.p1)));
    expect(r).toEqual({ total: 2, ids: [IDS.m1, IDS.m2] });
    const one = await models().get(IDS.m3);
    expect(one?.['code']).toBe('gemma-4-e2b');
    expect(await models().get('f'.repeat(32))).toBeNull();
  });
});

describe('SqliteDriver association', () => {
  it('manyToOne — 두 번째 SELECT 로 채움 · 비밀칸 없음', async () => {
    const r = await models().search(byCode().addFilter(Criteria.equalsAny('code', ['gpt-5', 'legacy'])).addAssociation('provider'));
    const [gpt, legacy] = r.elements;
    expect((gpt?.['provider'] as Record<string, unknown>)['code']).toBe('openai');
    expect((legacy?.['provider'] as Record<string, unknown>)['code']).toBe('old_provider');
    expect(gpt?.['provider']).not.toHaveProperty('apiKeyEnc');
  });

  it('oneToMany — 부모 id 로 한 번 · 연관 정렬 · 부모마다 limit · 연관 filter', async () => {
    const c = byCode();
    c.getAssociation('models').addSorting(Criteria.sort('code', 'DESC')).setLimit(1);
    const r = await providers().search(c);
    const m = Object.fromEntries(r.elements.map((p) => [p['code'], codes(p['models'] as Record<string, unknown>[])]));
    expect(m).toEqual({ 'local-gguf': ['qwen3.5-0.8b'], old_provider: ['legacy'], openai: ['gpt-5-mini'] });

    const f = byCode();
    f.getAssociation('models').addFilter(Criteria.equals('active', true));
    const r2 = await providers().search(f);
    expect(r2.elements.find((p) => p['code'] === 'old_provider')?.['models']).toEqual([]);
  });

  it('oneToMany 부모 501개 묶음 경계 — 500 + 1 로 나눠 읽어도 부모마다 자기 자식만(지금 동작 고정)', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ code: `bulk-${String(i).padStart(4, '0')}`, name: 'n' }));
    const { ids } = await providers().upsert(rows);
    await models().upsert(ids.map((providerId, i) => ({ providerId, code: `m${i}` })));
    const r = await providers().search(new Criteria(1, 1000).addFilter(Criteria.prefix('code', 'bulk-')).addSorting(Criteria.sort('code')).addAssociation('models'));
    expect(r.elements).toHaveLength(501);
    const wrong = r.elements.filter((p, i) => codes(p['models'] as Record<string, unknown>[]).join() !== `m${i}`);
    expect(wrong).toEqual([]);
    // 경계 양쪽(500번째 · 501번째 부모)
    expect(codes(r.elements[499]?.['models'] as Record<string, unknown>[])).toEqual(['m499']);
    expect(codes(r.elements[500]?.['models'] as Record<string, unknown>[])).toEqual(['m500']);
  });

  it('겹친 연관 — conversation.messages(seq 차례) · message.conversation', async () => {
    const c = new Criteria();
    c.getAssociation('messages').addSorting(Criteria.sort('seq', 'ASC'));
    const [conv] = (await ds.repository('cmh_ai_conversation').search(c)).elements;
    const msgs = conv?.['messages'] as Record<string, unknown>[];
    expect(msgs.map((m) => m['seq'])).toEqual([1, 2, 3]);
    expect(msgs[0]?.['attachments']).toEqual([{ kind: 'tab', viewId: 'v1' }]);
    const back = await ds.repository('cmh_ai_conversation_message').search(
      new Criteria().addFilter(Criteria.equals('seq', 3)).addAssociation('conversation.messages'),
    );
    const conv2 = back.elements[0]?.['conversation'] as Record<string, unknown>;
    expect(conv2['title']).toBe('첫 대화');
    expect((conv2['messages'] as unknown[]).length).toBe(3);
  });
});

describe('SqliteDriver aggregation 6종', () => {
  it('count · sum · avg · min · max · terms', async () => {
    const c = new Criteria()
      .addAggregation(Criteria.count('n', 'id'))
      .addAggregation(Criteria.count('providers', 'providerId'))
      .addAggregation(Criteria.sum('ctx', 'contextWindow'))
      .addAggregation(Criteria.avg('price', 'priceInPerMtok'))
      .addAggregation(Criteria.min('minCtx', 'contextWindow'))
      .addAggregation(Criteria.max('lastSeen', 'lastSeenAt'))
      .addAggregation(Criteria.terms('byProvider', 'providerId'))
      .addAggregation(Criteria.terms('top', 'providerId', 1, Criteria.sort('_count', 'DESC')));
    const a = await models().aggregate(c);
    expect(a).toEqual({
      n: { count: 5 },
      providers: { count: 3 },
      ctx: { sum: 968000 },
      price: { avg: 1 },
      minCtx: { min: 8000 },
      lastSeen: { max: '2026-10-07T08:00:00.000Z' },
      byProvider: { buckets: [{ key: IDS.p1, count: 2 }, { key: IDS.p2, count: 2 }, { key: IDS.p3, count: 1 }] },
      top: { buckets: [{ key: IDS.p1, count: 2 }] },
    });
  });

  it('filter 는 집계에 들고 post-filter 는 문서만', async () => {
    const c = new Criteria().addFilter(Criteria.equals('active', true)).addPostFilter(Criteria.equals('providerId', IDS.p1)).addAggregation(Criteria.count('n', 'id'));
    const r = await models().search(c);
    expect(r.elements.length).toBe(2);
    expect(r.aggregations).toEqual({ n: { count: 3 } });
  });
});

describe('SqliteDriver 예외(조용히 무시 0)', () => {
  it('모르는 filter type', async () => {
    await expect(models().search({ filter: [{ type: 'fuzzy', field: 'code', value: 'x' }] } as never)).rejects.toThrow(CriteriaError);
  });
  it('정의에 없는 칸 · 연관 · 키', async () => {
    await expect(models().search(new Criteria().addFilter(Criteria.equals('nope', 1)))).rejects.toThrow(/정의에 없는 칸 'nope'/);
    await expect(models().search(new Criteria().addSorting(Criteria.sort('nope')))).rejects.toThrow(CriteriaError);
    await expect(models().search(new Criteria().addAssociation('agents'))).rejects.toThrow(/정의에 없는 연관 'agents'/);
    await expect(models().search(new Criteria().addFilter(Criteria.equals('provider.nope', 1)))).rejects.toThrow(CriteriaError);
    await expect(models().search({ unknownKey: 1 } as never)).rejects.toThrow(/모르는 키/);
    await expect(models().search(new Criteria().setTerm('gpt'))).rejects.toThrow(/term/);
    await expect(models().aggregate(new Criteria().addAggregation(Criteria.stats('s', 'contextWindow')))).rejects.toThrow(/모르는 aggregation/);
  });
  it('값 · 종류가 안 맞으면', async () => {
    await expect(models().search(new Criteria().addFilter(Criteria.equals('contextWindow', 'many')))).rejects.toThrow(CriteriaError);
    await expect(models().search(new Criteria().addFilter(Criteria.contains('active', '1')))).rejects.toThrow(CriteriaError);
    await expect(models().aggregate(new Criteria().addAggregation(Criteria.sum('s', 'code')))).rejects.toThrow(CriteriaError);
  });
  it('비밀칸 — api 범위는 거르기 · 응답 모두 막고 system 은 연다', async () => {
    const p = await providers().get(IDS.p1);
    expect(p).not.toHaveProperty('apiKeyEnc');
    await expect(providers().search(new Criteria().addFilter(Criteria.equals('apiKeyEnc', 'x')))).rejects.toThrow(/비밀칸/);
    const sys = await providers().get(IDS.p1, undefined, { scope: 'system' });
    expect(sys?.['apiKeyEnc']).toBe('ENC:v10:secret-blob');
  });
});

describe('SqliteDriver 값 왕복 · 쓰기', () => {
  it('JSON · bool · datetime · date 왕복', async () => {
    const p = await providers().get(IDS.p1);
    expect(p).toMatchObject({ active: true, freeTier: false, usedTodayDate: '2026-10-07', usedMinuteAt: '2026-10-07T10:34:56.000Z', createdAt: CREATED_AT, updatedAt: null });
    const s = await ds.repository('cmh_ai_mcp_server').get(IDS.s1);
    expect(s).toMatchObject({ args: ['dist/index.js', '--port', 3000], envKeys: { PROXY: true }, active: true, gatewayManaged: false, type: 'stdio' });
    const tool = await ds.repository('cmh_ai_mcp_tool').get(IDS.t1);
    expect(tool?.['parameters']).toEqual({ type: 'object', properties: { url: { type: 'string' } } });
  });

  it('서버 기본값(NOT NULL DEFAULT)이 그대로 든다', async () => {
    const conv = await ds.repository('cmh_ai_conversation').get(IDS.c1);
    expect(conv).toMatchObject({ agentVersionId: '0fa91ce3e96a4bc2be4bd9ce752c3425', counterpartType: 'user', status: 'active', summaryUptoSeq: 0, tokenTotal: 0, userId: null });
  });

  it('upsert — 있는 id 는 준 칸만 · 없는 id 는 새로 · id 없으면 만든다', async () => {
    const w = await providers().upsert([{ id: IDS.p2, name: 'Local GGUF 2' }, { code: 'new', name: 'New' }]);
    expect(w.ids[0]).toBe(IDS.p2);
    expect(w.ids[1]).toMatch(/^[0-9a-f]{32}$/);
    const p2 = await providers().get(IDS.p2);
    expect(p2).toMatchObject({ name: 'Local GGUF 2', code: 'local-gguf', freeTier: true, createdAt: CREATED_AT });
    expect(typeof p2?.['updatedAt']).toBe('string');
    const created = await providers().get(w.ids[1] as string);
    expect(created).toMatchObject({ code: 'new', kind: 'local', active: true, rpmHeadroom: 3, updatedAt: null });
  });

  it('upsert 예외 — 필수 칸 없음 · 정의에 없는 칸 · 연관 쓰기 · 나쁜 id', async () => {
    await expect(providers().upsert([{ code: 'x' }])).rejects.toThrow(/필수 칸 'name'/);
    await expect(providers().upsert([{ code: 'x', name: 'x', nope: 1 }])).rejects.toThrow(DataWriteError);
    await expect(providers().upsert([{ code: 'x', name: 'x', models: [] }])).rejects.toThrow(/연관/);
    await expect(providers().upsert([{ id: 'not-an-id', code: 'x', name: 'x' }])).rejects.toThrow(DataWriteError);
    await expect(providers().upsert([{ id: IDS.p1, code: 'local-gguf' }])).rejects.toThrow(/UNIQUE/);
  });

  it('upsert 새 줄 — 서버 DAL Required 칸(serverRequired)은 DEFAULT 가 있어도 요구한다', async () => {
    await expect(ds.repository('cmh_ai_mcp_server').upsert([{ code: 'n', name: 'N' }])).rejects.toThrow(/필수 칸 'type'/);
    await expect(ds.repository('cmh_ai_conversation').upsert([{ agentId: IDS.agent }])).rejects.toThrow(/필수 칸 'counterpartType'/);
    // 있는 줄을 고칠 때는 안 줘도 된다 · DEFAULT 만 있고 서버도 안 요구하는 칸(agentVersionId · status …)은 그대로 기본값
    await ds.repository('cmh_ai_mcp_server').upsert([{ id: IDS.s1, name: 'renamed' }]);
    const { ids } = await ds.repository('cmh_ai_conversation').upsert([{ agentId: IDS.agent, counterpartType: 'customer' }]);
    expect(await ds.repository('cmh_ai_conversation').get(ids[0] as string)).toMatchObject({ counterpartType: 'customer', agentVersionId: '0fa91ce3e96a4bc2be4bd9ce752c3425', status: 'active' });
  });

  it('delete — FK ON DELETE CASCADE 로 자식도', async () => {
    const d = await providers().delete([IDS.p1, 'e'.repeat(32)]);
    expect(d.ids).toEqual([IDS.p1]);
    expect(codes((await models().search(byCode())).elements)).toEqual(['gemma-4-e2b', 'legacy', 'qwen3.5-0.8b']);
  });
});
