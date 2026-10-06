import { describe, expect, it } from 'vitest';
import { MASK_EMAIL, MASK_PHONE, maskPersonalData } from './mask.js';

describe('개인정보 가리기(U10 9번 — 마켓 고객의 전화 · 메일)', () => {
  it('국내 전화 — 하이픈 · 붙여 쓴 것 · 지역번호', () => {
    expect(maskPersonalData('연락처 010-1234-5678 입니다')).toBe(`연락처 ${MASK_PHONE} 입니다`);
    expect(maskPersonalData('01012345678')).toBe(MASK_PHONE);
    expect(maskPersonalData('02-123-4567 / 031 123 4567')).toBe(`${MASK_PHONE} / ${MASK_PHONE}`);
  });

  it('국가번호 꼴 — +82 · +49', () => {
    expect(maskPersonalData('+82 10-1234-5678')).toBe(MASK_PHONE);
    expect(maskPersonalData('tel +49 30 123456')).toBe(`tel ${MASK_PHONE}`);
  });

  it('이메일', () => {
    expect(maskPersonalData('kim.min@example.co.kr 로 보냄')).toBe(`${MASK_EMAIL} 로 보냄`);
  });

  it('EAN 13자리 · 상품번호 · 가격 · 날짜 · 시각은 그대로', () => {
    for (const keep of ['0123456789012', '8953893077', '96200', '2026-10-06', '09:30', '10-01-menu-01', '#/order/detail/2026100612345']) {
      expect(maskPersonalData(keep)).toBe(keep);
    }
  });
});
