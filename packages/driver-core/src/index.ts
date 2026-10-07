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

export interface ContextElement {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  role: string | null;
  label: string | null;
  text: string;
  value: string | null;
  selector: string;
}

export type ContextIntentKey =
  | 'suggest_value'
  | 'check_rules'
  | 'explain_field'
  | 'explain_button'
  | 'summarize_screen';

const VALID_CONTEXT_INTENTS: ReadonlySet<string> = new Set<ContextIntentKey>([
  'suggest_value',
  'check_rules',
  'explain_field',
  'explain_button',
  'summarize_screen',
]);

const MAX_CONTEXT_STRING_LEN = 500;

function isValidContextString(v: unknown): boolean {
  return typeof v === 'string' && v.length <= MAX_CONTEXT_STRING_LEN;
}

function isValidNullableContextString(v: unknown): boolean {
  return v === null || (typeof v === 'string' && v.length <= MAX_CONTEXT_STRING_LEN);
}

function isContextElement(value: unknown): value is ContextElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const el = value as Record<string, unknown>;
  if (!isValidContextString(el['tag'])) return false;
  if (!isValidContextString(el['selector'])) return false;
  if (!isValidContextString(el['text'])) return false;

  if (!isValidNullableContextString(el['type'])) return false;
  if (!isValidNullableContextString(el['name'])) return false;
  if (!isValidNullableContextString(el['id'])) return false;
  if (!isValidNullableContextString(el['role'])) return false;
  if (!isValidNullableContextString(el['label'])) return false;
  if (!isValidNullableContextString(el['value'])) return false;

  return true;
}

/** U11 앱 ↔ 확장 WebSocket 메시지(JSON 한 줄) */
export const BRIDGE_DEFAULT_PORT = 47900;
export type BridgeToExtension = { type: 'run'; id: string; steps: unknown[] } | { type: 'ping' };
export type BridgeToApp =
  | { type: 'hello'; extVersion: string }
  | { type: 'result'; id: string; result: DriverRunResult }
  | { type: 'pong' }
  | {
      type: 'context-action';
      intentKey: ContextIntentKey;
      element: ContextElement | null;
      pageUrl: string;
      pageTitle: string;
    };

export function parseBridgeToExtension(raw: string): BridgeToExtension | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['type'] === 'ping') {
    return { type: 'ping' };
  }
  if (obj['type'] === 'run') {
    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
      return null;
    }
    if (!Array.isArray(obj['steps'])) {
      return null;
    }
    return { type: 'run', id: obj['id'], steps: obj['steps'] };
  }
  return null;
}

export function parseBridgeToApp(raw: string): BridgeToApp | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['type'] === 'pong') {
    return { type: 'pong' };
  }
  if (obj['type'] === 'hello') {
    if (typeof obj['extVersion'] !== 'string' || obj['extVersion'].trim() === '') {
      return null;
    }
    return { type: 'hello', extVersion: obj['extVersion'] };
  }
  if (obj['type'] === 'result') {
    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
      return null;
    }
    const res = obj['result'];
    if (!res || typeof res !== 'object' || Array.isArray(res)) {
      return null;
    }
    const resObj = res as Record<string, unknown>;
    if (typeof resObj['ok'] !== 'boolean' || !Array.isArray(resObj['steps'])) {
      return null;
    }
    const err = resObj['error'];
    const isErrorValid =
      err === null ||
      (typeof err === 'object' &&
        err !== null &&
        !Array.isArray(err) &&
        typeof (err as Record<string, unknown>)['code'] === 'string' &&
        typeof (err as Record<string, unknown>)['message'] === 'string');
    if (!isErrorValid) {
      return null;
    }
    return { type: 'result', id: obj['id'], result: res as DriverRunResult };
  }
  if (obj['type'] === 'context-action') {
    const intentKey = obj['intentKey'];
    if (typeof intentKey !== 'string' || !VALID_CONTEXT_INTENTS.has(intentKey)) {
      return null;
    }
    const pageUrl = obj['pageUrl'];
    if (typeof pageUrl !== 'string' || pageUrl.length > MAX_CONTEXT_STRING_LEN) {
      return null;
    }
    const pageTitle = obj['pageTitle'];
    if (typeof pageTitle !== 'string' || pageTitle.length > MAX_CONTEXT_STRING_LEN) {
      return null;
    }
    const element = obj['element'];
    if (element !== null && !isContextElement(element)) {
      return null;
    }
    return {
      type: 'context-action',
      intentKey: intentKey as ContextIntentKey,
      element: element as ContextElement | null,
      pageUrl,
      pageTitle,
    };
  }
  return null;
}
