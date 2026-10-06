import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/userData'),
  },
}));

import {
  detectSignals,
  stopReason,
  dayKey,
  parseDayState,
  AF6_DAILY_CAP,
  AF6_MAX_CAPTCHAS,
  AF6_MAX_BOUNCES,
  AF6_MAX_BLOCKS,
  type Af6DayState,
} from './af6-experiment.js';

describe('af6-experiment 순수 함수 검증', () => {
  describe('detectSignals', () => {
    it('캡차 한국어 문구를 탐지한다', () => {
      const result = detectSignals('자동입력 방지 문자를 입력해주세요', 'https://sell.smartstore.naver.com/');
      expect(result.captcha).toBe(true);
      expect(result.loginBounce).toBe(false);
      expect(result.blocked).toBe(false);
    });

    it('보안 문자 및 로봇이 아닙니다 문구를 캡차로 탐지한다', () => {
      const result = detectSignals('화면에 표시된 보안문자를 입력하세요 (로봇이 아닙니다)', 'https://sell.smartstore.naver.com/');
      expect(result.captcha).toBe(true);
      expect(result.loginBounce).toBe(false);
      expect(result.blocked).toBe(false);
    });

    it('recaptcha 영문 문구를 탐지한다', () => {
      const result = detectSignals('Please verify with reCAPTCHA to continue', 'https://sell.smartstore.naver.com/');
      expect(result.captcha).toBe(true);
      expect(result.loginBounce).toBe(false);
      expect(result.blocked).toBe(false);
    });

    it('nid.naver.com URL 튕김을 탐지한다', () => {
      const result = detectSignals('로그인 화면', 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsell.smartstore.naver.com');
      expect(result.captcha).toBe(false);
      expect(result.loginBounce).toBe(true);
      expect(result.blocked).toBe(false);
    });

    it('accounts.commerce.naver.com URL 튕김을 탐지한다', () => {
      const result = detectSignals('', 'https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com');
      expect(result.captcha).toBe(false);
      expect(result.loginBounce).toBe(true);
      expect(result.blocked).toBe(false);
    });

    it('#/login 해시 URL 튕김을 탐지한다', () => {
      const result = detectSignals('로그인 필요', 'https://sell.smartstore.naver.com/#/login');
      expect(result.captcha).toBe(false);
      expect(result.loginBounce).toBe(true);
      expect(result.blocked).toBe(false);
    });

    it('차단 한국어 문구를 탐지한다', () => {
      const result1 = detectSignals('비정상적인 접근이 감지되었습니다', 'https://sell.smartstore.naver.com/');
      expect(result1.captcha).toBe(false);
      expect(result1.loginBounce).toBe(false);
      expect(result1.blocked).toBe(true);

      const result2 = detectSignals('서비스 이용 접근이 제한되었습니다. 일시적으로 제한됩니다.', 'https://sell.smartstore.naver.com/');
      expect(result2.captcha).toBe(false);
      expect(result2.loginBounce).toBe(false);
      expect(result2.blocked).toBe(true);
    });

    it('차단 영문 문구를 탐지한다', () => {
      const result = detectSignals('Access Denied: unusual traffic detected. Request blocked.', 'https://sell.smartstore.naver.com/');
      expect(result.captcha).toBe(false);
      expect(result.loginBounce).toBe(false);
      expect(result.blocked).toBe(true);
    });

    it('평범한 정상 화면 텍스트와 URL 에서는 모든 신호가 false 이다', () => {
      const result = detectSignals('네이버 스마트스토어센터 대시보드 판매 관리 통계', 'https://sell.smartstore.naver.com/#/home');
      expect(result.captcha).toBe(false);
      expect(result.loginBounce).toBe(false);
      expect(result.blocked).toBe(false);
    });
  });

  describe('stopReason', () => {
    it('정상 범위 내에서는 null 을 반환한다', () => {
      const state: Af6DayState = {
        date: '2026-10-06',
        runs: 10,
        captchas: 0,
        bounces: 0,
        blocks: 0,
        stoppedReason: null,
      };
      expect(stopReason(state)).toBeNull();
    });

    it('일일 실행 한도 50회 이상이면 daily-cap 을 반환한다', () => {
      const state: Af6DayState = {
        date: '2026-10-06',
        runs: AF6_DAILY_CAP,
        captchas: 0,
        bounces: 0,
        blocks: 0,
        stoppedReason: null,
      };
      expect(stopReason(state)).toBe('daily-cap');
    });

    it('로그인 튕김 1회 이상이면 login-bounce 를 반환한다', () => {
      const state: Af6DayState = {
        date: '2026-10-06',
        runs: 3,
        captchas: 0,
        bounces: AF6_MAX_BOUNCES,
        blocks: 0,
        stoppedReason: null,
      };
      expect(stopReason(state)).toBe('login-bounce');
    });

    it('차단 1회 이상이면 blocked 를 반환한다', () => {
      const state: Af6DayState = {
        date: '2026-10-06',
        runs: 3,
        captchas: 0,
        bounces: 0,
        blocks: AF6_MAX_BLOCKS,
        stoppedReason: null,
      };
      expect(stopReason(state)).toBe('blocked');
    });

    it('캡차 2회 이상이면 captcha 를 반환한다', () => {
      const state: Af6DayState = {
        date: '2026-10-06',
        runs: 15,
        captchas: AF6_MAX_CAPTCHAS,
        bounces: 0,
        blocks: 0,
        stoppedReason: null,
      };
      expect(stopReason(state)).toBe('captcha');
    });

    it('blocks 필드가 없는 옛 상태 객체에서도 정상 동작한다', () => {
      const oldState = {
        date: '2026-10-06',
        runs: 3,
        captchas: 0,
        bounces: 0,
        stoppedReason: null,
      } as unknown as Af6DayState;
      expect(stopReason(oldState)).toBeNull();
    });
  });

  describe('dayKey', () => {
    it('로컬 Date 객체를 YYYY-MM-DD 형식 문자열로 변환한다', () => {
      const testDate = new Date(2026, 9, 6, 15, 30, 0); // month is 0-indexed: 9 -> October
      expect(dayKey(testDate)).toBe('2026-10-06');
    });
  });

  describe('parseDayState', () => {
    it('정상 상태 파일을 올바르게 파싱한다', () => {
      const today = '2026-10-06';
      const raw = JSON.stringify({
        date: today,
        runs: 5,
        captchas: 1,
        bounces: 0,
        blocks: 1,
        stoppedReason: 'blocked',
      });
      const result = parseDayState(raw, today);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual({
          date: today,
          runs: 5,
          captchas: 1,
          bounces: 0,
          blocks: 1,
          stoppedReason: 'blocked',
        });
      }
    });

    it('다른 날짜의 상태 파일이면 오늘 날짜의 0 초기 상태를 반환한다', () => {
      const today = '2026-10-06';
      const raw = JSON.stringify({
        date: '2026-10-05',
        runs: 40,
        captchas: 2,
        bounces: 1,
        blocks: 1,
        stoppedReason: 'captcha',
      });
      const result = parseDayState(raw, today);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual({
          date: today,
          runs: 0,
          captchas: 0,
          bounces: 0,
          blocks: 0,
          stoppedReason: null,
        });
      }
    });

    it('깨진 JSON 문자열이거나 모양이 틀리면 ok false 를 반환한다', () => {
      const today = '2026-10-06';
      expect(parseDayState('{ corrupted json ...', today)).toEqual({ ok: false });
      expect(parseDayState('null', today)).toEqual({ ok: false });
      expect(parseDayState('123', today)).toEqual({ ok: false });
      expect(parseDayState(JSON.stringify({ date: today, runs: 'invalid' }), today)).toEqual({ ok: false });
    });

    it('blocks 필드가 없는 옛 형식 객체이면 blocks 를 0 으로 보정한다', () => {
      const today = '2026-10-06';
      const raw = JSON.stringify({
        date: today,
        runs: 4,
        captchas: 0,
        bounces: 0,
        stoppedReason: null,
      });
      const result = parseDayState(raw, today);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual({
          date: today,
          runs: 4,
          captchas: 0,
          bounces: 0,
          blocks: 0,
          stoppedReason: null,
        });
      }
    });
  });
});
