// U11 — Electron 드라이버(U07a)와 크롬 확장(U11)이 같이 쓰는 순수 함수 · electron · chrome API 0

export type DriverStep =
  | { op: 'goto'; url: string }
  | { op: 'read'; selector: string }
  | { op: 'click'; selector: string }
  | { op: 'scroll'; deltaY: number } // 양수 = 아래
  | { op: 'wait'; ms: number };

export interface DriverStepResult {
  op: DriverStep['op'] | 'invalid';
  ok: boolean;
  value?: string | null;
  error?: DriverErrorCode;
}

export type DriverErrorCode =
  | 'origin-not-allowed'
  | 'selector-missing'
  | 'not-visible'
  | 'navigation-failed'
  | 'timeout'
  | 'stopped'
  | 'destroyed'
  | 'invalid-step';

export interface DriverRunResult {
  ok: boolean;
  steps: DriverStepResult[];
  error: { code: DriverErrorCode; message: string } | null;
}

/** 단계 검증 — 모양 · 타입 · 범위 검사 (순수 함수) */
export function validateStep(step: unknown): DriverStep | null {
  if (!step || typeof step !== 'object') return null;
  const s = step as Record<string, unknown>;
  if (typeof s['op'] !== 'string') return null;

  switch (s['op']) {
    case 'goto': {
      if (typeof s['url'] !== 'string') return null;
      const url = s['url'].trim();
      if (!url) return null;
      return { op: 'goto', url };
    }
    case 'read': {
      if (typeof s['selector'] !== 'string') return null;
      const selector = s['selector'].trim();
      if (!selector) return null;
      return { op: 'read', selector };
    }
    case 'click': {
      if (typeof s['selector'] !== 'string') return null;
      const selector = s['selector'].trim();
      if (!selector) return null;
      return { op: 'click', selector };
    }
    case 'scroll': {
      if (typeof s['deltaY'] !== 'number' || !Number.isFinite(s['deltaY'])) return null;
      if (s['deltaY'] < -2000 || s['deltaY'] > 2000) return null;
      return { op: 'scroll', deltaY: s['deltaY'] };
    }
    case 'wait': {
      if (typeof s['ms'] !== 'number' || !Number.isFinite(s['ms'])) return null;
      if (s['ms'] < 0 || s['ms'] > 30000) return null;
      return { op: 'wait', ms: s['ms'] };
    }
    default:
      return null;
  }
}

/** 출처 검사 — https 프로토콜 및 허용 출처와 일치 여부 확인 (순수 함수) */
export function isOriginAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

// 2026-10-06 검수 2 — 부분 일치가 «취소/반품 관리» 같은 메뉴까지 막았다 · 아이콘 링크 · href 의 delete · 다른 origin 이 통과했다.
export const DANGER_ANYWHERE = /삭제|탈퇴|폐기|초기화|로그아웃|delete|remove|destroy|logout|purge|löschen|loeschen/i;
export const ACTION_ONLY =
  /^(저장|등록|수정|전송|발송|취소|확인|적용|결제|환불|완료|중지|판매중지|save|submit|send|apply|confirm|cancel|ok|done|finish|speichern|senden)(\s?하기)?$/i;

export interface NavigationTargetInfo {
  tag: string;
  href: string | null;
  resolvedProtocol: string | null;
  role: string | null;
  label: string;
  sameOrigin: boolean;
}

export function isNavigationTarget(info: NavigationTargetInfo): boolean {
  const normalizedLabel = (info.label || '').replace(/\s+/g, ' ').trim();
  if (!normalizedLabel) {
    return false;
  }

  if (DANGER_ANYWHERE.test(normalizedLabel) || (info.href !== null && DANGER_ANYWHERE.test(info.href))) {
    return false;
  }

  if (ACTION_ONLY.test(normalizedLabel)) {
    return false;
  }

  const role = info.role ? info.role.trim().toLowerCase() : null;
  if (role === 'tab') {
    return true;
  }

  const tag = info.tag ? info.tag.trim().toLowerCase() : '';
  if (tag === 'a' && info.href !== null) {
    const rawHref = info.href.trim();
    if (!rawHref || rawHref === '#') {
      return false;
    }
    if (rawHref.startsWith('#/')) {
      return true;
    }
    const protocol = info.resolvedProtocol ? info.resolvedProtocol.trim().toLowerCase() : null;
    if ((protocol === 'https:' || protocol === 'http:') && info.sameOrigin) {
      return true;
    }
  }

  return false;
}
