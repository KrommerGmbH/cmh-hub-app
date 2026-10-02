import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_LIMITS, type LayoutGeometry, type LayoutTree, type NewTabSpec, type Rect } from '@cmh-hub-app/contracts';
import { LayoutEngine } from './layout-engine.js';
import { computeGeometry } from './layout-rect.js';
import { LayoutStore } from './layout-store.js';

const ADMIN: NewTabSpec = { kind: 'admin', url: 'https://example.test/admin', title: 'Admin' };
const VIEWPORT: Rect = { x: 0, y: 40, width: 1440, height: 860 };

function engineWithOnePane(): LayoutEngine {
  const e = new LayoutEngine();
  e.resetToDefault(ADMIN);
  return e;
}

function rootPaneId(e: LayoutEngine): string {
  return e.listPanes()[0]!.id;
}

/** 가로 split 두 자식 너비 + sash = 부모 너비 · 세로도 같다(1px 틈 없음) */
function assertNoGaps(tree: LayoutTree, geometry: LayoutGeometry): void {
  for (const sash of geometry.sashes) {
    const node = findSplit(tree, sash.splitId)!;
    const [a, b] = node.children;
    const ra = rectOf(geometry, a.id, tree);
    const rb = rectOf(geometry, b.id, tree);
    if (sash.orientation === 'horizontal') {
      expect(ra.width + sash.rect.width + rb.width).toBe(sash.splitRect.width);
      expect(ra.x + ra.width).toBe(sash.rect.x);
      expect(sash.rect.x + sash.rect.width).toBe(rb.x);
    } else {
      expect(ra.height + sash.rect.height + rb.height).toBe(sash.splitRect.height);
      expect(ra.y + ra.height).toBe(sash.rect.y);
      expect(sash.rect.y + sash.rect.height).toBe(rb.y);
    }
  }
}

function findSplit(tree: LayoutTree, id: string) {
  const walk = (n: LayoutTree['root']): Extract<LayoutTree['root'], { type: 'split' }> | undefined => {
    if (n.type === 'pane') return undefined;
    if (n.id === id) return n;
    return walk(n.children[0]) ?? walk(n.children[1]);
  };
  return walk(tree.root);
}

/** 노드(pane 또는 split)가 차지하는 자리 — pane 은 strip+content, split 은 그 sash 의 splitRect */
function rectOf(geometry: LayoutGeometry, nodeId: string, tree: LayoutTree): Rect {
  const pane = geometry.panes.find((p) => p.paneId === nodeId);
  if (pane) {
    return { x: pane.stripRect.x, y: pane.stripRect.y, width: pane.stripRect.width, height: pane.stripRect.height + pane.contentRect.height };
  }
  const sash = geometry.sashes.find((s) => s.splitId === nodeId);
  if (!sash) throw new Error(`rect 없음: ${nodeId}`);
  void tree;
  return sash.splitRect;
}

describe('LayoutEngine', () => {
  it('split → pane 2 · 탭 2 · 새 pane 이 포커스', () => {
    const e = engineWithOnePane();
    const change = e.apply({ cmd: 'split', paneId: rootPaneId(e), orientation: 'horizontal' }, { newTab: ADMIN });
    expect(change.rejected).toBeNull();
    expect(change.createdTabIds).toHaveLength(1);
    expect(change.geometryChanged).toBe(true);
    expect(e.paneCount()).toBe(2);
    expect(Object.keys(e.getTree().tabs)).toHaveLength(2);
    expect(e.getTree().focusedPaneId).toBe(change.focusedPaneId);
  });

  it('pane 5번째 split 은 거절 · 트리 불변', () => {
    const e = engineWithOnePane();
    for (let i = 0; i < 3; i++) {
      const paneId = e.getTree().focusedPaneId!;
      expect(e.apply({ cmd: 'split', paneId, orientation: i % 2 ? 'vertical' : 'horizontal' }, { newTab: ADMIN }).rejected).toBeNull();
    }
    expect(e.paneCount()).toBe(LAYOUT_LIMITS.maxPanes);
    const before = JSON.stringify(e.getTree());
    const r = e.apply({ cmd: 'split', paneId: e.getTree().focusedPaneId!, orientation: 'horizontal' }, { newTab: ADMIN });
    expect(r.rejected).toMatch(/상한/);
    expect(JSON.stringify(e.getTree())).toBe(before);
  });

  it('마지막 탭 닫기 → pane 닫힘 · 형제 승격', () => {
    const e = engineWithOnePane();
    const first = rootPaneId(e);
    const split = e.apply({ cmd: 'split', paneId: first, orientation: 'horizontal' }, { newTab: ADMIN });
    const newTabId = split.createdTabIds[0]!;
    const r = e.apply({ cmd: 'closeTab', tabId: newTabId }, { newTab: ADMIN });
    expect(r.closedTabIds).toEqual([newTabId]);
    expect(r.closedPaneIds).toHaveLength(1);
    expect(e.paneCount()).toBe(1);
    expect(e.getTree().root.type).toBe('pane');
    expect(e.getTree().root.id).toBe(first);
    expect(e.getTree().focusedPaneId).toBe(first);
  });

  it('마지막 pane 의 마지막 탭은 닫지 않고 새 탭으로 채운다', () => {
    const e = engineWithOnePane();
    const tabId = e.listPanes()[0]!.tabIds[0]!;
    const r = e.apply({ cmd: 'closeTab', tabId }, { newTab: ADMIN });
    expect(r.closedTabIds).toEqual([tabId]);
    expect(r.createdTabIds).toHaveLength(1);
    expect(e.paneCount()).toBe(1);
    expect(e.listPanes()[0]!.tabIds).toHaveLength(1);
  });

  it('moveTab 으로 비는 pane 은 닫힌다', () => {
    const e = engineWithOnePane();
    const first = rootPaneId(e);
    const split = e.apply({ cmd: 'split', paneId: first, orientation: 'vertical' }, { newTab: ADMIN });
    const movedTab = split.createdTabIds[0]!;
    const r = e.apply({ cmd: 'moveTab', tabId: movedTab, toPaneId: first, index: 0 }, { newTab: ADMIN });
    expect(r.rejected).toBeNull();
    expect(r.closedPaneIds).toHaveLength(1);
    expect(e.paneCount()).toBe(1);
    expect(e.listPanes()[0]!.tabIds[0]).toBe(movedTab);
    expect(e.listPanes()[0]!.activeTabId).toBe(movedTab);
  });

  it('resize 는 0.2~0.8 과 최소 너비 320 을 지킨다', () => {
    const e = engineWithOnePane();
    e.apply({ cmd: 'split', paneId: rootPaneId(e), orientation: 'horizontal' }, { newTab: ADMIN });
    e.computeGeometry(VIEWPORT);
    const sashId = e.computeGeometry(VIEWPORT).sashes[0]!.id;
    expect(e.apply({ cmd: 'resize', sashId, ratio: 0.05 }, { newTab: ADMIN }).geometryChanged).toBe(true);
    const g = e.computeGeometry(VIEWPORT);
    const left = g.panes.find((p) => p.stripRect.x === 0)!;
    expect(left.stripRect.width).toBeGreaterThanOrEqual(LAYOUT_LIMITS.minPaneWidth);
    // 좁은 창: 둘 다 320 을 못 지키면 ratio 상하한만
    const narrow: Rect = { x: 0, y: 40, width: 500, height: 400 };
    e.computeGeometry(narrow);
    e.apply({ cmd: 'resize', sashId, ratio: 0.9 }, { newTab: ADMIN });
    const ratio = findSplit(e.getTree(), sashId)!.ratio;
    expect(ratio).toBeLessThanOrEqual(LAYOUT_LIMITS.maxRatio);
    expect(ratio).toBeGreaterThanOrEqual(LAYOUT_LIMITS.minRatio);
  });

  it('geometry: 1px 틈 없음(가로 · 세로 · 중첩) · 스트립 40 · 모두 정수', () => {
    const e = engineWithOnePane();
    const a = rootPaneId(e);
    const s1 = e.apply({ cmd: 'split', paneId: a, orientation: 'horizontal' }, { newTab: ADMIN });
    const b = s1.focusedPaneId!;
    e.apply({ cmd: 'split', paneId: b, orientation: 'vertical' }, { newTab: ADMIN });
    e.apply({ cmd: 'split', paneId: a, orientation: 'vertical' }, { newTab: ADMIN });
    const tree = e.getTree();
    const g = computeGeometry(tree, { x: 0, y: 40, width: 1437, height: 861 });
    expect(g.panes).toHaveLength(4);
    assertNoGaps(tree, g);
    for (const p of g.panes) {
      expect(p.stripRect.height).toBe(LAYOUT_LIMITS.stripHeight);
      expect(p.contentRect.y).toBe(p.stripRect.y + LAYOUT_LIMITS.stripHeight);
      for (const v of [...Object.values(p.stripRect), ...Object.values(p.contentRect)]) expect(Number.isInteger(v)).toBe(true);
    }
    expect(g.sashes.every((s) => Number.isInteger(s.rect.x) && Number.isInteger(s.rect.width))).toBe(true);
  });

  it('loadTree 는 틀린 모양을 거절하고 트리를 그대로 둔다', () => {
    const e = engineWithOnePane();
    const before = JSON.stringify(e.getTree());
    expect(e.loadTree(null)).toBe(false);
    expect(e.loadTree({ version: 2 })).toBe(false);
    expect(e.loadTree({ version: 1, root: { type: 'pane', id: 'p', tabIds: ['t'], activeTabId: 't' }, tabs: {}, focusedPaneId: 'p' })).toBe(false);
    expect(e.loadTree({ version: 1, root: { type: 'split', id: 's', orientation: 'horizontal', ratio: 0.5, children: [] }, tabs: {}, focusedPaneId: null })).toBe(false);
    expect(JSON.stringify(e.getTree())).toBe(before);
    // 바른 모양은 받는다 · 다른 엔진의 트리를 그대로 옮긴다
    const e2 = engineWithOnePane();
    e2.apply({ cmd: 'split', paneId: rootPaneId(e2), orientation: 'horizontal' }, { newTab: ADMIN });
    expect(e.loadTree(JSON.parse(JSON.stringify(e2.getTree())))).toBe(true);
    expect(e.paneCount()).toBe(2);
  });
});

describe('LayoutStore', () => {
  it('저장 → 읽기 같음 · 깨진 파일 → null · 없는 파일 → null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cmh-layout-'));
    const file = join(dir, 'nested', 'layout.json');
    try {
      const store = new LayoutStore(file, 1);
      expect(await store.load()).toBeNull();
      const e = engineWithOnePane();
      store.save(e.getTree());
      await store.flush();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(e.getTree());
      expect(await store.load()).toEqual(e.getTree());
      const broken = new LayoutStore(join(dir, 'broken.json'), 1);
      await (await import('node:fs/promises')).writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
      expect(await broken.load()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
