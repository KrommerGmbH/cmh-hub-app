import { describe, expect, it } from 'vitest';
import { chromiumLikeUserAgent, clientHintHeaders, formatBrandHeader } from './user-agent.js';

// 2026-10-03 지문 비교에서 잰 실제 값(Electron 44.5.1 · 앱 이름 desktop)
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) desktop/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36';

describe('chromiumLikeUserAgent (U07 8-1)', () => {
  it('Electron · 앱 토막을 빼고 판을 major.0.0.0 으로 줄인다 — 크롬 154 와 같은 꼴', () => {
    expect(chromiumLikeUserAgent(ELECTRON_UA, 'desktop', '0.1.0')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    );
  });
  it('이미 줄인 UA 는 그대로', () => {
    const reduced = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    expect(chromiumLikeUserAgent(reduced, 'desktop', '0.1.0')).toBe(reduced);
  });
});

describe('client hints (U07 8-12)', () => {
  it('엔진 brands 순서 그대로 헤더 글로', () => {
    expect(formatBrandHeader([{ brand: 'Not?A_Brand', version: '24' }, { brand: 'Chromium', version: '152' }])).toBe('"Not?A_Brand";v="24", "Chromium";v="152"');
  });
  it('mobile · platform 꼴', () => {
    expect(clientHintHeaders({ brands: [], mobile: false, platform: 'Windows' })).toEqual({ 'sec-ch-ua': '', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  });
});
