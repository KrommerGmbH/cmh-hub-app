// U08 — 오른쪽 클릭한 자리가 «로그인 페이지의 아이디 · 비밀번호 칸»인가. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
import type { TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../../config.js';

export interface LoginPage {
  kind: TabKind;
  hosts: readonly string[];
  /** 로그인 화면 경로의 앞부분 — 같은 호스트의 다른 화면(회원가입 · 비밀번호 변경)을 거른다 */
  pathPrefix: string;
  /** admin 처럼 SPA 해시로 로그인 화면을 가르는 곳 — null 이면 호스트만 본다 */
  hashPrefix: string | null;
  /** 로그인 뒤 도착 화면 주소의 앞부분 — 자동 저장은 여기 도착했을 때만(제미나이 검수 2026-10-05: «로그인 화면을 벗어남»은 실패 뒤 다른 링크 · F5 도 걸린다) */
  successUrlPrefixes: readonly string[];
  usernameSelectors: readonly string[];
  passwordSelectors: readonly string[];
}

/** 메뉴를 띄울 칸 종류 — Chromium 이 ContextMenuParams.formControlType 으로 준다(페이지 스크립트 0) */
const LOGIN_FIELD_TYPES = new Set(['input-text', 'input-email', 'input-password']);

export function findLoginPage(kind: TabKind, pageUrl: string): LoginPage | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const page = (APP_CONFIG.loginPages as readonly LoginPage[]).find((p) => p.kind === kind && p.hosts.includes(host));
  if (!page) return null;
  if (!u.pathname.startsWith(page.pathPrefix)) return null;
  if (page.hashPrefix !== null && !u.hash.startsWith(page.hashPrefix)) return null;
  return page;
}

/** 이 주소가 그 로그인 화면의 «로그인 뒤 도착 화면»인가 — 로그인 화면 자체는 아니다 */
export function isLoginSuccessUrl(page: LoginPage, url: string): boolean {
  if (findLoginPage(page.kind, url)) return false;
  return page.successUrlPrefixes.some((prefix) => url.startsWith(prefix));
}

export interface LoginFieldClick {
  pageURL: string;
  frameURL: string;
  isEditable: boolean;
  formControlType: string;
}

/** 로그인 칸 위 오른쪽 클릭이면 그 페이지 표 한 줄 · 아니면 null. iframe 안(frameURL ≠ pageURL)은 1차에서 안 본다 */
export function matchLoginFieldClick(kind: TabKind, click: LoginFieldClick): LoginPage | null {
  if (!click.isEditable || !LOGIN_FIELD_TYPES.has(click.formControlType)) return null;
  if (click.frameURL !== '' && click.frameURL !== click.pageURL) return null;
  return findLoginPage(kind, click.pageURL);
}
