// U10 6번 — 네이버 주소 → 화면(cmh_ai_screen.urlTemplate) → 담당 AI(capability.agentRole). 서버 표를 Admin API 검색으로 «읽기만» 한 번 받아
// 앱이 켜 있는 동안 메모리에 둔다. LLM 호출 0. 실패 · 로그인 전이면 담당 없이 진행한다(메뉴를 막지 않는다).
// 표 칸 이름은 2026-10-06 시험 서버 실측: cmh_ai_screen { screenKey · menuPath · urlTemplate · capabilityId · capability } · cmh_ai_capability { code · name · agentRole }
// · urlTemplate 꼴 «#/store/themeshopping/list» · 자리표는 «{channelProductNo}»(중괄호) · 쿼리(?…)가 붙은 것도 있다.

export interface ScreenRecord {
  screenKey: string;
  menuPath: string | null;
  urlTemplate: string | null;
  /** ProductAgent · OrderAgent · CsAgent · MarketingAgent · AnalyticsAgent · StoreAgent(2026-10-06 실측 6개) · 분야 없는 화면(_common-layout)은 null */
  agentRole: string | null;
  capabilityName: string | null;
}

/** AppSession.call 의 모양 중 여기서 쓰는 것 — 로그인 전이면 null */
export interface ScreenApi {
  call<T>(path: string, body: unknown): Promise<{ status: number; data: T | null } | null>;
}

/** Admin API 검색(Shopware DAL criteria JSON) — 읽기만 */
const SCREEN_SEARCH_PATH = '/api/search/cmh-ai-screen';
/** 서버 max_limit 을 넘지 않게 100씩 — 지금 화면 92개(2026-10-06 실측)라 한 쪽 */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
/** 메뉴가 늦게 뜨지 않게 — 넘으면 담당 없이(받기는 뒤에서 이어져 다음 번에 메모리에서) */
export const LOOKUP_TIMEOUT_MS = 1500;
/** 서버 실패 뒤 다시 시도까지 */
const RETRY_AFTER_MS = 30_000;

interface ScreenRow {
  screenKey?: unknown;
  menuPath?: unknown;
  urlTemplate?: unknown;
  capability?: { agentRole?: unknown; name?: unknown } | null;
}

interface ScreenSearchResponse {
  total?: number;
  data?: ScreenRow[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function toRecord(row: ScreenRow): ScreenRecord | null {
  const screenKey = str(row.screenKey);
  if (!screenKey) return null;
  return { screenKey, menuPath: str(row.menuPath), urlTemplate: str(row.urlTemplate), agentRole: str(row.capability?.agentRole), capabilityName: str(row.capability?.name) };
}

/** 주소의 해시 경로(쿼리 · 끝 슬래시 뗀 것) — «https://sell.smartstore.naver.com/#/store/themeshopping/list?x=1» → «#/store/themeshopping/list» */
function hashPathOf(url: string): string | null {
  const at = url.indexOf('#');
  if (at < 0) return null;
  const path = (url.slice(at).split('?')[0] ?? '').replace(/\/+$/, '');
  return path.length > 1 ? path : null;
}

/** urlTemplate → 정규식 — 자리표 {…} 는 경로 한 칸의 아무 값 · 그 밖은 글자 그대로 */
function templateToRegExp(templatePath: string): RegExp {
  const escaped = templatePath.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/?#]+');
  return new RegExp(`^${escaped}$`);
}

/**
 * 지금 주소에 맞는 화면 — 같은 틀이 여럿이면(상세 화면과 그 모달들) 자리표가 적은 것 → screenKey 가 짧은 것(상세가 모달보다 앞). 없으면 null.
 */
export function matchScreen(pageUrl: string, screens: readonly ScreenRecord[]): ScreenRecord | null {
  const hashPath = hashPathOf(pageUrl);
  if (!hashPath) return null;
  let best: { screen: ScreenRecord; placeholders: number } | null = null;
  for (const screen of screens) {
    if (!screen.urlTemplate) continue;
    const templatePath = (screen.urlTemplate.split('?')[0] ?? '').replace(/\/+$/, '');
    if (!templatePath || !templateToRegExp(templatePath).test(hashPath)) continue;
    const placeholders = (templatePath.match(/\{[^}]*\}/g) ?? []).length;
    if (!best || placeholders < best.placeholders || (placeholders === best.placeholders && screen.screenKey.length < best.screen.screenKey.length)) {
      best = { screen, placeholders };
    }
  }
  return best?.screen ?? null;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export class ScreenLookup {
  private cache: ScreenRecord[] | null = null;
  private pending: Promise<ScreenRecord[] | null> | null = null;
  private lastFailedAt = 0;

  constructor(private readonly api: ScreenApi | null) {}

  /** 지금 주소의 담당 화면 — LOOKUP_TIMEOUT_MS 안에 못 받으면 null(받기는 뒤에서 이어진다) */
  async lookup(pageUrl: string): Promise<ScreenRecord | null> {
    const screens = await withTimeout(this.screens(), LOOKUP_TIMEOUT_MS, null);
    return screens ? matchScreen(pageUrl, screens) : null;
  }

  private screens(): Promise<ScreenRecord[] | null> {
    if (this.cache) return Promise.resolve(this.cache);
    if (this.pending) return this.pending;
    if (Date.now() - this.lastFailedAt < RETRY_AFTER_MS) return Promise.resolve(null);
    this.pending = this.fetchAll()
      .then((list) => {
        if (Array.isArray(list)) this.cache = list;
        else if (list === 'failed') this.lastFailedAt = Date.now();
        return Array.isArray(list) ? list : null;
      })
      .catch((error: unknown) => {
        console.warn('[ai-lookup] 화면 표 읽기 실패', error);
        this.lastFailedAt = Date.now();
        return null;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** 'no-login' = 토큰 없음(바로 다시 시도해도 싸다) · 'failed' = 서버 오류(RETRY_AFTER_MS 뒤에) */
  private async fetchAll(): Promise<ScreenRecord[] | 'no-login' | 'failed'> {
    if (!this.api) return 'no-login';
    const out: ScreenRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.api.call<ScreenSearchResponse>(SCREEN_SEARCH_PATH, {
        page,
        limit: PAGE_SIZE,
        // 설명(description)은 길다 — 쓰는 칸만 받는다
        includes: { cmh_ai_screen: ['id', 'screenKey', 'menuPath', 'urlTemplate', 'capability'], cmh_ai_capability: ['id', 'agentRole', 'name', 'code'] },
        associations: { capability: {} },
      });
      if (!res) return 'no-login';
      const rows = res.data?.data;
      if (res.status >= 300 || !Array.isArray(rows)) {
        console.warn('[ai-lookup] cmh-ai-screen 검색 실패', res.status);
        return 'failed';
      }
      for (const row of rows) {
        const record = toRecord(row);
        if (record) out.push(record);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    console.info(`[ai-lookup] 화면 표 ${out.length}개 · 담당 있는 것 ${out.filter((s) => s.agentRole).length}개`);
    return out;
  }
}
