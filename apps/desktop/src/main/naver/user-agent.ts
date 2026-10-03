// U07 8-1 · 8-12 — UA · Client Hints 글 만들기(순수 함수 · electron 을 import 하지 않아 vitest 로 잰다)

/** Sec-CH-UA 헤더 값 — 엔진이 JS(`navigator.userAgentData`)에 주는 값 그대로 */
export interface ClientHintHeaders {
  'sec-ch-ua': string;
  'sec-ch-ua-mobile': string;
  'sec-ch-ua-platform': string;
}

export interface UserAgentDataLow {
  brands: ReadonlyArray<{ brand: string; version: string }>;
  mobile: boolean;
  platform: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Electron 기본 UA 에서 ` Electron/<판>` 과 ` <앱이름>/<판>` 토막을 빼고, 크롬처럼 판을 `<major>.0.0.0` 으로 줄인다(UA reduction).
 * major 는 우리 엔진(Chromium) 판 그대로 — 엔진보다 높은 판을 적으면 기능 검사와 어긋난다(꾸미지 않는다).
 */
export function chromiumLikeUserAgent(base: string, appName: string, appVersion: string): string {
  return base
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${escapeRegExp(appName)}\\/${escapeRegExp(appVersion)}`), '')
    .replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** `[{brand,version}]` → `"Not?A_Brand";v="24", "Chromium";v="152"` (크롬이 보내는 꼴 · 순서 그대로) */
export function formatBrandHeader(brands: UserAgentDataLow['brands']): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

export function clientHintHeaders(data: UserAgentDataLow): ClientHintHeaders {
  return { 'sec-ch-ua': formatBrandHeader(data.brands), 'sec-ch-ua-mobile': data.mobile ? '?1' : '?0', 'sec-ch-ua-platform': `"${data.platform}"` };
}
