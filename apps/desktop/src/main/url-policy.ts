// A02 — kind 별 허용 호스트. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
import type { TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';

export function isNaverHost(host: string): boolean {
  return APP_CONFIG.naverHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

/** admin 은 호스트가 정확히 같아야 하고, naver 는 끝맺음(로그인 nid.naver.com 포함). https 와 about: 만 */
export function isAllowedUrl(kind: TabKind, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // chat(R6 챗 pane · app://)은 이 정책의 대상이 아니다 — 만드는 곳(R6)이 자기 정책을 갖기 전까지 전부 거부(모르는 kind 를 네이버 검사로 흘리지 않는다 · 2026-10-07 RD-a 검수)
  if (kind === 'chat') return false;
  if (u.protocol === 'about:') return true;
  // 빈 탭은 아무 http(s) — 사람이 주소창에 친 곳(2026-10-05). 어드민 · 네이버 탭은 아래처럼 고정 호스트만(A02)
  if (kind === 'web') {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!APP_CONFIG.naverTabEnabled && isNaverHost(u.hostname.toLowerCase())) return false;
    return true;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (kind === 'admin') return (APP_CONFIG.adminHosts as readonly string[]).includes(host);
  if (kind === 'naver') return isNaverHost(host);
  return false;
}
