// R9 — PlanGate. 로그인(H02 설치 등록) 응답의 plan · features 로 기능별 허용을 정한다. electron 을 import 하지 않는 순수 모듈.
// 원칙 7(코드에 등급 박음 최소): 서버가 features 를 주면 서버 값이 이긴다. 아래 기본 표는 서버가 값을 안 줄 때만 쓴다.
// 【AI 임시 결정 ⏸ ⑫⑭ · 사장님 확인】
//  - plan 값 free · premium · staff(PLAN ⏸ 20번) · 무료 사용자 서버 계정 필요 여부(⑫) 미정.
//  - flowEdit 는 무료 false(⑭ 임시안 «무료 = 서버 공용 흐름 실행만 · 편집은 유료») → flowRunShared 만 true.

export const PLANS = ['free', 'premium', 'staff'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_FEATURES = [
  'multiUser',
  'serverData',
  'serverModels',
  'localModels',
  'localData',
  'flowEdit',
  'flowRunShared',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export type PlanFeatureMap = Readonly<Record<PlanFeature, boolean>>;

/** 로그인 응답 일부(서버가 정한다) */
export interface PlanLoginPayload {
  readonly plan: Plan;
  readonly features?: Readonly<Partial<Record<PlanFeature, boolean>>>;
}

const ALL_ON: PlanFeatureMap = {
  multiUser: true,
  serverData: true,
  serverModels: true,
  localModels: true,
  localData: true,
  flowEdit: true,
  flowRunShared: true,
};

/** 기본 표 — 서버가 features 를 안 줄 때만. free = 이 PC 의 로컬 자료 · 로컬 모델 · 서버 공용 흐름 실행 */
export const DEFAULT_PLAN_FEATURES: Readonly<Record<Plan, PlanFeatureMap>> = {
  free: {
    multiUser: false,
    serverData: false,
    serverModels: false,
    localModels: true,
    localData: true,
    flowEdit: false,
    flowRunShared: true,
  },
  premium: ALL_ON,
  staff: ALL_ON,
};

function isPlan(value: unknown): value is Plan {
  return (PLANS as readonly unknown[]).includes(value);
}

function isPlanFeature(value: string): value is PlanFeature {
  return (PLAN_FEATURES as readonly string[]).includes(value);
}

/** 서버가 앱이 모르는 plan 을 보냈을 때(검수 권고: 예외 대신 경고 · free 기본 표 + 서버 features) */
export interface PlanGateWarning {
  readonly code: 'unknownPlan';
  /** 받은 값이 글자면 그 글자(64자까지) · 아니면 typeof */
  readonly received: string;
}

export interface PlanGateOptions {
  readonly onWarning?: (warning: PlanGateWarning) => void;
}

/** 모르는 plan 은 free 로 — 가장 좁은 기본 표에서 시작하고 서버 features 가 덮어쓴다 */
export const UNKNOWN_PLAN_FALLBACK: Plan = 'free';

function describeReceived(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 64) : typeof value;
}

export class PlanGate {
  readonly plan: Plan;
  /** 서버가 보낸 plan 이 모르는 값이었으면 true(plan 은 free 로 맞춘 것) */
  readonly planWasUnknown: boolean;
  private readonly features: PlanFeatureMap;

  /**
   * payload.plan 은 타입상 Plan 이지만 서버 값이 그대로 올 수 있다 — 모르는 값이면 예외 대신 onWarning 을 부르고
   * free 기본 표 위에 서버 features 를 덮어쓴다(서버가 새 등급을 더해도 앱이 죽지 않게 · 원칙 7 서버 값이 이긴다).
   */
  constructor(payload: PlanLoginPayload, options: PlanGateOptions = {}) {
    const rawPlan: unknown = payload.plan;
    if (isPlan(rawPlan)) {
      this.plan = rawPlan;
      this.planWasUnknown = false;
    } else {
      this.plan = UNKNOWN_PLAN_FALLBACK;
      this.planWasUnknown = true;
      options.onWarning?.({ code: 'unknownPlan', received: describeReceived(rawPlan) });
    }
    const merged: Record<PlanFeature, boolean> = { ...DEFAULT_PLAN_FEATURES[this.plan] };
    for (const [key, value] of Object.entries(payload.features ?? {})) {
      // 서버가 새 기능 키를 더해도 앱이 죽지 않게 모르는 키는 건너뛴다(앱이 묻지 않는 기능이다)
      if (!isPlanFeature(key)) continue;
      if (typeof value !== 'boolean') throw new Error(`plan gate: feature "${key}" must be boolean`);
      merged[key] = value;
    }
    this.features = merged;
  }

  /** 로그인 응답 JSON(모양 모름)에서 만든다. 객체가 아니거나 features 가 객체가 아니면 예외 · plan 이 없거나 모르는 값이면 경고 + free */
  static fromLoginResponse(raw: unknown, options: PlanGateOptions = {}): PlanGate {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plan gate: response must be an object');
    const plan = (raw as { plan?: unknown }).plan as Plan;
    const features = (raw as { features?: unknown }).features;
    if (features === undefined || features === null) return new PlanGate({ plan }, options);
    if (typeof features !== 'object' || Array.isArray(features)) throw new Error('plan gate: features must be an object');
    return new PlanGate({ plan, features: features as Partial<Record<PlanFeature, boolean>> }, options);
  }

  can(feature: PlanFeature): boolean {
    if (!isPlanFeature(feature)) throw new Error(`plan gate: unknown feature ${JSON.stringify(feature)}`);
    return this.features[feature];
  }

  /** 설정 화면 · 로그용 사본 */
  snapshot(): PlanFeatureMap {
    return { ...this.features };
  }
}
