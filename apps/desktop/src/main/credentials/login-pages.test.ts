import { describe, expect, it } from 'vitest';
import { findLoginPage, matchLoginFieldClick } from './login-pages.js';

const ADMIN_LOGIN = 'https://testumgebung.my-mik.de/admin#/login/';
const NAVER_LOGIN = 'https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F';
const click = (pageURL: string, formControlType = 'input-text', more: Partial<{ frameURL: string; isEditable: boolean }> = {}) => ({
  pageURL, frameURL: more.frameURL ?? pageURL, isEditable: more.isEditable ?? true, formControlType,
});

describe('로그인 칸 가르기(U08 · 2026-10-05 «크롬처럼 아이디 · 비밀번호 넣게»)', () => {
  it('어드민 로그인 화면(#/login)의 글자 · 비밀번호 칸 = 어드민 표', () => {
    expect(matchLoginFieldClick('admin', click(ADMIN_LOGIN))?.kind).toBe('admin');
    expect(matchLoginFieldClick('admin', click(ADMIN_LOGIN, 'input-password'))?.passwordSelectors).toContain('#sw-field--password');
  });

  it('어드민의 다른 화면(로그인 뒤)에서는 안 나온다', () => {
    expect(matchLoginFieldClick('admin', click('https://testumgebung.my-mik.de/admin#/sw/product/index'))).toBeNull();
  });

  it('네이버 판매자 로그인 = 네이버 표 · 판매자센터 안쪽 · 같은 호스트의 다른 화면 · 재지 않은 nid 는 아니다', () => {
    expect(matchLoginFieldClick('naver', click(NAVER_LOGIN, 'input-email'))?.kind).toBe('naver');
    expect(findLoginPage('naver', 'https://sell.smartstore.naver.com/#/home/dashboard')).toBeNull();
    expect(findLoginPage('naver', 'https://accounts.commerce.naver.com/signup')).toBeNull();
    expect(findLoginPage('naver', 'https://nid.naver.com/nidlogin.login')).toBeNull();
  });

  it('탭 종류가 다르면 안 나온다 — 네이버 탭에서 어드민 주소 · 어드민 탭에서 네이버 주소', () => {
    expect(findLoginPage('naver', ADMIN_LOGIN)).toBeNull();
    expect(findLoginPage('admin', NAVER_LOGIN)).toBeNull();
  });

  it('글자 칸이 아닌 곳 · 고칠 수 없는 칸 · iframe 안 · http 는 안 나온다', () => {
    expect(matchLoginFieldClick('admin', click(ADMIN_LOGIN, 'none'))).toBeNull();
    expect(matchLoginFieldClick('admin', click(ADMIN_LOGIN, 'input-checkbox'))).toBeNull();
    expect(matchLoginFieldClick('admin', click(ADMIN_LOGIN, 'input-text', { isEditable: false }))).toBeNull();
    expect(matchLoginFieldClick('naver', click(NAVER_LOGIN, 'input-text', { frameURL: 'https://other.naver.com/frame' }))).toBeNull();
    expect(findLoginPage('admin', 'http://testumgebung.my-mik.de/admin#/login/')).toBeNull();
    expect(findLoginPage('admin', 'https://testumgebung.my-mik.de/account/login#/login')).toBeNull(); // StoreFront 쪽 경로
  });
});
