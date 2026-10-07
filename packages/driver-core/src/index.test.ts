import { describe, expect, it } from 'vitest';

import {
  isNavigationTarget,
  isOriginAllowed,
  parseBridgeToApp,
  parseBridgeToExtension,
  validateStep,
} from './index.js';

describe('driver-core 순수 함수 검증', () => {
  describe('validateStep 경계값 검사', () => {
    it('빈 selector 검사 시 null 을 반환한다', () => {
      expect(validateStep({ op: 'read', selector: '' })).toBeNull();
      expect(validateStep({ op: 'read', selector: '   ' })).toBeNull();
      expect(validateStep({ op: 'click', selector: '' })).toBeNull();
      expect(validateStep({ op: 'click', selector: '  \t ' })).toBeNull();
    });

    it('scroll.deltaY 가 범위를 벗어나면 null 을 반환한다', () => {
      expect(validateStep({ op: 'scroll', deltaY: 3000 })).toBeNull();
      expect(validateStep({ op: 'scroll', deltaY: 2001 })).toBeNull();
      expect(validateStep({ op: 'scroll', deltaY: -2500 })).toBeNull();
      expect(validateStep({ op: 'scroll', deltaY: -2001 })).toBeNull();
    });

    it('wait.ms 가 범위를 벗어나면 null 을 반환한다', () => {
      expect(validateStep({ op: 'wait', ms: -1 })).toBeNull();
      expect(validateStep({ op: 'wait', ms: 30001 })).toBeNull();
      expect(validateStep({ op: 'wait', ms: 35000 })).toBeNull();
    });

    it('지원하지 않거나 알 수 없는 op 이면 null 을 반환한다', () => {
      expect(validateStep({ op: 'type', text: 'abc' })).toBeNull();
      expect(validateStep({ op: 'submit' })).toBeNull();
      expect(validateStep({ op: 'unknown' })).toBeNull();
    });

    it('객체가 아니거나 op 속성이 없으면 null 을 반환한다', () => {
      expect(validateStep(null)).toBeNull();
      expect(validateStep(undefined)).toBeNull();
      expect(validateStep(123)).toBeNull();
      expect(validateStep('step')).toBeNull();
      expect(validateStep({})).toBeNull();
      expect(validateStep({ selector: 'div' })).toBeNull();
    });

    it('빈 url 검사 시 null 을 반환한다', () => {
      expect(validateStep({ op: 'goto', url: '' })).toBeNull();
      expect(validateStep({ op: 'goto', url: '   ' })).toBeNull();
    });

    it('유효한 단계는 정확한 DriverStep 객체를 반환한다', () => {
      expect(validateStep({ op: 'goto', url: 'https://sell.smartstore.naver.com/' })).toEqual({
        op: 'goto',
        url: 'https://sell.smartstore.naver.com/',
      });
      expect(validateStep({ op: 'read', selector: ' #title ' })).toEqual({
        op: 'read',
        selector: '#title',
      });
      expect(validateStep({ op: 'click', selector: 'button.search' })).toEqual({
        op: 'click',
        selector: 'button.search',
      });
      expect(validateStep({ op: 'scroll', deltaY: 360 })).toEqual({
        op: 'scroll',
        deltaY: 360,
      });
      expect(validateStep({ op: 'scroll', deltaY: -2000 })).toEqual({
        op: 'scroll',
        deltaY: -2000,
      });
      expect(validateStep({ op: 'scroll', deltaY: 2000 })).toEqual({
        op: 'scroll',
        deltaY: 2000,
      });
      expect(validateStep({ op: 'wait', ms: 500 })).toEqual({
        op: 'wait',
        ms: 500,
      });
      expect(validateStep({ op: 'wait', ms: 0 })).toEqual({
        op: 'wait',
        ms: 0,
      });
      expect(validateStep({ op: 'wait', ms: 30000 })).toEqual({
        op: 'wait',
        ms: 30000,
      });
    });
  });

  describe('isOriginAllowed 출처 검사', () => {
    const allowed = ['https://seller.naver.com', 'https://testumgebung.my-mik.de'];

    it('http 프로토콜은 거절한다', () => {
      expect(isOriginAllowed('http://seller.naver.com/dashboard', allowed)).toBe(false);
      expect(isOriginAllowed('http://testumgebung.my-mik.de/admin', allowed)).toBe(false);
    });

    it('허용되지 않은 다른 origin 은 거절한다', () => {
      expect(isOriginAllowed('https://evil.com/fake', allowed)).toBe(false);
      expect(isOriginAllowed('https://naver.com', allowed)).toBe(false);
      expect(isOriginAllowed('https://seller.naver.com:8443/', allowed)).toBe(false);
    });

    it('허용된 origin 과 같은 출처의 다른 경로는 허용한다', () => {
      expect(isOriginAllowed('https://seller.naver.com/', allowed)).toBe(true);
      expect(isOriginAllowed('https://seller.naver.com/sub/path?foo=bar#hash', allowed)).toBe(true);
      expect(isOriginAllowed('https://testumgebung.my-mik.de/admin#/sw/dashboard/index', allowed)).toBe(true);
    });

    it('깨진 URL 또는 빈 문자열은 거절한다', () => {
      expect(isOriginAllowed('not-a-url', allowed)).toBe(false);
      expect(isOriginAllowed('', allowed)).toBe(false);
      expect(isOriginAllowed('   ', allowed)).toBe(false);
      expect(isOriginAllowed('javascript:void(0)', allowed)).toBe(false);
    });
  });

  describe('isNavigationTarget 화면 이동 대상 판정 검사', () => {
    it('a 태그 SPA 해시 경로는 허용한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/product/list',
          resolvedProtocol: null,
          role: null,
          label: '상품 목록',
          sameOrigin: true,
        }),
      ).toBe(true);
    });

    it('a 태그 https 절대 URL 은 허용한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: 'https://seller.naver.com/items',
          resolvedProtocol: 'https:',
          role: null,
          label: '네이버 쇼핑',
          sameOrigin: true,
        }),
      ).toBe(true);
    });

    it('a 태그 http 절대 URL 은 허용한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '/',
          resolvedProtocol: 'http:',
          role: null,
          label: 'Home',
          sameOrigin: true,
        }),
      ).toBe(true);
    });

    it('role=tab 요소는 허용한다', () => {
      expect(
        isNavigationTarget({
          tag: 'div',
          href: null,
          resolvedProtocol: null,
          role: 'tab',
          label: '상세정보',
          sameOrigin: false,
        }),
      ).toBe(true);
    });

    it('button 태그는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'button',
          href: null,
          resolvedProtocol: null,
          role: null,
          label: '조회',
          sameOrigin: false,
        }),
      ).toBe(false);
    });

    it('role=menuitem 요소는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'li',
          href: null,
          resolvedProtocol: null,
          role: 'menuitem',
          label: '열기',
          sameOrigin: false,
        }),
      ).toBe(false);
    });

    it('role=link 요소는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'span',
          href: null,
          resolvedProtocol: null,
          role: 'link',
          label: '이동',
          sameOrigin: false,
        }),
      ).toBe(false);
    });

    it('javascript: 가짜 링크는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: 'javascript:void(0)',
          resolvedProtocol: 'javascript:',
          role: null,
          label: '더보기',
          sameOrigin: false,
        }),
      ).toBe(false);
    });

    it('# 앵커 및 빈 href 는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#',
          resolvedProtocol: 'https:',
          role: null,
          label: 'Top',
          sameOrigin: true,
        }),
      ).toBe(false);
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '',
          resolvedProtocol: null,
          role: null,
          label: '링크',
          sameOrigin: true,
        }),
      ).toBe(false);
    });

    it('위험 글자(상품 삭제)가 포함된 a 태그는 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/product/delete',
          resolvedProtocol: null,
          role: null,
          label: '상품 삭제',
          sameOrigin: true,
        }),
      ).toBe(false);
    });

    it('위험 글자(Save)가 포함된 aria-label 은 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: 'https://example.com/save',
          resolvedProtocol: 'https:',
          role: null,
          label: 'Save',
          sameOrigin: true,
        }),
      ).toBe(false);
    });

    it('위험 글자가 포함된 role=tab 요소도 거절한다', () => {
      expect(
        isNavigationTarget({
          tag: 'button',
          href: null,
          resolvedProtocol: null,
          role: 'tab',
          label: '설정 삭제',
          sameOrigin: false,
        }),
      ).toBe(false);
      expect(
        isNavigationTarget({
          tag: 'button',
          href: null,
          resolvedProtocol: null,
          role: 'tab',
          label: '저장',
          sameOrigin: false,
        }),
      ).toBe(false);
    });

    it('U07A-fix5 허용 대상 검사', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/orders/cancel',
          resolvedProtocol: null,
          role: null,
          label: '취소/반품 관리',
          sameOrigin: false,
        }),
      ).toBe(true);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/orders/dispatch',
          resolvedProtocol: null,
          role: null,
          label: '주문/발송 관리',
          sameOrigin: false,
        }),
      ).toBe(true);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/orders/confirm',
          resolvedProtocol: null,
          role: null,
          label: '주문확인',
          sameOrigin: false,
        }),
      ).toBe(true);

      expect(
        isNavigationTarget({
          tag: 'div',
          href: null,
          resolvedProtocol: null,
          role: 'tab',
          label: '취소 내역',
          sameOrigin: false,
        }),
      ).toBe(true);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: 'https://seller.naver.com/products',
          resolvedProtocol: 'https:',
          role: null,
          label: '상품 목록',
          sameOrigin: true,
        }),
      ).toBe(true);
    });

    it('U07A-fix5 거절 대상 검사', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/products/123/delete',
          resolvedProtocol: null,
          role: null,
          label: '',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/product/delete/99',
          resolvedProtocol: null,
          role: null,
          label: '휴지통',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: 'https://evil.com/items',
          resolvedProtocol: 'https:',
          role: null,
          label: '상품 목록',
          sameOrigin: false,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: '취소',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: '저장하기',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: 'Save',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: '로그아웃',
          sameOrigin: true,
        }),
      ).toBe(false);
    });

    it('U07A-fix6 거절 대상 검사', () => {
      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: '저장 하기',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x',
          resolvedProtocol: null,
          role: null,
          label: 'Eintrag löschen',
          sameOrigin: true,
        }),
      ).toBe(false);

      expect(
        isNavigationTarget({
          tag: 'a',
          href: '#/x/loeschen',
          resolvedProtocol: null,
          role: null,
          label: '항목',
          sameOrigin: true,
        }),
      ).toBe(false);
    });
  });

  describe('parseBridgeToExtension 메시지 파서', () => {
    it('정상 ping 메시지를 파싱한다', () => {
      expect(parseBridgeToExtension('{"type":"ping"}')).toEqual({ type: 'ping' });
    });

    it('정상 run 메시지를 파싱한다', () => {
      const raw = JSON.stringify({
        type: 'run',
        id: 'job-123',
        steps: [{ op: 'goto', url: 'https://sell.smartstore.naver.com/' }],
      });
      expect(parseBridgeToExtension(raw)).toEqual({
        type: 'run',
        id: 'job-123',
        steps: [{ op: 'goto', url: 'https://sell.smartstore.naver.com/' }],
      });
    });

    it('깨진 JSON 이거나 원시값/배열이면 null 을 반환한다', () => {
      expect(parseBridgeToExtension('{ broken json')).toBeNull();
      expect(parseBridgeToExtension('')).toBeNull();
      expect(parseBridgeToExtension('123')).toBeNull();
      expect(parseBridgeToExtension('"string"')).toBeNull();
      expect(parseBridgeToExtension('null')).toBeNull();
      expect(parseBridgeToExtension('[]')).toBeNull();
    });

    it('모르는 type 이면 null 을 반환한다', () => {
      expect(parseBridgeToExtension('{"type":"unknown"}')).toBeNull();
      expect(parseBridgeToExtension('{"type":"pong"}')).toBeNull();
    });

    it('run 메시지에 필수 필드가 누락되었거나 비어있으면 null 을 반환한다', () => {
      expect(parseBridgeToExtension('{"type":"run","steps":[]}')).toBeNull();
      expect(parseBridgeToExtension('{"type":"run","id":"","steps":[]}')).toBeNull();
      expect(parseBridgeToExtension('{"type":"run","id":"   ","steps":[]}')).toBeNull();
      expect(parseBridgeToExtension('{"type":"run","id":"job-1"}')).toBeNull();
      expect(parseBridgeToExtension('{"type":"run","id":"job-1","steps":"invalid"}')).toBeNull();
    });
  });

  describe('parseBridgeToApp 메시지 파서', () => {
    it('정상 pong 메시지를 파싱한다', () => {
      expect(parseBridgeToApp('{"type":"pong"}')).toEqual({ type: 'pong' });
    });

    it('정상 hello 메시지를 파싱한다', () => {
      expect(parseBridgeToApp('{"type":"hello","extVersion":"0.1.0"}')).toEqual({
        type: 'hello',
        extVersion: '0.1.0',
      });
    });

    it('정상 result 메시지를 파싱한다', () => {
      const raw = JSON.stringify({
        type: 'result',
        id: 'job-123',
        result: {
          ok: true,
          steps: [{ op: 'goto', ok: true }],
          error: null,
        },
      });
      expect(parseBridgeToApp(raw)).toEqual({
        type: 'result',
        id: 'job-123',
        result: {
          ok: true,
          steps: [{ op: 'goto', ok: true }],
          error: null,
        },
      });
    });

    it('깨진 JSON 이거나 원시값/배열이면 null 을 반환한다', () => {
      expect(parseBridgeToApp('{ broken json')).toBeNull();
      expect(parseBridgeToApp('')).toBeNull();
      expect(parseBridgeToApp('123')).toBeNull();
      expect(parseBridgeToApp('"hello"')).toBeNull();
      expect(parseBridgeToApp('null')).toBeNull();
      expect(parseBridgeToApp('[]')).toBeNull();
    });

    it('모르는 type 이면 null 을 반환한다', () => {
      expect(parseBridgeToApp('{"type":"unknown"}')).toBeNull();
      expect(parseBridgeToApp('{"type":"run"}')).toBeNull();
    });

    it('hello 메시지에 extVersion 이 없거나 비어있으면 null 을 반환한다', () => {
      expect(parseBridgeToApp('{"type":"hello"}')).toBeNull();
      expect(parseBridgeToApp('{"type":"hello","extVersion":123}')).toBeNull();
      expect(parseBridgeToApp('{"type":"hello","extVersion":""}')).toBeNull();
    });

    it('result 메시지에 필수 필드가 누락되었거나 비어있으면 null 을 반환한다', () => {
      expect(parseBridgeToApp('{"type":"result","result":{"ok":true,"steps":[]}}')).toBeNull();
      expect(parseBridgeToApp('{"type":"result","id":"","result":{"ok":true,"steps":[]}}')).toBeNull();
      expect(parseBridgeToApp('{"type":"result","id":"job-1"}')).toBeNull();
      expect(parseBridgeToApp('{"type":"result","id":"job-1","result":{"steps":[]}}')).toBeNull();
      expect(parseBridgeToApp('{"type":"result","id":"job-1","result":{"ok":true}}')).toBeNull();
      expect(
        parseBridgeToApp('{"type":"result","id":"job-1","result":{"ok":"not-boolean","steps":[]}}'),
      ).toBeNull();
      expect(
        parseBridgeToApp('{"type":"result","id":"job-1","result":{"ok":true,"steps":"not-array"}}'),
      ).toBeNull();
    });

    it('result 메시지의 error 필드를 엄격하게 검증한다', () => {
      // 1. error 없음 -> null
      expect(
        parseBridgeToApp('{"type":"result","id":"job-1","result":{"ok":true,"steps":[]}}'),
      ).toBeNull();

      // 2. error null -> 통과
      expect(
        parseBridgeToApp('{"type":"result","id":"job-1","result":{"ok":true,"steps":[],"error":null}}'),
      ).toEqual({
        type: 'result',
        id: 'job-1',
        result: {
          ok: true,
          steps: [],
          error: null,
        },
      });

      // 3. error 의 code 가 숫자 -> null
      expect(
        parseBridgeToApp(
          '{"type":"result","id":"job-1","result":{"ok":false,"steps":[],"error":{"code":123,"message":"m"}}}',
        ),
      ).toBeNull();
    });
  });
});
