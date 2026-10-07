import { describe, expect, it } from 'vitest';
import { Criteria } from './criteria.js';

describe('Criteria — meteor-admin-sdk 6.15.0 그대로(UMD 판 · createRequire)', () => {
  it('parse() 가 SDK 원본 꼴(2026-10-07 메인 실측 JSON)과 같다', () => {
    const c = new Criteria(1, 25);
    c.addFilter(Criteria.equals('active', true));
    c.addAssociation('provider');
    c.addSorting(Criteria.sort('name', 'ASC'));
    expect(JSON.stringify(c.parse())).toBe(
      '{"page":1,"limit":25,"filter":[{"type":"equals","field":"active","value":true}],"sort":[{"field":"name","order":"ASC","naturalSorting":false}],"associations":{"provider":{"total-count-mode":1}},"total-count-mode":1}',
    );
  });

  it('정적 메서드 · 연관 criteria', () => {
    const c = new Criteria();
    c.getAssociation('models').addFilter(Criteria.equals('active', true)).setLimit(5);
    c.addAggregation(Criteria.terms('t', 'kind', 5));
    expect(c.parse()).toEqual({
      page: 1,
      aggregations: [{ type: 'terms', name: 't', field: 'kind', limit: 5, sort: null, aggregation: null }],
      associations: { models: { limit: 5, filter: [{ type: 'equals', field: 'active', value: true }], 'total-count-mode': 1 } },
      'total-count-mode': 1,
    });
  });
});
