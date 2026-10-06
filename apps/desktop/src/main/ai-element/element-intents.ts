// U10 5번 — 요소 «종류»별 AI 작업 목록(요소 하나하나가 아니라 종류에 정한다 · 9,617개에 하나씩 정하지 않는다). 순수 함수 · vitest.
import type { TabKind } from '@cmh-hub-app/contracts';

export type ElementIntentKey = 'suggest_value' | 'check_rules' | 'explain_field' | 'explain_button' | 'summarize_screen';

export interface ElementIntent {
  key: ElementIntentKey;
  /** 메뉴 글(한국어) */
  label: string;
}

/** readElementAtPoint 가 돌려주는 요소 요약 — 비밀번호 칸의 값은 절대 안 들어온다(read-element.ts 가 안 읽는다) */
export interface ElementInfo {
  /** 소문자 태그 — input · textarea · select · button · a · 그 밖 */
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  role: string | null;
  /** 연결된 label → aria-label → placeholder → 바로 앞 글 차례로 처음 찾은 것 */
  label: string | null;
  /** 단추 · 링크 · 그 밖의 글(200자) · 입력칸은 '' */
  text: string;
  /** 입력칸의 지금 값(200자) · select 는 고른 option 글 · 비밀번호 · 입력칸 아님 = null */
  value: string | null;
  /** [name=…] 하나뿐이면 그것 · #id · 아니면 짧은 경로 */
  selector: string;
}

export type ElementKind = 'field' | 'button' | 'other';

export const INTENTS: Readonly<Record<ElementIntentKey, ElementIntent>> = {
  suggest_value: { key: 'suggest_value', label: 'AI 값 제안' },
  check_rules: { key: 'check_rules', label: '네이버 규칙 검사' },
  explain_field: { key: 'explain_field', label: '이 칸 설명' },
  explain_button: { key: 'explain_button', label: '이 단추가 하는 일' },
  summarize_screen: { key: 'summarize_screen', label: '이 화면 요약' },
};

/** input 인데 단추로 쓰는 type */
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset']);
/** input 인데 값 제안 · 설명이 뜻 없는 type */
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'file']);

export function classifyElement(element: ElementInfo | null): ElementKind {
  if (!element) return 'other';
  const tag = element.tag.toLowerCase();
  const type = (element.type ?? '').toLowerCase();
  if (tag === 'input') {
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    return NON_FIELD_INPUT_TYPES.has(type) ? 'other' : 'field';
  }
  if (tag === 'textarea' || tag === 'select') return 'field';
  if (tag === 'button' || element.role === 'button') return 'button';
  return 'other';
}

/**
 * 종류별 작업 — 입력칸 = 값 제안 · (네이버만) 규칙 검사 · 설명 / 단추 = 이 단추가 하는 일 / 링크 · 그 밖 · 요소 없음 = 이 화면 요약.
 * 빈 탭(web)은 AI 작업이 없다. 비밀번호 칸은 값을 안 읽으므로 «설명»만.
 */
export function intentsFor(kind: TabKind, element: ElementInfo | null): ElementIntent[] {
  if (kind === 'web') return [];
  switch (classifyElement(element)) {
    case 'field': {
      if ((element?.type ?? '').toLowerCase() === 'password') return [INTENTS.explain_field];
      return kind === 'naver' ? [INTENTS.suggest_value, INTENTS.check_rules, INTENTS.explain_field] : [INTENTS.suggest_value, INTENTS.explain_field];
    }
    case 'button':
      return [INTENTS.explain_button];
    default:
      return [INTENTS.summarize_screen];
  }
}
