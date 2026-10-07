// RD-a — layout.json v1 → v2 이전 · v2 왕복 · 사이드바 폭 자르기 · 깨진 파일 · pane 영역 계산(computePaneViewport)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePaneViewport, LAYOUT_LIMITS, SHELL_SIDEBAR_ENABLED, type LayoutFileV2, type LayoutTree, type Rect } from '@cmh-hub-app/contracts';
import { LayoutEngine } from './layout-engine.js';
import { DEFAULT_SIDEBAR, layoutFileFromTree, LayoutStore, layoutTreeFromFile, migrateLayoutFile } from './layout-store.js';

/** v1 고정 파일(2026-10-07 전 앱이 쓰던 꼴 — LayoutTree 그대로) */
const V1_FILE = {
  version: 1,
  root: {
    type: 'split',
    id: 's1',
    orientation: 'horizontal',
    ratio: 0.35,
    children: [
      { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
      { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
    ],
  },
  tabs: {
    t1: { id: 't1', kind: 'admin', url: 'https://example.test/admin#/sw/dashboard/index', title: 'Dashboard', favicon: null, loading: false },
    t2: { id: 't2', kind: 'web', url: 'https://example.org/', title: 'Example', favicon: 'https://example.org/f.ico', loading: true },
    t3: { id: 't3', kind: 'admin', url: 'https://example.test/admin#/cmh/ai/chat-solo', title: 'AI 채팅', favicon: null, loading: false },
  },
  focusedPaneId: 'p2',
} as const;

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cmh-layout-v2-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function storeWith(content: string): Promise<{ store: LayoutStore; file: string }> {
  const file = join(dir, 'layout.json');
  await writeFile(file, content, 'utf8');
  return { store: new LayoutStore(file, 1), file };
}

describe('LayoutStore v1 → v2', () => {
  it('v1 파일 → v2: 트리 · 탭 · 활성 탭 · 포커스 그대로 · sidebar 기본값 · owner user', async () => {
    const { store, file } = await storeWith(JSON.stringify(V1_FILE));
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    const v2 = loaded!;
    expect(v2.version).toBe(2);
    expect(v2.sidebar).toEqual({ collapsed: false, width: 252 });
    expect(v2.tree).toEqual(V1_FILE.root);
    expect(v2.focusedPaneId).toBe('p2');
    expect(v2.agentTabIds).toBeUndefined();
    for (const [id, tab] of Object.entries(V1_FILE.tabs)) expect(v2.tabs[id]).toEqual({ ...tab, owner: 'user' });
    expect(store.getSidebar()).toEqual(DEFAULT_SIDEBAR);
    // 읽기만으로는 파일을 다시 쓰지 않는다(v1 그대로 남음)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(V1_FILE);

    // 엔진에 넣으면 같은 모양 · 활성 탭 t2 · 포커스 p2
    const e = new LayoutEngine();
    expect(e.loadTree(layoutTreeFromFile(v2))).toBe(true);
    expect(e.getPane('p1')?.activeTabId).toBe('t2');
    expect(e.getTree().focusedPaneId).toBe('p2');
    expect(e.paneCount()).toBe(2);
  });

  it('v1 을 읽고 저장하면 v2 로 쓴다', async () => {
    const { store, file } = await storeWith(JSON.stringify(V1_FILE));
    const v2 = (await store.load())!;
    store.save(layoutTreeFromFile(v2));
    await store.flush();
    const written = JSON.parse(await readFile(file, 'utf8')) as LayoutFileV2;
    expect(written).toEqual(v2);
    expect(written.version).toBe(2);
  });
});

describe('LayoutStore v2', () => {
  it('v2 왕복 — 사이드바 · owner · agentTabIds 보존', async () => {
    const file = join(dir, 'nested', 'layout.json');
    const store = new LayoutStore(file, 1);
    const tree: LayoutTree = {
      version: 1,
      root: V1_FILE.root as unknown as LayoutTree['root'],
      tabs: {
        t1: { ...V1_FILE.tabs.t1 },
        t2: { ...V1_FILE.tabs.t2, owner: 'agent' },
        t3: { ...V1_FILE.tabs.t3, owner: 'user' },
      },
      focusedPaneId: 'p1',
    };
    store.setSidebar({ collapsed: true, width: 300 });
    store.save(tree);
    await store.flush();
    const written = JSON.parse(await readFile(file, 'utf8')) as LayoutFileV2;
    expect(written.version).toBe(2);
    expect(written.sidebar).toEqual({ collapsed: true, width: 300 });
    expect(written.agentTabIds).toEqual(['t2']);
    expect(written.tabs['t1']?.owner).toBe('user');

    const again = new LayoutStore(file, 1);
    expect(await again.load()).toEqual(written);
    expect(again.getSidebar()).toEqual({ collapsed: true, width: 300 });
    expect(layoutTreeFromFile(written)).toEqual({ ...tree, tabs: { ...tree.tabs, t1: { ...tree.tabs['t1']!, owner: 'user' } } });
  });

  it('agentTabIds — tabs 에 없는 id · 겹침은 버리고 든 탭은 owner agent', () => {
    const v2 = migrateLayoutFile({
      version: 2,
      sidebar: { collapsed: false, width: 252 },
      tree: V1_FILE.root,
      tabs: V1_FILE.tabs,
      focusedPaneId: 'p1',
      agentTabIds: ['t3', 'ghost', 't3', 7],
    });
    expect(v2?.agentTabIds).toEqual(['t3']);
    expect(v2?.tabs['t3']?.owner).toBe('agent');
    expect(v2?.tabs['t1']?.owner).toBe('user');
  });

  it('사이드바 폭은 180 ~ 400 으로 자른다(읽기 · setSidebar 둘 다) · 틀린 칸은 기본값', async () => {
    const base = { version: 2, tree: V1_FILE.root, tabs: V1_FILE.tabs, focusedPaneId: 'p1' };
    expect(migrateLayoutFile({ ...base, sidebar: { collapsed: false, width: 50 } })?.sidebar.width).toBe(LAYOUT_LIMITS.sidebarWidthMin);
    expect(migrateLayoutFile({ ...base, sidebar: { collapsed: false, width: 9999 } })?.sidebar.width).toBe(LAYOUT_LIMITS.sidebarWidthMax);
    expect(migrateLayoutFile({ ...base, sidebar: { collapsed: false, width: 260.6 } })?.sidebar.width).toBe(261);
    expect(migrateLayoutFile({ ...base, sidebar: { collapsed: 'yes', width: 'wide' } })?.sidebar).toEqual(DEFAULT_SIDEBAR);
    expect(migrateLayoutFile(base)?.sidebar).toEqual(DEFAULT_SIDEBAR);

    const store = new LayoutStore(join(dir, 'x.json'), 1);
    store.setSidebar({ collapsed: false, width: 10 });
    expect(store.getSidebar().width).toBe(180);
    store.setSidebar({ collapsed: true, width: 1000 });
    expect(store.getSidebar()).toEqual({ collapsed: true, width: 400 });
    store.setSidebar({ collapsed: false, width: Number.NaN });
    expect(store.getSidebar().width).toBe(252);
  });

  it('store→engine→store 왕복에서 owner · agentTabIds 유지', async () => {
    // 파일: t3 · t2 가 에이전트 탭(차례 t3 → t2) · t1 은 사람
    const fileJson = {
      version: 2,
      sidebar: { collapsed: true, width: 300 },
      tree: V1_FILE.root,
      tabs: { t1: { ...V1_FILE.tabs.t1, owner: 'user' }, t2: { ...V1_FILE.tabs.t2, owner: 'agent' }, t3: { ...V1_FILE.tabs.t3, owner: 'agent' } },
      focusedPaneId: 'p1',
      agentTabIds: ['t3', 't2'],
    };
    const { store, file } = await storeWith(JSON.stringify(fileJson));
    const loaded = (await store.load())!;

    // 실제 엔진을 지나면 owner 가 사라진다(엔진은 고치지 않는다 · 합의안 6) — 그래도 저장 파일에는 남아야 한다
    const e = new LayoutEngine();
    expect(e.loadTree(layoutTreeFromFile(loaded))).toBe(true);
    expect(e.getTab('t2')?.owner).toBeUndefined();
    // 엔진에서 탭 하나 닫고(t2) · 새 탭 하나 열기
    expect(e.apply({ cmd: 'closeTab', tabId: 't2' }, { newTab: { kind: 'admin', url: 'https://example.test/admin' } }).rejected).toBeNull();
    const created = e.apply({ cmd: 'newTab', paneId: 'p2', kind: 'web', url: 'about:blank' }, { newTab: { kind: 'admin', url: 'https://example.test/admin' } });
    const newId = created.createdTabIds[0]!;

    store.save(e.getTree());
    await store.flush();
    const written = JSON.parse(await readFile(file, 'utf8')) as LayoutFileV2;
    expect(written.tabs['t1']?.owner).toBe('user');
    expect(written.tabs['t3']?.owner).toBe('agent');
    expect(written.tabs['t2']).toBeUndefined(); // 엔진에서 사라진 탭은 버린다
    expect(written.tabs[newId]?.owner).toBe('user'); // 새 탭은 user
    expect(written.agentTabIds).toEqual(['t3']);
    expect(written.sidebar).toEqual({ collapsed: true, width: 300 });

    // 한 번 더 왕복(저장한 파일 → 새 store → 엔진 → 저장)해도 그대로
    const again = new LayoutStore(file, 1);
    const reloaded = (await again.load())!;
    const e2 = new LayoutEngine();
    expect(e2.loadTree(layoutTreeFromFile(reloaded))).toBe(true);
    again.save(e2.getTree());
    await again.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(written);
  });

  it('agentTabIds 차례 — 기억한 차례 먼저 · 기억에 없는 agent 탭은 뒤에 · 트리에 적힌 owner 가 기억보다 앞선다', () => {
    const tree: LayoutTree = {
      version: 1,
      root: V1_FILE.root as unknown as LayoutTree['root'],
      tabs: { t1: { ...V1_FILE.tabs.t1, owner: 'agent' }, t2: { ...V1_FILE.tabs.t2 }, t3: { ...V1_FILE.tabs.t3, owner: 'user' } },
      focusedPaneId: 'p1',
    };
    const remembered = { owners: new Map([['t2', 'agent' as const], ['t3', 'agent' as const], ['gone', 'agent' as const]]), agentTabIds: ['gone', 't3', 't2'] };
    const out = layoutFileFromTree(tree, DEFAULT_SIDEBAR, remembered);
    expect(out.agentTabIds).toEqual(['t2', 't1']);
    expect(Object.fromEntries(Object.entries(out.tabs).map(([k, t]) => [k, t.owner]))).toEqual({ t1: 'agent', t2: 'agent', t3: 'user' });
  });

  it('엔진 트리 → v2 → 엔진: 같은 트리(split 동작 그대로)', () => {
    const e = new LayoutEngine();
    e.resetToDefault({ kind: 'admin', url: 'https://example.test/admin', title: 'Admin' });
    const pane = e.listPanes()[0]!;
    e.apply({ cmd: 'split', paneId: pane.id, orientation: 'vertical' }, { newTab: { kind: 'admin', url: 'https://example.test/admin' } });
    const file = JSON.parse(JSON.stringify(layoutFileFromTree(e.getTree()))) as unknown;
    const v2 = migrateLayoutFile(file);
    const back = new LayoutEngine();
    expect(back.loadTree(layoutTreeFromFile(v2!))).toBe(true);
    expect(back.getTree()).toEqual(e.getTree());
  });
});

describe('LayoutStore 읽기 실패 → null · 원본 남음', () => {
  it.each([
    ['알 수 없는 version', JSON.stringify({ ...V1_FILE, version: 3 })],
    ['version 없음', JSON.stringify({ root: V1_FILE.root, tabs: V1_FILE.tabs })],
    ['깨진 JSON', '{ "version": 2, "tree": '],
    ['JSON 이 배열', '[1,2]'],
    ['v2 인데 tree 없음', JSON.stringify({ version: 2, sidebar: DEFAULT_SIDEBAR, tabs: V1_FILE.tabs, focusedPaneId: null })],
    ['tabs 안 탭이 객체가 아님', JSON.stringify({ ...V1_FILE, tabs: { t1: 'x' } })],
  ])('%s', async (_name, content) => {
    const { store, file } = await storeWith(content);
    expect(await store.load()).toBeNull();
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(store.getSidebar()).toEqual(DEFAULT_SIDEBAR);
  });

  it('파일 없음 → null', async () => {
    expect(await new LayoutStore(join(dir, 'none.json'), 1).load()).toBeNull();
  });
});

describe('computePaneViewport', () => {
  const WIN: Rect = { x: 0, y: 0, width: 1440, height: 900 };
  const open = { collapsed: false, width: 252 };

  it('스위치가 꺼져 있으면 옛 viewport 와 같다 — 제목 줄만 뺌 · 지금 앱은 켜짐(RD 셸 사이드바 · 2026-10-07)', () => {
    expect(SHELL_SIDEBAR_ENABLED).toBe(true);
    expect(LAYOUT_LIMITS.statusBarHeight).toBe(0);
    expect(computePaneViewport(WIN, LAYOUT_LIMITS, open, SHELL_SIDEBAR_ENABLED)).toEqual({ x: 252, y: 40, width: 1440 - 252, height: 860 });
    expect(computePaneViewport(WIN, LAYOUT_LIMITS, open, false)).toEqual({
      x: 0,
      y: LAYOUT_LIMITS.titleBarHeight,
      width: 1440,
      height: 900 - LAYOUT_LIMITS.titleBarHeight,
    });
  });

  it('사이드바 펼침 → 왼쪽에서 폭만큼 · 접힘 → 0', () => {
    expect(computePaneViewport(WIN, LAYOUT_LIMITS, open, true)).toEqual({ x: 252, y: 40, width: 1440 - 252, height: 860 });
    expect(computePaneViewport(WIN, LAYOUT_LIMITS, { collapsed: true, width: 252 }, true)).toEqual({ x: 0, y: 40, width: 1440, height: 860 });
  });

  it('상태 줄 높이를 아래에서 뺀다 · 폭은 min ~ max 로 자른다', () => {
    const limits = { titleBarHeight: 40, statusBarHeight: 28 };
    expect(computePaneViewport(WIN, limits, { collapsed: false, width: 1000 }, true)).toEqual({ x: 400, y: 40, width: 1040, height: 900 - 40 - 28 });
    expect(computePaneViewport(WIN, limits, { collapsed: false, width: 10 }, true).x).toBe(180);
  });

  it('창이 사이드바보다 좁거나 제목 줄보다 낮아도 0 아래로 안 간다', () => {
    const tiny: Rect = { x: 0, y: 0, width: 150, height: 30 };
    expect(computePaneViewport(tiny, LAYOUT_LIMITS, open, true)).toEqual({ x: 150, y: 40, width: 0, height: 0 });
    expect(computePaneViewport({ x: 0, y: 0, width: 0, height: 0 }, LAYOUT_LIMITS, open, true)).toEqual({ x: 0, y: 40, width: 0, height: 0 });
  });

  it('창 원점이 0 이 아니어도 그 위에서 센다', () => {
    expect(computePaneViewport({ x: 10, y: 5, width: 800, height: 600 }, LAYOUT_LIMITS, open, true)).toEqual({ x: 262, y: 45, width: 548, height: 560 });
  });
});
