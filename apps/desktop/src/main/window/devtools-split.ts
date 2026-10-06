// HUBAPP-DEVTOOLS — pane 자리를 페이지(왼쪽) · sash · 개발자 도구(오른쪽)로 나눈다 (순수 함수 · electron 없음)
import { LAYOUT_LIMITS, type Rect } from '@cmh-hub-app/contracts';

/** 기본 개발자 도구 너비 비율(pane 너비의 40%) */
export const DEVTOOLS_DEFAULT_RATIO = 0.4;
export const DEVTOOLS_MIN_WIDTH = 320;
export const PAGE_MIN_WIDTH = 320;
export const DEVTOOLS_HEADER_HEIGHT = 28;

export interface DevToolsSplit {
  page: Rect;
  sash: Rect;
  header: Rect;
  devtools: Rect;
}

/** pane 자리를 페이지(왼쪽) · sash · 개발자 도구(오른쪽)로 나눈다 — pane 이 좁으면 개발자 도구를 줄인다 */
export function splitForDevTools(content: Rect, ratio: number = DEVTOOLS_DEFAULT_RATIO): DevToolsSplit {
  const sashSize = LAYOUT_LIMITS.sashSize;
  const minCombined = DEVTOOLS_MIN_WIDTH + PAGE_MIN_WIDTH + sashSize;
  let w: number;

  if (content.width < minCombined) {
    // pane 이 둘의 최소 합(644 = 페이지 320 + 개발자 도구 320 + 경계선 4)보다 좁으면 반씩 — 개발자 도구가 0px 로 사라지지 않게(제미나이 검수 2026-10-05)
    w = Math.max(0, Math.floor((content.width - sashSize) / 2));
  } else {
    const r = Number.isFinite(ratio) ? ratio : DEVTOOLS_DEFAULT_RATIO;
    const want = Math.round(content.width * r);
    const minW = DEVTOOLS_MIN_WIDTH;
    const maxW = content.width - PAGE_MIN_WIDTH - sashSize;
    w = Math.min(Math.max(want, minW), maxW);
  }

  const pageWidth = Math.max(0, content.width - w - sashSize);
  const headerHeight = Math.min(DEVTOOLS_HEADER_HEIGHT, content.height);
  const devtoolsHeight = Math.max(0, content.height - headerHeight);

  return {
    page: {
      x: content.x,
      y: content.y,
      width: pageWidth,
      height: content.height,
    },
    sash: {
      x: content.x + pageWidth,
      y: content.y,
      width: sashSize,
      height: content.height,
    },
    header: {
      x: content.x + pageWidth + sashSize,
      y: content.y,
      width: w,
      height: headerHeight,
    },
    devtools: {
      x: content.x + pageWidth + sashSize,
      y: content.y + headerHeight,
      width: w,
      height: devtoolsHeight,
    },
  };
}
