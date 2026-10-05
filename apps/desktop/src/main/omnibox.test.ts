import { describe, expect, it } from 'vitest';
import { resolveOmniboxInput } from './omnibox.js';

const search = (q: string): string => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

describe('빈 탭 주소창(2026-10-05 «url 넣고 크롬처럼 인터넷 검색»)', () => {
  it('주소는 그대로 · scheme 이 없으면 https 를 붙인다', () => {
    expect(resolveOmniboxInput('https://www.naver.com')).toBe('https://www.naver.com/');
    expect(resolveOmniboxInput('example.com')).toBe('https://example.com/');
    expect(resolveOmniboxInput('shop.my-mik.de/admin#/login')).toBe('https://shop.my-mik.de/admin#/login');
    expect(resolveOmniboxInput('localhost:8080/x')).toBe('https://localhost:8080/x');
    expect(resolveOmniboxInput('192.168.0.10')).toBe('https://192.168.0.10/');
    expect(resolveOmniboxInput('[::1]:8080')).toBe('https://[::1]:8080/');
    expect(resolveOmniboxInput('네이버.com')).toBe(new URL('https://네이버.com').toString());
    expect(resolveOmniboxInput('네이버.com')).toMatch(/^https:\/\/xn--/);
  });

  it('낱말 · 빈칸 든 글 · 점 없는 한 낱말은 Google 검색', () => {
    expect(resolveOmniboxInput('electron devtools')).toBe(search('electron devtools'));
    expect(resolveOmniboxInput('독일 약국 가격')).toBe(search('독일 약국 가격'));
    expect(resolveOmniboxInput('shopware')).toBe(search('shopware'));
    expect(resolveOmniboxInput('1.5')).toBe(search('1.5'));
    expect(resolveOmniboxInput('example.com 가격')).toBe(search('example.com 가격'));
  });

  it('javascript: · file: · data: 는 열지 않고 검색어로 본다 · 빈 글은 null', () => {
    expect(resolveOmniboxInput('javascript:alert(1)')).toBe(search('javascript:alert(1)'));
    expect(resolveOmniboxInput('file:///C:/Windows')).toBe(search('file:///C:/Windows'));
    expect(resolveOmniboxInput('data:text/html,hi')).toBe(search('data:text/html,hi'));
    expect(resolveOmniboxInput('   ')).toBeNull();
  });
});
