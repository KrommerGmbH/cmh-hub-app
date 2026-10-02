// A02 — kind 별 허용 호스트. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
import type { TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';

/** admin 은 호스트가 정확히 같아야 하고, naver 는 끝맺음(로그인 nid.naver.com 포함). https 와 about: 만 */
export function isAllowedUrl(kind: TabKind, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'about:') return true;
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (kind === 'admin') return (APP_CONFIG.adminHosts as readonly string[]).includes(host);
  return APP_CONFIG.naverHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
}
