import { describe, expect, it } from 'vitest';
import type { TabKind } from '@cmh-hub-app/contracts';
import { INTENTS, classifyElement, intentsFor, type ElementInfo } from './element-intents.js';
import { matchScreen, type ScreenRecord } from './element-lookup.js';
import { buildHandoffMessage } from './chat-handoff.js';
import { MASK_PHONE } from './mask.js';

const el = (patch: Partial<ElementInfo>): ElementInfo => ({ tag: 'div', type: null, name: null, id: null, role: null, label: null, text: '', value: null, selector: 'div', ...patch });
const keys = (kind: TabKind, element: ElementInfo | null): string[] => intentsFor(kind, element).map((i) => i.key);

describe('요소 종류별 AI 작업(U10 5번 — 종류 5개에 정한다)', () => {
  it('네이버 입력칸: 값 제안 · 규칙 검사 · 설명', () => {
    expect(keys('naver', el({ tag: 'input', type: 'tel' }))).toEqual(['suggest_value', 'check_rules', 'explain_field']);
    expect(keys('naver', el({ tag: 'textarea' }))).toEqual(['suggest_value', 'check_rules', 'explain_field']);
    expect(keys('naver', el({ tag: 'select' }))).toEqual(['suggest_value', 'check_rules', 'explain_field']);
  });

  it('어드민 입력칸: 네이버 규칙 검사는 없다', () => {
    expect(keys('admin', el({ tag: 'input', type: 'text' }))).toEqual(['suggest_value', 'explain_field']);
  });

  it('단추 — button · input[type=submit] · role=button: 이 단추가 하는 일', () => {
    expect(classifyElement(el({ tag: 'button' }))).toBe('button');
    expect(keys('naver', el({ tag: 'input', type: 'submit' }))).toEqual(['explain_button']);
    expect(keys('admin', el({ tag: 'div', role: 'button' }))).toEqual(['explain_button']);
  });

  it('링크 · 그 밖 · 요소 못 읽음(iframe 안) · hidden: 이 화면 요약', () => {
    expect(keys('naver', el({ tag: 'a' }))).toEqual(['summarize_screen']);
    expect(keys('naver', el({ tag: 'span' }))).toEqual(['summarize_screen']);
    expect(keys('naver', null)).toEqual(['summarize_screen']);
    expect(keys('admin', el({ tag: 'input', type: 'hidden' }))).toEqual(['summarize_screen']);
  });

  it('비밀번호 칸: 값을 안 읽으므로 설명만', () => {
    expect(keys('admin', el({ tag: 'input', type: 'password' }))).toEqual(['explain_field']);
  });

  it('빈 탭(web): AI 작업 없음', () => {
    expect(keys('web', el({ tag: 'input', type: 'text' }))).toEqual([]);
  });

  it('메뉴 글은 한국어', () => {
    for (const intent of Object.values(INTENTS)) expect(intent.label).toMatch(/[가-힣]/);
  });
});

const screens: ScreenRecord[] = [
  { screenKey: '_common-layout', menuPath: '(모든 화면 공통)', urlTemplate: null, agentRole: null, capabilityName: null },
  { screenKey: '10-01-menu-01', menuPath: '프로모션 관리 > 기획전 관리', urlTemplate: '#/store/themeshopping/list', agentRole: 'StoreAgent', capabilityName: '스토어 설정' },
  { screenKey: '01-16-listing-review-detail-modal-tags', menuPath: '상품관리 > 등록 정보 검토 > 상세 > "수정" 모달(tags)', urlTemplate: '#/product/product-diagnosis?channelProductNo={channelProductNo}', agentRole: 'ProductAgent', capabilityName: '상품' },
  { screenKey: '01-16-listing-review-detail', menuPath: '상품관리 > 등록 정보 검토 > 상세', urlTemplate: '#/product/product-diagnosis?channelProductNo={channelProductNo}', agentRole: 'ProductAgent', capabilityName: '상품' },
  { screenKey: '01-06-product-detail', menuPath: '상품관리 > 상품 수정', urlTemplate: '#/products/edit/{productNo}', agentRole: 'ProductAgent', capabilityName: '상품' },
];
const NAVER = 'https://sell.smartstore.naver.com/';

describe('네이버 주소 → 화면 → 담당 AI(matchScreen · urlTemplate 자리표 {…} · 2026-10-06 시험 서버 실측 꼴)', () => {
  it('해시 경로가 같은 화면', () => {
    expect(matchScreen(`${NAVER}#/store/themeshopping/list`, screens)?.agentRole).toBe('StoreAgent');
    expect(matchScreen(`${NAVER}#/store/themeshopping/list/`, screens)?.screenKey).toBe('10-01-menu-01');
  });

  it('쿼리는 떼고 견준다 · 같은 틀이 여럿이면 screenKey 짧은 것(상세가 모달보다 앞)', () => {
    expect(matchScreen(`${NAVER}#/product/product-diagnosis?channelProductNo=8953893077`, screens)?.screenKey).toBe('01-16-listing-review-detail');
  });

  it('자리표 {…} 는 경로 한 칸의 아무 값', () => {
    expect(matchScreen(`${NAVER}#/products/edit/12345`, screens)?.screenKey).toBe('01-06-product-detail');
    expect(matchScreen(`${NAVER}#/products/edit/12345/options`, screens)).toBeNull();
  });

  it('표에 없는 화면 · 해시 없는 주소 = null(담당 없이 진행)', () => {
    expect(matchScreen(`${NAVER}#/home/dashboard`, screens)).toBeNull();
    expect(matchScreen('https://accounts.commerce.naver.com/login', screens)).toBeNull();
  });
});

describe('챗봇에 넘길 요청 글(buildHandoffMessage · 한국어 · 개인정보 가림)', () => {
  it('작업 · 화면 · 주소 · 담당 AI · 요소 라벨 · 선택자 · 지금 값(전화는 가림)', () => {
    const message = buildHandoffMessage({
      intent: INTENTS.check_rules,
      kind: 'naver',
      pageUrl: `${NAVER}#/store/themeshopping/list`,
      pageTitle: '스마트스토어센터',
      element: el({ tag: 'input', type: 'tel', name: 'product.salePrice', label: '판매가', value: '010-1234-5678', selector: 'input[name="product.salePrice"]' }),
      screen: screens[1] ?? null,
    });
    expect(message.split('\n')[0]).toBe('[AI 작업] 네이버 규칙 검사');
    expect(message).toContain('프로모션 관리 > 기획전 관리 (10-01-menu-01)');
    expect(message).toContain(`주소: ${NAVER}#/store/themeshopping/list`);
    expect(message).toContain('담당 AI: StoreAgent (스토어 설정)');
    expect(message).toContain('라벨 「판매가」');
    expect(message).toContain('선택자: input[name="product.salePrice"]');
    expect(message).toContain(`지금 값: ${MASK_PHONE}`);
    expect(message).not.toContain('010-1234-5678');
    expect(message).toContain('요청: ');
  });

  it('요소 · 화면이 없으면 그 줄이 빠지고 페이지 제목을 쓴다', () => {
    const message = buildHandoffMessage({ intent: INTENTS.summarize_screen, kind: 'admin', pageUrl: 'https://x.test/admin#/sw/dashboard/index', pageTitle: 'Dashboard', element: null, screen: null });
    expect(message).toContain('화면: Dashboard');
    expect(message).toContain('플랫폼: Shopware 어드민');
    expect(message).not.toContain('선택자');
    expect(message).not.toContain('담당 AI');
    expect(message).not.toContain('지금 값');
  });
});
