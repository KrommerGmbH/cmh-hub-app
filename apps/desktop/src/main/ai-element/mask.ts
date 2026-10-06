// U10 9번 — 챗봇으로 보내는 글에서 마켓 고객의 개인정보 «꼴»을 가린다(전화번호 · 이메일). 형식 규칙만 — 이름 · 주소는 꼴로 못 가른다(1차 한계).
// 숫자 앞뒤가 또 숫자면 전화로 안 본다 — 13자리 EAN · 상품번호 · 고객주문번호가 잘려 가려지지 않게.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** 국내 전화 — 0 으로 시작 · 9~11자리 · 구분자(- . 공백)는 있어도 없어도 */
const PHONE_KR = /(?<!\d)0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/g;
/** 국가번호 꼴 — +82 10-1234-5678 · +49 30 123456 */
const PHONE_INTL = /(?<!\d)\+\d{1,3}[-. ]?\(?\d{1,4}\)?[-. ]?\d{3,4}[-. ]?\d{3,4}(?!\d)/g;

export const MASK_EMAIL = '[메일 가림]';
export const MASK_PHONE = '[전화 가림]';

export function maskPersonalData(text: string): string {
  return text.replace(EMAIL, MASK_EMAIL).replace(PHONE_INTL, MASK_PHONE).replace(PHONE_KR, MASK_PHONE);
}
