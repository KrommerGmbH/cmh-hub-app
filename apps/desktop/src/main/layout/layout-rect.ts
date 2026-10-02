// U02 — 트리 + viewport → pane 마다 stripRect · contentRect, split 마다 sash. 순수 함수(상태 없음).
import type {
  LayoutGeometry,
  LayoutNode,
  LayoutTree,
  PaneGeometry,
  Rect,
  SashGeometry,
} from '@cmh-hub-app/contracts';
import { LAYOUT_LIMITS } from '@cmh-hub-app/contracts';

export interface MinSize {
  width: number;
  height: number;
}

/** 이 노드(하위 트리 전체)가 지켜야 하는 최소 크기 — 가로 split 은 너비를 더하고 세로 split 은 높이를 더한다 */
export function subtreeMinSize(node: LayoutNode): MinSize {
  if (node.type === 'pane') {
    return { width: LAYOUT_LIMITS.minPaneWidth, height: LAYOUT_LIMITS.minPaneHeight };
  }
  const a = subtreeMinSize(node.children[0]);
  const b = subtreeMinSize(node.children[1]);
  if (node.orientation === 'horizontal') {
    return { width: a.width + b.width + LAYOUT_LIMITS.sashSize, height: Math.max(a.height, b.height) };
  }
  return { width: Math.max(a.width, b.width), height: a.height + b.height + LAYOUT_LIMITS.sashSize };
}

/**
 * split 하나의 첫 자식 길이(px). avail = 부모 길이 − sash.
 * 최소 크기를 지킬 수 있으면 [minFirst, avail − minSecond] 안으로 자른다.
 * 못 지키면(viewport 가 너무 작음) 첫 자식 = minFirst — 둘째 자식은 호출한 쪽이 minSecond 로 두고 넘치게 둔다.
 */
export function firstChildLength(avail: number, ratio: number, minFirst: number, minSecond: number): number {
  const wanted = Math.round(avail * ratio);
  return Math.max(minFirst, Math.min(wanted, avail - minSecond));
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

function layoutNode(node: LayoutNode, rect: Rect, panes: PaneGeometry[], sashes: SashGeometry[]): void {
  if (node.type === 'pane') {
    const strip = LAYOUT_LIMITS.stripHeight;
    panes.push({
      paneId: node.id,
      stripRect: { x: rect.x, y: rect.y, width: rect.width, height: strip },
      contentRect: { x: rect.x, y: rect.y + strip, width: rect.width, height: Math.max(0, rect.height - strip) },
    });
    return;
  }

  const [firstNode, secondNode] = node.children;
  const minA = subtreeMinSize(firstNode);
  const minB = subtreeMinSize(secondNode);
  const sash = LAYOUT_LIMITS.sashSize;

  if (node.orientation === 'horizontal') {
    const avail = rect.width - sash;
    const first = firstChildLength(avail, node.ratio, minA.width, minB.width);
    const second = Math.max(minB.width, avail - first);
    layoutNode(firstNode, { x: rect.x, y: rect.y, width: first, height: rect.height }, panes, sashes);
    sashes.push({
      id: node.id,
      splitId: node.id,
      orientation: node.orientation,
      rect: { x: rect.x + first, y: rect.y, width: sash, height: rect.height },
      splitRect: { ...rect },
    });
    layoutNode(secondNode, { x: rect.x + first + sash, y: rect.y, width: second, height: rect.height }, panes, sashes);
    return;
  }

  const avail = rect.height - sash;
  const first = firstChildLength(avail, node.ratio, minA.height, minB.height);
  const second = Math.max(minB.height, avail - first);
  layoutNode(firstNode, { x: rect.x, y: rect.y, width: rect.width, height: first }, panes, sashes);
  sashes.push({
    id: node.id,
    splitId: node.id,
    orientation: node.orientation,
    rect: { x: rect.x, y: rect.y + first, width: rect.width, height: sash },
    splitRect: { ...rect },
  });
  layoutNode(secondNode, { x: rect.x, y: rect.y + first + sash, width: rect.width, height: second }, panes, sashes);
}

/**
 * pane 마다 stripRect(위 · stripHeight) · contentRect(아래), split 마다 sash 하나(sash.id = split.id).
 * 모든 값은 정수(viewport 를 먼저 Math.round). 가로로 나눈 두 자식 너비 + sash = 부모 너비(1px 틈 없음).
 * viewport 가 최소 크기보다 작으면 둘째 자식을 숨기지 않고 최소값으로 두어 넘치게 둔다.
 */
export function computeGeometry(tree: LayoutTree, viewport: Rect): LayoutGeometry {
  const panes: PaneGeometry[] = [];
  const sashes: SashGeometry[] = [];
  layoutNode(tree.root, roundRect(viewport), panes, sashes);
  return { panes, sashes };
}
