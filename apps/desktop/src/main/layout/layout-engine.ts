// U02 · U03 — 레이아웃 트리의 정본. 셸 명령(ShellCommand)을 받아 트리를 바꾸고 무엇이 바뀌었는지(LayoutChange)를 돌려준다.
import { randomUUID } from 'node:crypto';
import type {
  LayoutChange,
  LayoutEngineApi,
  LayoutGeometry,
  LayoutNode,
  LayoutTree,
  NewTabSpec,
  Orientation,
  PaneNode,
  Rect,
  ShellCommand,
  SplitNode,
  TabRecord,
} from '@cmh-hub-app/contracts';
import { LAYOUT_LIMITS, LAYOUT_PRESET_PANES, type LayoutPreset } from '@cmh-hub-app/contracts';
import { computeGeometry, subtreeMinSize } from './layout-rect.js';

/** 트리 모양 → 레이아웃 고르기 이름(비율은 안 본다) · 메뉴 밖 모양이면 null */
export function detectLayoutPreset(root: LayoutNode): LayoutPreset | null {
  const isPane = (n: LayoutNode): boolean => n.type === 'pane';
  const isSplitOfPanes = (n: LayoutNode, o: Orientation): boolean => n.type === 'split' && n.orientation === o && isPane(n.children[0]) && isPane(n.children[1]);
  if (isPane(root)) return 'single';
  if (root.type !== 'split') return null;
  const [a, b] = root.children;
  if (isSplitOfPanes(root, 'horizontal')) return 'columns2';
  if (isSplitOfPanes(root, 'vertical')) return 'rows2';
  if (root.orientation === 'horizontal') {
    // 좌우로 먼저 나눈 뒤 양쪽을 위아래로 나눈 2×2 도 4단이다(제미나이 검수 2026-10-04)
    if (isSplitOfPanes(a, 'vertical') && isSplitOfPanes(b, 'vertical')) return 'grid4';
    if (isSplitOfPanes(a, 'vertical') && isPane(b)) return 'left2right1';
    if (isPane(a) && isSplitOfPanes(b, 'vertical')) return 'left1right2';
    return null;
  }
  if (isSplitOfPanes(a, 'horizontal') && isPane(b)) return 'top2bottom1';
  if (isPane(a) && isSplitOfPanes(b, 'horizontal')) return 'top1bottom2';
  if (isSplitOfPanes(a, 'horizontal') && isSplitOfPanes(b, 'horizontal')) return 'grid4';
  return null;
}

interface ParentRef {
  parent: SplitNode;
  index: 0 | 1;
}

function emptyChange(focusedPaneId: string | null): LayoutChange {
  return {
    createdTabIds: [],
    closedTabIds: [],
    closedPaneIds: [],
    activeChangedPaneIds: [],
    focusedPaneId,
    geometryChanged: false,
    rejected: null,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class LayoutEngine implements LayoutEngineApi {
  private tree: LayoutTree;
  /** 마지막 computeGeometry 의 viewport — resize 가 최소 pane 크기를 px 로 셀 때 쓴다 */
  private lastViewport: Rect | null = null;

  constructor() {
    // 호출한 쪽이 loadTree 또는 resetToDefault 를 부르기 전의 빈 자리(탭 0)
    const paneId = randomUUID();
    this.tree = {
      version: 1,
      root: { type: 'pane', id: paneId, tabIds: [], activeTabId: null },
      tabs: {},
      focusedPaneId: paneId,
    };
  }

  // ───────────────────────── 읽기 ─────────────────────────

  getTree(): LayoutTree {
    return structuredClone(this.tree);
  }

  listPanes(): PaneNode[] {
    return this.collectPanes(this.tree.root).map((p) => structuredClone(p));
  }

  getPane(paneId: string): PaneNode | undefined {
    const p = this.findPane(paneId);
    return p ? structuredClone(p) : undefined;
  }

  getTab(tabId: string): TabRecord | undefined {
    const t = this.tree.tabs[tabId];
    return t ? { ...t } : undefined;
  }

  getPaneOfTab(tabId: string): PaneNode | undefined {
    const p = this.findPaneOfTab(tabId);
    return p ? structuredClone(p) : undefined;
  }

  paneCount(): number {
    return this.collectPanes(this.tree.root).length;
  }

  computeGeometry(viewport: Rect): LayoutGeometry {
    this.lastViewport = { ...viewport };
    return computeGeometry(this.tree, viewport);
  }

  // ───────────────────────── 쓰기 ─────────────────────────

  updateTab(tabId: string, patch: Partial<Omit<TabRecord, 'id' | 'kind'>>): void {
    const t = this.tree.tabs[tabId];
    if (!t) return;
    if (patch.url !== undefined) t.url = patch.url;
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.favicon !== undefined) t.favicon = patch.favicon;
    if (patch.loading !== undefined) t.loading = patch.loading;
  }

  resetToDefault(firstTab: NewTabSpec): void {
    const tab = this.makeTab(firstTab);
    const paneId = randomUUID();
    this.tree = {
      version: 1,
      root: { type: 'pane', id: paneId, tabIds: [tab.id], activeTabId: tab.id },
      tabs: { [tab.id]: tab },
      focusedPaneId: paneId,
    };
  }

  /** 모양을 손으로 검사한다. 틀리면 false · 트리는 그대로(호출한 쪽이 resetToDefault 를 부른다) */
  loadTree(input: unknown): boolean {
    if (!isRecord(input) || input['version'] !== 1) return false;

    const rawTabs = input['tabs'];
    if (!isRecord(rawTabs)) return false;
    const tabs: Record<string, TabRecord> = {};
    for (const [key, raw] of Object.entries(rawTabs)) {
      if (!isRecord(raw)) return false;
      const { id, kind, url, title, favicon } = raw;
      if (id !== key) return false;
      if (kind !== 'admin' && kind !== 'naver') return false;
      if (typeof url !== 'string' || typeof title !== 'string') return false;
      if (favicon !== null && typeof favicon !== 'string') return false;
      // loading 은 지난 실행의 값이라 버린다(복원 직후엔 아직 안 불렀다)
      tabs[key] = { id, kind, url, title, favicon, loading: false };
    }

    const seenTabIds = new Set<string>();
    const seenNodeIds = new Set<string>();
    let paneCount = 0;

    const parseNode = (raw: unknown): LayoutNode | null => {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || raw['id'] === '') return null;
      const id = raw['id'];
      if (seenNodeIds.has(id)) return null;
      seenNodeIds.add(id);

      if (raw['type'] === 'pane') {
        const tabIds = raw['tabIds'];
        if (!Array.isArray(tabIds) || tabIds.length === 0) return null; // 빈 pane 은 없다
        const ids: string[] = [];
        for (const t of tabIds) {
          if (typeof t !== 'string' || !(t in tabs) || seenTabIds.has(t)) return null;
          seenTabIds.add(t);
          ids.push(t);
        }
        const active = raw['activeTabId'];
        let activeTabId: string;
        if (typeof active === 'string' && ids.includes(active)) activeTabId = active;
        else if (active === null || typeof active === 'string') activeTabId = ids[0] as string;
        else return null;
        paneCount++;
        return { type: 'pane', id, tabIds: ids, activeTabId };
      }

      if (raw['type'] === 'split') {
        const orientation = raw['orientation'];
        if (orientation !== 'horizontal' && orientation !== 'vertical') return null;
        const ratio = raw['ratio'];
        if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
        const children = raw['children'];
        if (!Array.isArray(children) || children.length !== 2) return null;
        const a = parseNode(children[0]);
        if (!a) return null;
        const b = parseNode(children[1]);
        if (!b) return null;
        return {
          type: 'split',
          id,
          orientation,
          ratio: clamp(ratio, LAYOUT_LIMITS.minRatio, LAYOUT_LIMITS.maxRatio),
          children: [a, b],
        };
      }
      return null;
    };

    const root = parseNode(input['root']);
    if (!root) return false;
    if (paneCount > LAYOUT_LIMITS.maxPanes) return false;
    // 어느 pane 에도 없는 탭이 있으면 틀린 트리
    if (seenTabIds.size !== Object.keys(tabs).length) return false;

    const focused = input['focusedPaneId'];
    if (focused !== null && typeof focused !== 'string') return false;
    const panes = this.collectPanes(root);
    const focusedPaneId =
      typeof focused === 'string' && panes.some((p) => p.id === focused) ? focused : (panes[0]?.id ?? null);

    this.tree = { version: 1, root, tabs, focusedPaneId };
    return true;
  }

  apply(cmd: ShellCommand, defaults: { newTab: NewTabSpec }): LayoutChange {
    switch (cmd.cmd) {
      case 'split':
        return this.split(cmd.paneId, cmd.orientation, defaults.newTab);
      case 'closePane':
        return this.closePane(cmd.paneId, defaults.newTab);
      case 'moveTab':
        return this.moveTab(cmd.tabId, cmd.toPaneId, cmd.index);
      case 'reorderTab':
        return this.reorderTab(cmd.tabId, cmd.index);
      case 'focusPane':
        return this.focusPane(cmd.paneId);
      case 'resize':
        return this.resize(cmd.sashId, cmd.ratio);
      case 'newTab':
        return this.newTab(cmd.paneId, cmd.kind, cmd.url, defaults.newTab);
      case 'closeTab':
        return this.closeTab(cmd.tabId, defaults.newTab);
      case 'activateTab':
        return this.activateTab(cmd.tabId);
      case 'applyLayout':
        return this.applyLayout(cmd.preset, defaults.newTab);
      // 아래는 트리를 바꾸지 않는다 — window 쪽이 처리한다
      case 'shell.popup':
      case 'reloadTab':
      case 'aiTaskStop':
      case 'update.download':
      case 'update.install':
      case 'update.later':
      case 'window.minimize':
      case 'window.toggleMaximize':
      case 'window.close':
        return emptyChange(this.tree.focusedPaneId);
    }
  }

  // ───────────────────────── 명령 ─────────────────────────

  private split(paneId: string, orientation: Orientation, spec: NewTabSpec): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPane(paneId);
    if (!pane) return { ...change, rejected: `없는 pane: ${paneId}` };
    if (this.paneCount() >= LAYOUT_LIMITS.maxPanes) {
      return { ...change, rejected: `pane 상한 ${LAYOUT_LIMITS.maxPanes}` };
    }

    const tab = this.makeTab(spec);
    this.tree.tabs[tab.id] = tab;
    const newPane: PaneNode = { type: 'pane', id: randomUUID(), tabIds: [tab.id], activeTabId: tab.id };
    const splitNode: SplitNode = {
      type: 'split',
      id: randomUUID(),
      orientation,
      ratio: 0.5,
      children: [pane, newPane],
    };
    this.replaceNode(pane, splitNode);
    this.tree.focusedPaneId = newPane.id;

    change.createdTabIds.push(tab.id);
    change.activeChangedPaneIds.push(newPane.id);
    change.focusedPaneId = newPane.id;
    change.geometryChanged = true;
    return change;
  }

  private closePane(paneId: string, spec: NewTabSpec): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPane(paneId);
    if (!pane) return { ...change, rejected: `없는 pane: ${paneId}` };

    for (const t of pane.tabIds) {
      delete this.tree.tabs[t];
      change.closedTabIds.push(t);
    }
    pane.tabIds = [];
    pane.activeTabId = null;

    if (this.paneCount() === 1) {
      // 앱에 pane 0 은 없다 — 그 자리에 기본 새 탭
      this.refillLastPane(pane, spec, change);
      return change;
    }
    this.removePane(pane, change);
    return change;
  }

  private closeTab(tabId: string, spec: NewTabSpec): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPaneOfTab(tabId);
    if (!pane) return { ...change, rejected: `없는 탭: ${tabId}` };

    this.detachTab(pane, tabId, change);
    delete this.tree.tabs[tabId];
    change.closedTabIds.push(tabId);

    if (pane.tabIds.length === 0) {
      if (this.paneCount() === 1) this.refillLastPane(pane, spec, change);
      else this.removePane(pane, change);
    }
    return change;
  }

  private moveTab(tabId: string, toPaneId: string, index: number | undefined): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const from = this.findPaneOfTab(tabId);
    if (!from) return { ...change, rejected: `없는 탭: ${tabId}` };
    const to = this.findPane(toPaneId);
    if (!to) return { ...change, rejected: `없는 pane: ${toPaneId}` };

    if (from === to) {
      return this.reorderTab(tabId, index ?? to.tabIds.length - 1);
    }

    this.detachTab(from, tabId, change);
    const at = index === undefined ? to.tabIds.length : clamp(Math.trunc(index), 0, to.tabIds.length);
    to.tabIds.splice(at, 0, tabId);
    if (to.activeTabId !== tabId) {
      to.activeTabId = tabId;
      if (!change.activeChangedPaneIds.includes(to.id)) change.activeChangedPaneIds.push(to.id);
    }
    this.tree.focusedPaneId = to.id;
    change.focusedPaneId = to.id;
    change.geometryChanged = true;

    if (from.tabIds.length === 0) this.removePane(from, change);
    return change;
  }

  private reorderTab(tabId: string, index: number): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPaneOfTab(tabId);
    if (!pane) return { ...change, rejected: `없는 탭: ${tabId}` };
    const fromIdx = pane.tabIds.indexOf(tabId);
    pane.tabIds.splice(fromIdx, 1);
    const at = clamp(Math.trunc(index), 0, pane.tabIds.length);
    pane.tabIds.splice(at, 0, tabId);
    return change;
  }

  private focusPane(paneId: string): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    if (!this.findPane(paneId)) return { ...change, rejected: `없는 pane: ${paneId}` };
    this.tree.focusedPaneId = paneId;
    change.focusedPaneId = paneId;
    return change;
  }

  private activateTab(tabId: string): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPaneOfTab(tabId);
    if (!pane) return { ...change, rejected: `없는 탭: ${tabId}` };
    if (pane.activeTabId !== tabId) {
      pane.activeTabId = tabId;
      change.activeChangedPaneIds.push(pane.id);
    }
    this.tree.focusedPaneId = pane.id;
    change.focusedPaneId = pane.id;
    return change;
  }

  private newTab(
    paneId: string,
    kind: NewTabSpec['kind'] | undefined,
    url: string | undefined,
    spec: NewTabSpec,
  ): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const pane = this.findPane(paneId);
    if (!pane) return { ...change, rejected: `없는 pane: ${paneId}` };

    // url 을 주면 그 url · title 은 비운다(로드 뒤 updateTab). 안 주면 defaults.newTab 그대로
    const tabSpec: NewTabSpec =
      url !== undefined ? { kind: kind ?? spec.kind, url } : { ...spec, kind: kind ?? spec.kind };
    const tab = this.makeTab(tabSpec);
    this.tree.tabs[tab.id] = tab;
    pane.tabIds.push(tab.id);
    pane.activeTabId = tab.id;
    this.tree.focusedPaneId = pane.id;

    change.createdTabIds.push(tab.id);
    change.activeChangedPaneIds.push(pane.id);
    change.focusedPaneId = pane.id;
    return change;
  }

  private resize(sashId: string, ratio: number): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    const node = this.findNode(this.tree.root, sashId);
    if (!node || node.type !== 'split') return { ...change, rejected: `없는 sash: ${sashId}` };
    if (!Number.isFinite(ratio)) return { ...change, rejected: `ratio 가 숫자가 아님` };

    let r = clamp(ratio, LAYOUT_LIMITS.minRatio, LAYOUT_LIMITS.maxRatio);

    // split 자리를 알면(computeGeometry 를 한 번이라도 불렀으면) 두 자식의 최소 px 도 지킨다
    if (this.lastViewport) {
      const sash = computeGeometry(this.tree, this.lastViewport).sashes.find((s) => s.splitId === node.id);
      if (sash) {
        const horizontal = node.orientation === 'horizontal';
        const length = horizontal ? sash.splitRect.width : sash.splitRect.height;
        const avail = length - LAYOUT_LIMITS.sashSize;
        const minA = subtreeMinSize(node.children[0]);
        const minB = subtreeMinSize(node.children[1]);
        const minFirst = horizontal ? minA.width : minA.height;
        const minSecond = horizontal ? minB.width : minB.height;
        if (avail > 0) {
          const lo = minFirst / avail;
          const hi = 1 - minSecond / avail;
          // lo > hi = 자리가 모자라 둘 다 못 지킨다 → ratio 상하한만 지킨 값을 둔다(넘침은 computeGeometry 가 처리)
          if (lo <= hi) r = clamp(r, lo, hi);
        }
      }
    }

    if (r !== node.ratio) {
      node.ratio = r;
      change.geometryChanged = true;
    }
    return change;
  }

  /**
   * 레이아웃 고르기 — 지금 pane 을 왼쪽 위부터(트리 차례) 새 자리에 다시 앉힌다. 탭 · view 는 그대로(새로고침 없음).
   * pane 이 모자라면 기본 새 탭 하나로 채우고, 남으면 남는 pane 의 탭을 마지막 자리 pane 뒤에 붙인다(닫지 않는다).
   */
  private applyLayout(preset: LayoutPreset, spec: NewTabSpec): LayoutChange {
    const change = emptyChange(this.tree.focusedPaneId);
    // IPC 로 온 값은 검사 전 문자열이다 — 모르는 preset 이면 slice(undefined) 가 전체를 돌려 탭이 두 pane 에 들어간다(검수 2026-10-03)
    if (!Object.hasOwn(LAYOUT_PRESET_PANES, preset)) return { ...change, rejected: `없는 preset: ${String(preset)}` };
    const want = LAYOUT_PRESET_PANES[preset];
    // 창 하나에 탭 하나 이상 — 탭 수보다 창이 많은 모양은 고를 수 없다(빈 창을 새 어드민으로 채우지 않는다 · 2026-10-04 사장님 «탭이 3개인데 4단 분할이 가능»)
    const tabCount = Object.keys(this.tree.tabs).length;
    if (want > tabCount) return { ...change, rejected: `탭 ${tabCount}개로는 창 ${want}개를 못 채운다` };
    // 실패하면 트리를 되돌린다(아래 옮기기는 단계마다 트리를 바꾼다 · 제미나이 검수 2026-10-04)
    const snapshot = structuredClone(this.tree);
    const panes = this.collectPanes(this.tree.root);
    const kept = panes.slice(0, want);
    const merged = panes.slice(want);
    const last = kept[kept.length - 1];
    if (last) {
      for (const extra of merged) {
        last.tabIds.push(...extra.tabIds);
        change.closedPaneIds.push(extra.id);
      }
    }
    while (kept.length < want) {
      // 탭이 둘 이상인 pane 이 있으면 그 pane 의 «활성이 아닌 마지막 탭»을 새 pane 으로 옮긴다 — 새 어드민을 또 열지 않는다
      // (2026-10-04 사장님 «1번 창에 어드민 · 네이버 두 개 있고 2단 좌우 → 우측에 새로운 어드민이 열림»)
      const donor = kept.find((p) => p.tabIds.length > 1);
      if (donor) {
        const movable = [...donor.tabIds].reverse().find((id) => id !== donor.activeTabId);
        if (movable === undefined) {
          this.tree = snapshot;
          return { ...change, rejected: `applyLayout: 옮길 탭이 없다(탭 ${tabCount} · 창 ${want})` };
        }
        donor.tabIds = donor.tabIds.filter((id) => id !== movable);
        kept.push({ type: 'pane', id: randomUUID(), tabIds: [movable], activeTabId: movable });
        continue;
      }
      // 탭 수 검사(want ≤ 탭 수) 때문에 여기 오면 트리가 깨진 것이다 — 새 탭으로 채우지 않고 되돌린다(2026-10-04 «빈 창을 새 어드민으로 채우지 않는다»)
      this.tree = snapshot;
      return { ...change, rejected: `applyLayout: 탭이 둘 이상인 창이 없다(탭 ${tabCount} · 창 ${want})` };
    }
    const split = (orientation: Orientation, a: LayoutNode, b: LayoutNode): SplitNode => ({
      type: 'split', id: randomUUID(), orientation, ratio: 0.5, children: [a, b],
    });
    const [p0, p1, p2, p3] = kept as [PaneNode, PaneNode?, PaneNode?, PaneNode?];
    switch (preset) {
      case 'single':
        this.tree.root = p0;
        break;
      case 'columns2':
        this.tree.root = split('horizontal', p0, p1 as PaneNode);
        break;
      case 'rows2':
        this.tree.root = split('vertical', p0, p1 as PaneNode);
        break;
      case 'top2bottom1':
        this.tree.root = split('vertical', split('horizontal', p0, p1 as PaneNode), p2 as PaneNode);
        break;
      case 'top1bottom2':
        this.tree.root = split('vertical', p0, split('horizontal', p1 as PaneNode, p2 as PaneNode));
        break;
      case 'left2right1':
        this.tree.root = split('horizontal', split('vertical', p0, p1 as PaneNode), p2 as PaneNode);
        break;
      case 'left1right2':
        this.tree.root = split('horizontal', p0, split('vertical', p1 as PaneNode, p2 as PaneNode));
        break;
      case 'grid4':
        this.tree.root = split('vertical', split('horizontal', p0, p1 as PaneNode), split('horizontal', p2 as PaneNode, p3 as PaneNode));
        break;
    }
    if (!kept.some((p) => p.id === this.tree.focusedPaneId)) this.tree.focusedPaneId = p0.id;
    change.focusedPaneId = this.tree.focusedPaneId;
    change.activeChangedPaneIds = kept.map((p) => p.id);
    change.geometryChanged = true;
    return change;
  }

  // ───────────────────────── 트리 도우미 ─────────────────────────

  private makeTab(spec: NewTabSpec): TabRecord {
    return { id: randomUUID(), kind: spec.kind, url: spec.url, title: spec.title ?? '', favicon: null, loading: false };
  }

  private collectPanes(node: LayoutNode, out: PaneNode[] = []): PaneNode[] {
    if (node.type === 'pane') out.push(node);
    else {
      this.collectPanes(node.children[0], out);
      this.collectPanes(node.children[1], out);
    }
    return out;
  }

  private findNode(node: LayoutNode, id: string): LayoutNode | undefined {
    if (node.id === id) return node;
    if (node.type === 'pane') return undefined;
    return this.findNode(node.children[0], id) ?? this.findNode(node.children[1], id);
  }

  private findPane(paneId: string): PaneNode | undefined {
    const n = this.findNode(this.tree.root, paneId);
    return n && n.type === 'pane' ? n : undefined;
  }

  private findPaneOfTab(tabId: string): PaneNode | undefined {
    return this.collectPanes(this.tree.root).find((p) => p.tabIds.includes(tabId));
  }

  private findParent(target: LayoutNode, node: LayoutNode = this.tree.root): ParentRef | null {
    if (node.type === 'pane') return null;
    if (node.children[0] === target) return { parent: node, index: 0 };
    if (node.children[1] === target) return { parent: node, index: 1 };
    return this.findParent(target, node.children[0]) ?? this.findParent(target, node.children[1]);
  }

  /** target 자리에 replacement 를 넣는다(root 면 root 를 바꾼다) */
  private replaceNode(target: LayoutNode, replacement: LayoutNode): void {
    if (this.tree.root === target) {
      this.tree.root = replacement;
      return;
    }
    const ref = this.findParent(target);
    if (ref) ref.parent.children[ref.index] = replacement;
  }

  /** pane 에서 탭을 뺀다. 활성 탭이었으면 이웃(같은 자리 → 앞)을 활성으로 */
  private detachTab(pane: PaneNode, tabId: string, change: LayoutChange): void {
    const idx = pane.tabIds.indexOf(tabId);
    if (idx < 0) return;
    pane.tabIds.splice(idx, 1);
    if (pane.activeTabId !== tabId) return;
    pane.activeTabId = pane.tabIds[idx] ?? pane.tabIds[idx - 1] ?? null;
    if (pane.activeTabId !== null && !change.activeChangedPaneIds.includes(pane.id)) {
      change.activeChangedPaneIds.push(pane.id);
    }
  }

  /** 빈 pane 을 닫고 형제가 부모 자리로 올라간다. 포커스가 그 pane 이었으면 형제 쪽 첫 pane 으로 */
  private removePane(pane: PaneNode, change: LayoutChange): void {
    const ref = this.findParent(pane);
    if (!ref) return; // root pane — 호출한 쪽이 막는다
    const sibling = ref.parent.children[ref.index === 0 ? 1 : 0];
    this.replaceNode(ref.parent, sibling);
    change.closedPaneIds.push(pane.id);
    change.activeChangedPaneIds = change.activeChangedPaneIds.filter((id) => id !== pane.id);
    change.geometryChanged = true;
    if (this.tree.focusedPaneId === pane.id || this.tree.focusedPaneId === null) {
      this.tree.focusedPaneId = this.collectPanes(sibling)[0]?.id ?? null;
    }
    change.focusedPaneId = this.tree.focusedPaneId;
  }

  /** 마지막 pane 이 비면 닫지 않고 기본 새 탭 하나를 만든다 */
  private refillLastPane(pane: PaneNode, spec: NewTabSpec, change: LayoutChange): void {
    const tab = this.makeTab(spec);
    this.tree.tabs[tab.id] = tab;
    pane.tabIds = [tab.id];
    pane.activeTabId = tab.id;
    change.createdTabIds.push(tab.id);
    if (!change.activeChangedPaneIds.includes(pane.id)) change.activeChangedPaneIds.push(pane.id);
    this.tree.focusedPaneId = pane.id;
    change.focusedPaneId = pane.id;
  }
}
