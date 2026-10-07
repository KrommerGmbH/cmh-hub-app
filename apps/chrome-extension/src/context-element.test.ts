import { describe, expect, it, vi } from 'vitest';

import {
  classifyContextElement,
  intentsForElement,
  readContextElement,
} from './context-element.js';

interface FakeElementOptions {
  tagName?: string;
  type?: string;
  id?: string;
  name?: string;
  role?: string;
  value?: string;
  textContent?: string;
  attributes?: Record<string, string>;
  labels?: Array<{ textContent: string | null }>;
  selectedOptions?: Array<{ textContent: string | null }>;
  parentElement?: unknown;
  previousElementSibling?: unknown;
  ownerDocument?: unknown;
  closestResult?: unknown;
}

function createFakeElement(opts: FakeElementOptions = {}) {
  const tagName = opts.tagName ?? 'DIV';
  const attributes = { ...(opts.attributes ?? {}) };
  if (opts.type) attributes['type'] = opts.type;
  if (opts.name) attributes['name'] = opts.name;
  if (opts.role) attributes['role'] = opts.role;

  const el: Record<string, unknown> = {
    nodeType: 1,
    tagName,
    id: opts.id ?? '',
    type: opts.type,
    value: opts.value ?? '',
    textContent: opts.textContent ?? '',
    labels: opts.labels,
    selectedOptions: opts.selectedOptions,
    parentElement: opts.parentElement ?? null,
    previousElementSibling: opts.previousElementSibling ?? null,
    ownerDocument: opts.ownerDocument ?? null,
    getAttribute: vi.fn((n: string) => attributes[n] ?? null),
    closest: vi.fn((sel: string) => {
      if (opts.closestResult !== undefined) {
        return opts.closestResult;
      }
      return null;
    }),
  };

  return el as unknown as Element;
}

describe('context-element', () => {
  describe('readContextElement', () => {
    it('null 이나 iframe/frame 요소는 null 을 반환한다', () => {
      expect(readContextElement(null)).toBeNull();

      const iframe = createFakeElement({ tagName: 'IFRAME' });
      expect(readContextElement(iframe)).toBeNull();

      const frame = createFakeElement({ tagName: 'FRAME' });
      expect(readContextElement(frame)).toBeNull();
    });

    it('비밀번호 입력칸은 보안상 value 를 null 로 읽는다', () => {
      const pwInput = createFakeElement({
        tagName: 'INPUT',
        type: 'password',
        value: 'very-secret-password-123',
        attributes: { type: 'password', placeholder: '비밀번호 입력' },
      });

      const res = readContextElement(pwInput);
      expect(res).not.toBeNull();
      expect(res?.tag).toBe('input');
      expect(res?.type).toBe('password');
      expect(res?.value).toBeNull();
      expect(res?.label).toBe('비밀번호 입력');
    });

    it('일반 텍스트 입력칸의 값과 라벨을 정상적으로 읽는다', () => {
      const textInput = createFakeElement({
        tagName: 'INPUT',
        type: 'text',
        name: 'productTitle',
        id: 'prod-title',
        value: '원목 책상 1200',
        labels: [{ textContent: '상품명' }],
      });

      const res = readContextElement(textInput);
      expect(res).not.toBeNull();
      expect(res?.tag).toBe('input');
      expect(res?.type).toBe('text');
      expect(res?.name).toBe('productTitle');
      expect(res?.id).toBe('prod-title');
      expect(res?.value).toBe('원목 책상 1200');
      expect(res?.label).toBe('상품명');
      expect(res?.text).toBe('');
    });

    it('select 요소는 선택된 옵션의 텍스트를 value 로 읽는다', () => {
      const select = createFakeElement({
        tagName: 'SELECT',
        selectedOptions: [{ textContent: '택배/등기' }],
        value: 'DELIVERY',
        attributes: { 'aria-label': '배송방법' },
      });

      const res = readContextElement(select);
      expect(res).not.toBeNull();
      expect(res?.tag).toBe('select');
      expect(res?.value).toBe('택배/등기');
      expect(res?.label).toBe('배송방법');
      expect(res?.text).toBe('');
    });

    it('단추 요소의 텍스트와 역할을 정상적으로 읽는다', () => {
      const button = createFakeElement({
        tagName: 'BUTTON',
        role: 'button',
        textContent: '   저장하기   ',
      });

      const res = readContextElement(button);
      expect(res).not.toBeNull();
      expect(res?.tag).toBe('button');
      expect(res?.role).toBe('button');
      expect(res?.text).toBe('저장하기');
      expect(res?.value).toBeNull();
    });

    it('라벨 우선순위: labels > aria-label > aria-labelledby > placeholder > title > sibling', () => {
      // 1. aria-label
      const elAria = createFakeElement({
        tagName: 'INPUT',
        attributes: { 'aria-label': 'Aria 라벨', placeholder: '플레이스홀더' },
      });
      expect(readContextElement(elAria)?.label).toBe('Aria 라벨');

      // 2. placeholder
      const elPlaceholder = createFakeElement({
        tagName: 'INPUT',
        attributes: { placeholder: '플레이스홀더' },
      });
      expect(readContextElement(elPlaceholder)?.label).toBe('플레이스홀더');

      // 3. title
      const elTitle = createFakeElement({
        tagName: 'INPUT',
        attributes: { title: '도움말 툴팁' },
      });
      expect(readContextElement(elTitle)?.label).toBe('도움말 툴팁');

      // 4. sibling text
      const prevSibling = { textContent: '이전 항목명: ' };
      const elSibling = createFakeElement({
        tagName: 'INPUT',
        previousElementSibling: prevSibling,
        parentElement: { parentElement: null },
      });
      expect(readContextElement(elSibling)?.label).toBe('이전 항목명:');
    });

    it('200자 초과 텍스트 및 120자 초과 라벨은 잘라낸다', () => {
      const longText = 'a'.repeat(300);
      const longLabel = 'b'.repeat(200);

      const el = createFakeElement({
        tagName: 'SPAN',
        textContent: longText,
        attributes: { 'aria-label': longLabel },
      });

      const res = readContextElement(el);
      expect(res?.text).toHaveLength(200);
      expect(res?.label).toHaveLength(120);
    });
  });

  describe('classifyContextElement', () => {
    it('요소 종류(field, button, other)를 올바르게 분류한다', () => {
      expect(classifyContextElement(null)).toBe('other');

      expect(
        classifyContextElement({
          tag: 'input',
          type: 'text',
          name: null,
          id: null,
          role: null,
          label: null,
          text: '',
          value: '',
          selector: 'input',
        }),
      ).toBe('field');

      expect(
        classifyContextElement({
          tag: 'input',
          type: 'submit',
          name: null,
          id: null,
          role: null,
          label: null,
          text: '',
          value: '전송',
          selector: 'input',
        }),
      ).toBe('button');

      expect(
        classifyContextElement({
          tag: 'input',
          type: 'hidden',
          name: null,
          id: null,
          role: null,
          label: null,
          text: '',
          value: '',
          selector: 'input',
        }),
      ).toBe('other');

      expect(
        classifyContextElement({
          tag: 'textarea',
          type: null,
          name: null,
          id: null,
          role: null,
          label: null,
          text: '',
          value: '',
          selector: 'textarea',
        }),
      ).toBe('field');

      expect(
        classifyContextElement({
          tag: 'button',
          type: null,
          name: null,
          id: null,
          role: null,
          label: null,
          text: '확인',
          value: null,
          selector: 'button',
        }),
      ).toBe('button');

      expect(
        classifyContextElement({
          tag: 'div',
          type: null,
          name: null,
          id: null,
          role: 'button',
          label: null,
          text: '클릭',
          value: null,
          selector: 'div',
        }),
      ).toBe('button');

      expect(
        classifyContextElement({
          tag: 'div',
          type: null,
          name: null,
          id: null,
          role: null,
          label: null,
          text: '본문 내용',
          value: null,
          selector: 'div',
        }),
      ).toBe('other');
    });
  });

  describe('intentsForElement', () => {
    it('비밀번호 칸은 explain_field 작업만 돌려준다', () => {
      const pwEl = {
        tag: 'input',
        type: 'password',
        name: 'password',
        id: 'pw',
        role: null,
        label: '비밀번호',
        text: '',
        value: null,
        selector: '#pw',
      };

      expect(intentsForElement(pwEl)).toEqual(['explain_field']);
    });

    it('일반 입력칸은 suggest_value, check_rules, explain_field 를 돌려준다', () => {
      const textEl = {
        tag: 'input',
        type: 'text',
        name: 'title',
        id: 'title',
        role: null,
        label: '상품명',
        text: '',
        value: '원목 책상',
        selector: '#title',
      };

      expect(intentsForElement(textEl)).toEqual([
        'suggest_value',
        'check_rules',
        'explain_field',
      ]);
    });

    it('단추는 explain_button 을 돌려준다', () => {
      const buttonEl = {
        tag: 'button',
        type: null,
        name: null,
        id: 'submit-btn',
        role: null,
        label: null,
        text: '등록하기',
        value: null,
        selector: '#submit-btn',
      };

      expect(intentsForElement(buttonEl)).toEqual(['explain_button']);
    });

    it('요소가 없거나(null) 기타 요소는 summarize_screen 을 돌려준다', () => {
      expect(intentsForElement(null)).toEqual(['summarize_screen']);

      const divEl = {
        tag: 'div',
        type: null,
        name: null,
        id: 'content',
        role: null,
        label: null,
        text: '설명 문구',
        value: null,
        selector: '#content',
      };

      expect(intentsForElement(divEl)).toEqual(['summarize_screen']);
    });
  });
});
