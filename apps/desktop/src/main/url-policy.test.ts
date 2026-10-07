import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from './url-policy.js';

describe('isAllowedUrl (A02 허용 호스트)', () => {
  it('admin 탭은 서버 호스트만 · http 는 막는다', () => {
    expect(isAllowedUrl('admin', 'https://testumgebung.my-mik.de/admin#/sw/dashboard/index')).toBe(true);
    expect(isAllowedUrl('admin', 'https://evil.example/admin')).toBe(false);
    expect(isAllowedUrl('admin', 'http://testumgebung.my-mik.de/admin')).toBe(false);
    expect(isAllowedUrl('admin', 'https://sell.smartstore.naver.com/')).toBe(false);
  });
  it('naver 탭은 naver.com 아래(로그인 nid 포함) · 우리 서버는 막는다', () => {
    expect(isAllowedUrl('naver', 'https://sell.smartstore.naver.com/#/home')).toBe(true);
    expect(isAllowedUrl('naver', 'https://nid.naver.com/nidlogin.login')).toBe(true);
    expect(isAllowedUrl('naver', 'https://naver.com/')).toBe(true);
    expect(isAllowedUrl('naver', 'https://evil-naver.com/')).toBe(false);
    expect(isAllowedUrl('naver', 'https://testumgebung.my-mik.de/admin')).toBe(false);
  });
  it('web 탭은 일반 사이트 통과 · 네이버 탭 꺼짐(U11) 시 네이버 호스트는 막는다', () => {
    expect(isAllowedUrl('web', 'https://example.com/')).toBe(true);
    expect(isAllowedUrl('web', 'https://sell.smartstore.naver.com/')).toBe(false);
    expect(isAllowedUrl('web', 'https://네이버.com/')).toBe(false);
    expect(isAllowedUrl('naver', 'https://sell.smartstore.naver.com/')).toBe(true);
  });
  it('깨진 URL · file: · javascript: 는 막는다 · about: 은 통과', () => {
    expect(isAllowedUrl('admin', 'not a url')).toBe(false);
    expect(isAllowedUrl('admin', 'file:///C:/x.html')).toBe(false);
    expect(isAllowedUrl('naver', 'javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('admin', 'about:blank')).toBe(true);
  });
});
