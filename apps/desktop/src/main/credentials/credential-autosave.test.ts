import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {}, app: {}, safeStorage: {}, Notification: {}, shell: {} }));
const { shouldSaveAfterNavigation } = await import('./credential-autosave.js');
const { findLoginPage } = await import('./login-pages.js');

const admin = findLoginPage('admin', 'https://testumgebung.my-mik.de/admin#/login/')!;
const naver = findLoginPage('naver', 'https://accounts.commerce.naver.com/login?url=x')!;

describe('로그인 뒤 자동 저장(U08c · 2026-10-05 «계정저장 클릭안해도 자동으로 저장되게»)', () => {
  it('로그인 뒤 도착 화면에 오면 저장한다 — 어드민 해시 화면 · 네이버 판매자센터 첫 화면', () => {
    expect(shouldSaveAfterNavigation({ page: admin }, 'https://testumgebung.my-mik.de/admin#/sw/dashboard/index')).toBe(true);
    expect(shouldSaveAfterNavigation({ page: naver }, 'https://sell.smartstore.naver.com/#/home/dashboard')).toBe(true);
  });

  it('로그인 화면에 머묾 · F5(해시 없음) · 실패 뒤 다른 링크 · 판매자 가입 화면 · 2단계 인증 화면은 저장 안 함', () => {
    expect(shouldSaveAfterNavigation({ page: admin }, 'https://testumgebung.my-mik.de/admin#/login/')).toBe(false);
    expect(shouldSaveAfterNavigation({ page: admin }, 'https://testumgebung.my-mik.de/admin')).toBe(false);
    expect(shouldSaveAfterNavigation({ page: naver }, 'https://accounts.commerce.naver.com/find/password')).toBe(false);
    expect(shouldSaveAfterNavigation({ page: naver }, 'https://sell.smartstore.naver.com/#/join')).toBe(false);
    expect(shouldSaveAfterNavigation({ page: naver }, 'https://accounts.commerce.naver.com/2fa')).toBe(false);
  });

  it('잡아 둔 값이 없으면 저장 안 함', () => {
    expect(shouldSaveAfterNavigation(null, 'https://testumgebung.my-mik.de/admin#/sw/dashboard/index')).toBe(false);
  });
});
