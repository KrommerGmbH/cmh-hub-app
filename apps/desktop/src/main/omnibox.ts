// 빈 탭 주소창(2026-10-05 사장님 «빈 탭 · url 넣고 구글 크롬브라우저처럼 인터넷 검색») — 친 글을 갈 주소로 바꾼다.
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다). 크롬과 같은 갈림: 주소처럼 보이면 그 주소 · 아니면 검색.
import { APP_CONFIG } from '../config.js';

/**
 * 사람이 «주소»라고 볼 꼴 — 점이 든 호스트(example.com · a.b.co.kr · 한글 도메인 네이버.com) · localhost · IPv4 · IPv6([::1])(포트 · 경로 붙어도).
 * 한글 · IPv6 은 제미나이 검수(2026-10-05)로 더했다 — 전에는 검색으로 빠졌다. 한글 도메인은 new URL 이 punycode 로 바꾼다.
 */
const HOST_LIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|([\p{L}\p{N}-]+\.)+\p{L}{2,})(:\d{1,5})?([/?#].*)?$/iu;

/**
 * 주소창 글 → 갈 주소. 빈 글은 null(아무것도 안 함).
 * - `http://` · `https://` 로 시작하면 그대로(모양이 틀리면 검색)
 * - 다른 scheme(`javascript:` · `file:` · `data:` 등)은 열지 않고 검색어로 본다 — 주소창으로 로컬 파일 · 스크립트를 못 연다
 * - 빈칸 없이 호스트 꼴이면 `https://` 를 붙인다
 * - 나머지는 검색(APP_CONFIG.webSearchUrl)
 */
export function resolveOmniboxInput(text: string): string | null {
  const input = text.trim();
  if (input === '') return null;
  if (/^https?:\/\//i.test(input)) {
    try {
      return new URL(input).toString();
    } catch {
      return searchUrl(input);
    }
  }
  if (!/\s/.test(input) && HOST_LIKE.test(input)) {
    try {
      return new URL(`https://${input}`).toString();
    } catch {
      return searchUrl(input);
    }
  }
  return searchUrl(input);
}

function searchUrl(query: string): string {
  return `${APP_CONFIG.webSearchUrl}${encodeURIComponent(query)}`;
}
