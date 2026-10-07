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

/**
 * 엔진 밖에서 기억하는 탭 owner(2026-10-07 검수 B4). LayoutEngine.loadTree 는 탭 칸을 id · kind · url · title · favicon 만 옮겨
 * owner 가 사라진다 — 엔진은 고치지 않고(합의안 6) store 가 load 때 따로 들고 있다가 저장 때 같은 탭 id 에 다시 붙인다.
 */
export interface RememberedOwners {
  /** 탭 id → owner(파일에 적혔던 것) */
  readonly owners: ReadonlyMap<string, TabOwner>;
  /** 파일의 agentTabIds 차례 */
  readonly agentTabIds: readonly string[];
}

export const NO_REMEMBERED_OWNERS: RememberedOwners = { owners: new Map(), agentTabIds: [] };

/** 읽은 v2 파일 → 기억할 owner(파일 탭마다 · agentTabIds 차례) */
export function rememberOwners(file: LayoutFileV2): RememberedOwners {
  const owners = new Map<string, TabOwner>();
  for (const [key, tab] of Object.entries(file.tabs)) owners.set(key, tab.owner === 'agent' ? 'agent' : 'user');
  return { owners, agentTabIds: [...(file.agentTabIds ?? [])] };
}

/**
 * 엔진 트리 + 사이드바 → 저장 꼴 v2(owner 를 늘 적는다 · agentTabIds 는 owner 'agent' 탭이 있을 때만).
 * owner: 트리 탭에 적힌 것 → 없으면 remembered 의 같은 id → 없으면(새 탭) 'user'. 트리에 없는 id 의 기억은 버린다.
 * agentTabIds 차례: remembered 의 차례(아직 있는 탭만) → 그다음 나머지 agent 탭(tabs 차례).
 */
export function layoutFileFromTree(
  tree: LayoutTree,
  sidebar: SidebarState = DEFAULT_SIDEBAR,
  remembered: RememberedOwners = NO_REMEMBERED_OWNERS,
): LayoutFileV2 {
  const tabs: Record<string, TabRecord> = {};
  const agentSet = new Set<string>();
  for (const [key, tab] of Object.entries(tree.tabs)) {
    const known = tab.owner ?? remembered.owners.get(key);
    const owner: TabOwner = known === 'agent' ? 'agent' : 'user';
    tabs[key] = { ...tab, owner };
    if (owner === 'agent') agentSet.add(key);
  }
  const agentTabIds = remembered.agentTabIds.filter((id) => agentSet.has(id));
  for (const id of agentSet) if (!agentTabIds.includes(id)) agentTabIds.push(id);
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
  /** load 때 읽은 탭 owner · agentTabIds — 엔진을 지나며 사라지므로 저장 때 다시 붙인다(B4) */
  private remembered: RememberedOwners = NO_REMEMBERED_OWNERS;

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
      if (file) {
        this.sidebar = { ...file.sidebar };
        this.remembered = rememberOwners(file);
      }
      return file;
    } catch {
      return null;
    }
  }

  getSidebar(): SidebarState {
    return { ...this.sidebar };
  }

  /**
   * 폭은 min ~ max 로 자른다. 전에 저장한 트리가 있으면 같이 다시 쓴다(debounce).
   * 아직 저장한 트리가 없으면 currentTree(부르는 쪽의 지금 트리)로 쓴다 — 첫 트리 저장 전 사이드바 상태가 파일에 안 남던 것(검수 5 권고 8).
   * 둘 다 없으면 메모리에만 두고 다음 save 때 같이 쓴다.
   */
  setSidebar(next: SidebarState, currentTree?: LayoutTree): void {
    this.sidebar = normalizeSidebar(next);
    const tree = this.pending ?? this.lastTree ?? currentTree;
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
      const file = layoutFileFromTree(tree, this.sidebar, this.remembered);
      // 쓴 것을 다음 기억으로 — 엔진에서 사라진 탭 id 는 여기서 빠진다
      this.remembered = rememberOwners(file);
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
