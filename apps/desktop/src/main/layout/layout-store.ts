// U05 — userData/layout.json 저장 · 복원. 500ms debounce · tmp 에 쓰고 rename(쓰다 죽어도 옛 파일은 산다).
// RD-a(2026-10-07) — 파일 꼴 v2(LayoutFileV2 · 사이드바 상태 · 에이전트 탭 묶음). 읽기는 v1 · v2 둘 다 → v2 · 쓰기는 늘 v2.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  clampSidebarWidth,
  LAYOUT_LIMITS,
  type LayoutFileV2,
  type LayoutNode,
  type LayoutTree,
  type SidebarState,
  type TabOwner,
  type TabRecord,
} from '@cmh-hub-app/contracts';

export const DEFAULT_SIDEBAR: Readonly<SidebarState> = { collapsed: false, width: LAYOUT_LIMITS.sidebarWidthDefault };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 사이드바 칸 — 없거나 틀리면 기본값 · 폭은 min ~ max 로 자름 */
function normalizeSidebar(raw: unknown): SidebarState {
  if (!isRecord(raw)) return { ...DEFAULT_SIDEBAR };
  const collapsed = typeof raw['collapsed'] === 'boolean' ? raw['collapsed'] : DEFAULT_SIDEBAR.collapsed;
  const width = typeof raw['width'] === 'number' ? clampSidebarWidth(raw['width']) : DEFAULT_SIDEBAR.width;
  return { collapsed, width };
}

/**
 * 탭마다 owner 를 채운다(없거나 틀리면 'user' · agentIds 에 든 탭은 'agent'). 나머지 칸은 그대로 — 탭 모양 검사는 LayoutEngine.loadTree 가 한다.
 * 탭 하나라도 객체가 아니면 null(깨진 파일).
 */
function normalizeTabs(raw: unknown, agentIds: ReadonlySet<string>): Record<string, TabRecord> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, TabRecord> = {};
  for (const [key, tab] of Object.entries(raw)) {
    if (!isRecord(tab)) return null;
    const owner: TabOwner = agentIds.has(key) || tab['owner'] === 'agent' ? 'agent' : 'user';
    out[key] = { ...(tab as unknown as TabRecord), owner };
  }
  return out;
}

/** agentTabIds — 문자열 · tabs 에 있는 id 만 · 겹침 없이(차례 유지) */
function normalizeAgentIds(raw: unknown, tabs: Record<string, unknown>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) if (typeof id === 'string' && id in tabs && !out.includes(id)) out.push(id);
  return out;
}

/**
 * 읽은 JSON → v2. v1(LayoutTree) 은 sidebar 기본값 · owner 'user' · root/tabs/focusedPaneId 그대로.
 * 알 수 없는 version · 뿌리(root/tree)가 객체가 아님 · tabs 가 깨짐 → null.
 */
export function migrateLayoutFile(json: unknown): LayoutFileV2 | null {
  if (!isRecord(json)) return null;
  const version = json['version'];
  if (version !== 1 && version !== 2) return null;
  const rawTree = version === 1 ? json['root'] : json['tree'];
  if (!isRecord(rawTree)) return null;
  const rawTabs = json['tabs'];
  if (!isRecord(rawTabs)) return null;
  const agentIds = version === 2 ? normalizeAgentIds(json['agentTabIds'], rawTabs) : [];
  const tabs = normalizeTabs(rawTabs, new Set(agentIds));
  if (!tabs) return null;
  const focused = json['focusedPaneId'];
  const file: LayoutFileV2 = {
    version: 2,
    sidebar: version === 2 ? normalizeSidebar(json['sidebar']) : { ...DEFAULT_SIDEBAR },
    tree: rawTree as unknown as LayoutNode,
    tabs,
    focusedPaneId: typeof focused === 'string' ? focused : null,
  };
  if (agentIds.length > 0) file.agentTabIds = agentIds;
  return file;
}

/** 엔진 트리 + 사이드바 → 저장 꼴 v2(owner 를 늘 적는다 · agentTabIds 는 owner 'agent' 탭이 있을 때만 · tabs 차례) */
export function layoutFileFromTree(tree: LayoutTree, sidebar: SidebarState = DEFAULT_SIDEBAR): LayoutFileV2 {
  const tabs: Record<string, TabRecord> = {};
  const agentTabIds: string[] = [];
  for (const [key, tab] of Object.entries(tree.tabs)) {
    const owner: TabOwner = tab.owner === 'agent' ? 'agent' : 'user';
    tabs[key] = { ...tab, owner };
    if (owner === 'agent') agentTabIds.push(key);
  }
  const file: LayoutFileV2 = {
    version: 2,
    sidebar: normalizeSidebar(sidebar),
    tree: structuredClone(tree.root),
    tabs,
    focusedPaneId: tree.focusedPaneId,
  };
  if (agentTabIds.length > 0) file.agentTabIds = agentTabIds;
  return file;
}

/** 저장 꼴 v2 → 엔진에 넣을 트리(LayoutEngine.loadTree 의 입력 · version 1 은 메모리 꼴의 표시) */
export function layoutTreeFromFile(file: LayoutFileV2): LayoutTree {
  return { version: 1, root: structuredClone(file.tree), tabs: structuredClone(file.tabs), focusedPaneId: file.focusedPaneId };
}

export class LayoutStore {
  private timer: NodeJS.Timeout | null = null;
  private pending: LayoutTree | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** 사이드바 상태(RD) — load 가 파일 값으로 바꾸고 · 저장 때 함께 쓴다 */
  private sidebar: SidebarState = { ...DEFAULT_SIDEBAR };
  /** 마지막으로 save 에 받은 트리 — setSidebar 가 트리 없이 다시 쓸 때 */
  private lastTree: LayoutTree | null = null;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = 500,
  ) {}

  /**
   * v1 · v2 를 읽어 v2 로 돌려준다. 파일이 없거나 JSON 이 깨졌거나 version 이 1 · 2 가 아니면 null(파일은 그대로 둔다).
   * 트리 모양 검사는 LayoutEngine.loadTree 가 한다(layoutTreeFromFile 로 넘긴다).
   */
  async load(): Promise<LayoutFileV2 | null> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const file = migrateLayoutFile(JSON.parse(text) as unknown);
      if (file) this.sidebar = { ...file.sidebar };
      return file;
    } catch {
      return null;
    }
  }

  getSidebar(): SidebarState {
    return { ...this.sidebar };
  }

  /** 폭은 min ~ max 로 자른다. 전에 저장한 트리가 있으면 같이 다시 쓴다(debounce) */
  setSidebar(next: SidebarState): void {
    this.sidebar = normalizeSidebar(next);
    const tree = this.pending ?? this.lastTree;
    if (tree) this.save(tree);
  }

  save(tree: LayoutTree): void {
    this.pending = tree;
    this.lastTree = tree;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  /** 미룬 저장을 지금 쓴다(앱 종료 때) */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tree = this.pending;
    this.pending = null;
    if (tree) {
      const file = layoutFileFromTree(tree, this.sidebar);
      this.writing = this.writing.then(() => this.write(file));
    }
    await this.writing;
  }

  private async write(file: LayoutFileV2): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
