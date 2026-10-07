import { describe, expect, it, vi } from 'vitest';
import { runReadSteps } from './content-runner.js';

interface FakeElementOptions {
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, string>;
  value?: string;
  rect?: { width: number; height: number };
}

function createFakeElement(opts: FakeElementOptions = {}) {
  const tagName = opts.tagName ?? 'DIV';
  const attributes = { ...(opts.attributes ?? {}) };
  let value = opts.value ?? '';
  let textContent = opts.textContent ?? '';
  const click = vi.fn();
  const getBoundingClientRect = vi.fn().mockReturnValue(opts.rect ?? { width: 100, height: 20 });

  return {
    tagName,
    get textContent() {
      return textContent;
    },
    set textContent(v: string) {
      textContent = v;
    },
    get value() {
      return value;
    },
    set value(v: string) {
      value = v;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    setAttribute(name: string, val: string) {
      attributes[name] = val;
    },
    getBoundingClientRect,
    click,
  };
}

function createFakeDoc(elementMap: Record<string, ReturnType<typeof createFakeElement>>) {
  return {
    querySelector: vi.fn((selector: string) => {
      return elementMap[selector] ?? null;
    }),
  } as unknown as Document;
}

function createFakeWin() {
  return {
    scrollBy: vi.fn(),
    innerHeight: 800,
    innerWidth: 1200,
    location: {
      href: 'https://sell.smartstore.naver.com/#/home',
      origin: 'https://sell.smartstore.naver.com',
    },
  } as unknown as Pick<Window, 'scrollBy' | 'innerHeight' | 'innerWidth' | 'location'>;
}

describe('runReadSteps', () => {
  it('read 단계: 요소의 텍스트를 읽고 앞뒤 공백을 자른다', async () => {
    const fakeEl = createFakeElement({
      tagName: 'SPAN',
      textContent: '   스마트스토어 판매자센터 홈   ',
    });
    const doc = createFakeDoc({ '#store-title': fakeEl });
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'read', selector: '#store-title' }]);

    expect(res.ok).toBe(true);
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]).toEqual({
      op: 'read',
      ok: true,
      value: '스마트스토어 판매자센터 홈',
    });
    expect(res.error).toBeNull();
  });

  it('read 단계: password 타입 입력칸은 보안상 null 을 반환한다', async () => {
    const fakeEl = createFakeElement({
      tagName: 'INPUT',
      attributes: { type: 'password' },
      value: 'my-secret-password-123',
    });
    const doc = createFakeDoc({ 'input#pw': fakeEl });
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'read', selector: 'input#pw' }]);

    expect(res.ok).toBe(true);
    expect(res.steps[0]).toEqual({
      op: 'read',
      ok: true,
      value: null,
    });
  });

  it('read 단계: 없는 선택자면 selector-missing 에러로 중단된다', async () => {
    const doc = createFakeDoc({});
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'read', selector: '#not-existing-element' }]);

    expect(res.ok).toBe(false);
    expect(res.steps[0]).toEqual({
      op: 'read',
      ok: false,
      error: 'selector-missing',
    });
    expect(res.error?.code).toBe('selector-missing');
  });

  it('scroll 단계: win.scrollBy(0, deltaY) 를 호출한다', async () => {
    const doc = createFakeDoc({});
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'scroll', deltaY: 350 }]);

    expect(res.ok).toBe(true);
    expect(win.scrollBy).toHaveBeenCalledWith(0, 350);
    expect(res.steps[0]).toEqual({
      op: 'scroll',
      ok: true,
    });
  });

  it('goto 단계: 지원하지 않으므로 invalid-step 에러로 중단된다', async () => {
    const doc = createFakeDoc({});
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [
      { op: 'goto', url: 'https://sell.smartstore.naver.com/#/products' },
    ]);

    expect(res.ok).toBe(false);
    expect(res.steps[0]).toEqual({
      op: 'goto',
      ok: false,
      error: 'invalid-step',
    });
    expect(res.error?.code).toBe('invalid-step');
  });

  it('click 단계: 위험 낱말이 포함된 링크는 invalid-step 으로 차단된다', async () => {
    const fakeEl = createFakeElement({
      tagName: 'A',
      attributes: { href: '#/withdraw' },
      textContent: '회원 탈퇴하기',
    });
    const doc = createFakeDoc({ 'a.leave-btn': fakeEl });
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'click', selector: 'a.leave-btn' }]);

    expect(res.ok).toBe(false);
    expect(res.steps[0]).toEqual({
      op: 'click',
      ok: false,
      error: 'invalid-step',
    });
    expect(res.error?.code).toBe('invalid-step');
    expect(fakeEl.click).not.toHaveBeenCalled();
  });

  it('click 단계: 안전한 탭 네비게이션 대상은 정상 클릭된다', async () => {
    const fakeEl = createFakeElement({
      tagName: 'BUTTON',
      attributes: { role: 'tab' },
      textContent: '주문 배송 조회',
    });
    const doc = createFakeDoc({ 'button.tab-orders': fakeEl });
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'click', selector: 'button.tab-orders' }]);

    expect(res.ok).toBe(true);
    expect(res.steps[0]).toEqual({
      op: 'click',
      ok: true,
    });
    expect(fakeEl.click).toHaveBeenCalledTimes(1);
  });

  it('steps 가 배열이 아니면 ok false 와 invalid-step 을 반환한다', async () => {
    const doc = createFakeDoc({});
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, undefined as unknown as unknown[]);

    expect(res.ok).toBe(false);
    expect(res.steps).toHaveLength(0);
    expect(res.error?.code).toBe('invalid-step');
    expect(res.error?.message).toBe('steps 가 배열이 아닙니다');
  });

  it('querySelector 가 throw 하면 그 단계 invalid-step 으로 중단된다', async () => {
    const doc = {
      querySelector: vi.fn().mockImplementation(() => {
        throw new Error('SyntaxError: The string did not match the expected pattern.');
      }),
    } as unknown as Document;
    const win = createFakeWin();

    const res = await runReadSteps(doc, win, [{ op: 'read', selector: '::invalid-selector' }]);

    expect(res.ok).toBe(false);
    expect(res.steps[0]).toEqual({
      op: 'read',
      ok: false,
      error: 'invalid-step',
    });
    expect(res.error?.code).toBe('invalid-step');
    expect(res.error?.message).toContain('SyntaxError');
  });
});

