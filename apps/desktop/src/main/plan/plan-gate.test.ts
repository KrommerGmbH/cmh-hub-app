import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_FEATURES, PLAN_FEATURES, PlanGate, type PlanFeature } from './plan-gate.js';

describe('PlanGate (R9 · 임시 결정 ⏸ ⑫⑭)', () => {
  it('free 기본 표: localData · localModels · flowRunShared 만 true', () => {
    const gate = new PlanGate({ plan: 'free' });
    const on = PLAN_FEATURES.filter((f) => gate.can(f));
    expect(on.sort()).toEqual(['flowRunShared', 'localData', 'localModels']);
    expect(gate.can('flowEdit')).toBe(false);
  });

  it.each(['premium', 'staff'] as const)('%s 기본 표: 전부 true', (plan) => {
    const gate = new PlanGate({ plan });
    for (const f of PLAN_FEATURES) expect(gate.can(f)).toBe(true);
  });

  it('기본 표는 모든 plan 에 모든 기능 키가 있다', () => {
    for (const map of Object.values(DEFAULT_PLAN_FEATURES)) {
      expect(Object.keys(map).sort()).toEqual([...PLAN_FEATURES].sort());
    }
  });

  it('서버 features 가 기본 표를 이긴다(켜기 · 끄기 둘 다) · 안 준 키는 기본 표', () => {
    const free = PlanGate.fromLoginResponse({ plan: 'free', features: { serverData: true, localModels: false } });
    expect(free.can('serverData')).toBe(true);
    expect(free.can('localModels')).toBe(false);
    expect(free.can('localData')).toBe(true);
    expect(free.can('multiUser')).toBe(false);
    const premium = PlanGate.fromLoginResponse({ plan: 'premium', features: { multiUser: false } });
    expect(premium.can('multiUser')).toBe(false);
    expect(premium.can('serverModels')).toBe(true);
  });

  it('PLAN R9 본보기 응답 · features 없음 · 서버의 모르는 기능 키는 건너뛴다', () => {
    const gate = PlanGate.fromLoginResponse({ plan: 'free', features: { multiUser: false, serverData: false, serverModels: false } });
    expect(gate.plan).toBe('free');
    expect(gate.snapshot()).toEqual(DEFAULT_PLAN_FEATURES.free);
    expect(PlanGate.fromLoginResponse({ plan: 'staff' }).can('flowEdit')).toBe(true);
    expect(PlanGate.fromLoginResponse({ plan: 'free', features: { mobileApp: true } }).snapshot()).toEqual(DEFAULT_PLAN_FEATURES.free);
  });

  it.each<[string, unknown]>([
    ['모르는 plan', { plan: 'enterprise' }],
    ['plan 없음', { features: {} }],
    ['plan 대소문자 다름', { plan: 'Free' }],
    ['객체 아님', 'free'],
    ['null', null],
    ['features 가 배열', { plan: 'free', features: [] }],
    ['feature 값이 불리언 아님', { plan: 'free', features: { serverData: 'yes' } }],
  ])('%s → 예외', (_label, raw) => {
    expect(() => PlanGate.fromLoginResponse(raw)).toThrow(/plan gate/);
  });

  it('생성자에 모르는 plan · can 에 모르는 기능 → 예외', () => {
    expect(() => new PlanGate({ plan: 'gold' as never })).toThrow(/unknown plan/);
    expect(() => new PlanGate({ plan: 'free' }).can('teleport' as PlanFeature)).toThrow(/unknown feature/);
  });
});
