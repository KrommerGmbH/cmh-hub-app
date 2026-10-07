// R1 — Criteria 는 @shopware-ag/meteor-admin-sdk 6.15.0 의 것을 그대로 쓴다(합의안 3 · 두 벌 금지 · 2026-10-07).
// ESM 판(es/data/Criteria.js)은 Node ESM 에서 깨진다(`lodash-es/cloneDeep` 확장자 없는 import · 2026-10-07 실측)
// → exports 의 require 조건(umd/data/Criteria.js)을 createRequire 로 읽는다. 타입은 es/data/Criteria.d.ts.
import { createRequire } from 'node:module';
import type * as SdkCriteriaModule from '@shopware-ag/meteor-admin-sdk/es/data/Criteria';

// 이 패키지는 "type": "module" 이 없어 d.ts 가 CJS 로 읽힌다 → ESM 쪽에서 본 default 는 module.exports 이고 클래스는 그 안의 .default
type CriteriaClass = typeof SdkCriteriaModule.default.default;

const requireCjs = createRequire(import.meta.url);
const sdkModule = requireCjs('@shopware-ag/meteor-admin-sdk/es/data/Criteria') as { default: CriteriaClass };

export const Criteria: CriteriaClass = sdkModule.default;
export type Criteria = InstanceType<CriteriaClass>;

// SDK 가 내보내지 않는 안쪽 타입을 Criteria 에서 꺼낸다(이름은 SDK d.ts 와 같다)
export type CriteriaRequestParams = ReturnType<Criteria['parse']>;
export type SingleFilter = Criteria['filters'][number];
export type Aggregation = Criteria['aggregations'][number];
export type Sorting = Criteria['sortings'][number];

/** Shopware TotalCountMode — SDK 는 `const enum` 이라 값을 따로 둔다(es/data/Criteria.d.ts:1-5) */
export const TOTAL_COUNT_MODE = { none: 0, exact: 1, nextPages: 2 } as const;
