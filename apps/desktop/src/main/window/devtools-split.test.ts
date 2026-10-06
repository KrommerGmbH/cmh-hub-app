import { describe, expect, it } from 'vitest';
import {
  DEVTOOLS_DEFAULT_RATIO,
  DEVTOOLS_HEADER_HEIGHT,
  DEVTOOLS_MIN_WIDTH,
  PAGE_MIN_WIDTH,
  splitForDevTools,
} from './devtools-split.js';
import { LAYOUT_LIMITS } from '@cmh-hub-app/contracts';

describe('splitForDevTools (HUBAPP-DEVTOOLS)', () => {
  it('기본 비율: 1000px pane 에서 오른쪽 개발자 도구 너비 400px (40%)', () => {
    const content = { x: 0, y: 40, width: 1000, height: 600 };
    const split = splitForDevTools(content);

    expect(split.header.width).toBe(400);
    expect(split.devtools.width).toBe(400);
    expect(split.sash.width).toBe(LAYOUT_LIMITS.sashSize);
    expect(split.page.width).toBe(1000 - 400 - LAYOUT_LIMITS.sashSize);
    expect(split.page.width + split.sash.width + split.header.width).toBe(content.width);

    expect(split.header.height).toBe(DEVTOOLS_HEADER_HEIGHT);
    expect(split.devtools.height).toBe(600 - DEVTOOLS_HEADER_HEIGHT);
    expect(split.header.height + split.devtools.height).toBe(content.height);

    expect(split.sash.x).toBe(split.page.x + split.page.width);
    expect(split.header.x).toBe(split.sash.x + split.sash.width);
    expect(split.devtools.x).toBe(split.header.x);
    expect(split.devtools.y).toBe(content.y + DEVTOOLS_HEADER_HEIGHT);
  });

  it('넓은 비율 0.9: 페이지 최소 너비 320px 를 지키며 오른쪽 너비 제한', () => {
    const content = { x: 50, y: 100, width: 1000, height: 700 };
    const split = splitForDevTools(content, 0.9);

    expect(split.page.width).toBe(PAGE_MIN_WIDTH);
    expect(split.header.width).toBe(1000 - PAGE_MIN_WIDTH - LAYOUT_LIMITS.sashSize);
    expect(split.devtools.width).toBe(split.header.width);
    expect(split.page.width + split.sash.width + split.header.width).toBe(content.width);
  });

  it('좁은 비율 0.1: 개발자 도구 최소 너비 320px 를 지킴', () => {
    const content = { x: 0, y: 0, width: 1000, height: 800 };
    const split = splitForDevTools(content, 0.1);

    expect(split.header.width).toBe(DEVTOOLS_MIN_WIDTH);
    expect(split.devtools.width).toBe(DEVTOOLS_MIN_WIDTH);
    expect(split.page.width).toBe(1000 - DEVTOOLS_MIN_WIDTH - LAYOUT_LIMITS.sashSize);
    expect(split.page.width + split.sash.width + split.header.width).toBe(content.width);
  });

  it('좁은 pane (500px): 최소 합 644 미만이면 반씩 나눔', () => {
    const content = { x: 0, y: 0, width: 500, height: 500 };
    const split = splitForDevTools(content, 0.4);

    const expectedHalf = Math.floor((500 - LAYOUT_LIMITS.sashSize) / 2);
    expect(split.header.width).toBe(expectedHalf);
    expect(split.devtools.width).toBe(expectedHalf);
    expect(split.page.width).toBe(500 - expectedHalf - LAYOUT_LIMITS.sashSize);
    expect(split.page.width + split.sash.width + split.header.width).toBe(content.width);
  });

  it('NaN 또는 유한수가 아닌 비율: 기본 비율 0.4 적용', () => {
    const content = { x: 10, y: 20, width: 1000, height: 600 };
    const splitNaN = splitForDevTools(content, NaN);
    const splitInfinity = splitForDevTools(content, Infinity);
    const splitDefault = splitForDevTools(content, DEVTOOLS_DEFAULT_RATIO);

    expect(splitNaN).toEqual(splitDefault);
    expect(splitInfinity).toEqual(splitDefault);
  });

  it('너비 불변식: page.width + sash.width + header.width === content.width', () => {
    const widths = [400, 500, 644, 700, 1000, 1920];
    const ratios = [0.05, 0.2, 0.4, 0.5, 0.8, 0.95];

    for (const width of widths) {
      for (const ratio of ratios) {
        const content = { x: 0, y: 0, width, height: 800 };
        const split = splitForDevTools(content, ratio);
        expect(split.page.width + split.sash.width + split.header.width).toBe(content.width);
        expect(split.header.width).toBe(split.devtools.width);
      }
    }
  });

  it('낮은 높이 (28px 미만): header 높이가 content.height 를 초과하지 않음', () => {
    const content = { x: 0, y: 0, width: 800, height: 20 };
    const split = splitForDevTools(content, 0.4);

    expect(split.header.height).toBe(20);
    expect(split.devtools.height).toBe(0);
  });
});
