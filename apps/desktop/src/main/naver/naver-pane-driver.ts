// U07a — 읽기 전용 pane 드라이버 (cmh-hub-app)
// - 저장 0 · 타자 0 · 덮개 0 · 가짜 커서 0 · CDP(webContents.debugger) 0
// - 입력은 webContents.sendInputEvent, 읽기는 isolated world 1211 executeJavaScriptInIsolatedWorld 로 읽기만(값 쓰기 0)
// - 계획서: .plan/CmhHub/cmh-hub-app/PLAN.md:224 (U07a) · 227-232줄 (U07 3·4·5·6·9번)
import type { WebContents } from 'electron';
import { path as ghostPath } from 'ghost-cursor';

const DRIVER_WORLD_ID = 1211;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

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

interface Point {
  x: number;
  y: number;
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
const DANGER_ANYWHERE = /삭제|탈퇴|폐기|초기화|로그아웃|delete|remove|destroy|logout|purge|löschen|loeschen/i;
const ACTION_ONLY =
  /^(저장|등록|수정|전송|발송|취소|확인|적용|결제|환불|완료|중지|판매중지|save|submit|send|apply|confirm|cancel|ok|done|finish|speichern|senden)(\s?하기)?$/i;

export function isNavigationTarget(info: {
  tag: string;
  href: string | null;
  resolvedProtocol: string | null;
  role: string | null;
  label: string;
  sameOrigin: boolean;
}): boolean {
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

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NaverPaneDriver {
  private pos: Point = { x: 40, y: 40 };
  private stopped = false;

  constructor(
    private readonly wc: WebContents,
    private readonly options: { allowedOrigins: readonly string[]; stepTimeoutMs?: number },
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async run(steps: readonly unknown[]): Promise<DriverRunResult> {
    const stepResults: DriverStepResult[] = [];
    let runError: { code: DriverErrorCode; message: string } | null = null;

    for (let i = 0; i < steps.length; i++) {
      if (this.stopped) {
        runError = { code: 'stopped', message: '드라이버가 중단되었습니다' };
        break;
      }
      if (this.wc.isDestroyed()) {
        runError = { code: 'destroyed', message: 'WebContents 가 파기되었습니다' };
        break;
      }

      if (i > 0) {
        await sleep(rand(200, 600));
        if (this.stopped) {
          runError = { code: 'stopped', message: '드라이버가 중단되었습니다' };
          break;
        }
        if (this.wc.isDestroyed()) {
          runError = { code: 'destroyed', message: 'WebContents 가 파기되었습니다' };
          break;
        }
      }

      const raw = steps[i];
      const valid = validateStep(raw);
      if (!valid) {
        const rawOp =
          typeof raw === 'object' && raw && 'op' in raw && typeof (raw as Record<string, unknown>)['op'] === 'string'
            ? ((raw as Record<string, unknown>)['op'] as string)
            : null;
        const fallbackOp: DriverStep['op'] | 'invalid' =
          rawOp === 'goto' || rawOp === 'read' || rawOp === 'click' || rawOp === 'scroll' || rawOp === 'wait'
            ? rawOp
            : 'invalid';
        const stepRes: DriverStepResult = { op: fallbackOp, ok: false, error: 'invalid-step' };
        stepResults.push(stepRes);
        runError = { code: 'invalid-step', message: '유효하지 않은 드라이버 단계입니다' };
        break;
      }

      const res = await this.executeStep(valid);
      stepResults.push(res);
      if (!res.ok) {
        const errCode = res.error ?? 'invalid-step';
        runError = { code: errCode, message: `단계 실행 실패: ${valid.op} (${errCode})` };
        break;
      }
    }

    const runResult: DriverRunResult = {
      ok: runError === null,
      steps: stepResults,
      error: runError,
    };

    console.info(`[driver] steps=${stepResults.length} ok=${runResult.ok}${runError ? ` error=${runError.code}` : ''}`);
    return runResult;
  }

  private async executeStep(step: DriverStep): Promise<DriverStepResult> {
    if (this.stopped) return { op: step.op, ok: false, error: 'stopped' };
    if (this.wc.isDestroyed()) return { op: step.op, ok: false, error: 'destroyed' };

    switch (step.op) {
      case 'goto':
        return this.executeGoto(step.url);
      case 'read':
        return this.executeRead(step.selector);
      case 'click':
        return this.executeClick(step.selector);
      case 'scroll':
        return this.executeScroll(step.deltaY);
      case 'wait':
        return this.executeWait(step.ms);
    }
  }

  private async executeGoto(url: string): Promise<DriverStepResult> {
    if (!isOriginAllowed(url, this.options.allowedOrigins)) {
      return { op: 'goto', ok: false, error: 'origin-not-allowed' };
    }

    const timeoutMs = this.options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('timeout'));
        }, timeoutMs);
      });
      await Promise.race([
        this.wc.loadURL(url),
        timeoutPromise,
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      return { op: 'goto', ok: true };
    } catch {
      return { op: 'goto', ok: false, error: timedOut ? 'timeout' : 'navigation-failed' };
    }
  }

  private async executeRead(selector: string): Promise<DriverStepResult> {
    try {
      const script = `(() => {
        try {
          const e = document.querySelector(${JSON.stringify(selector)});
          if (!e) return { found: false };
          if (e.getAttribute('type') === 'password' || ('type' in e && e.type === 'password')) {
            return { found: true, isPassword: true, value: null };
          }
          let raw = '';
          if ('value' in e && typeof e.value === 'string') {
            raw = e.value;
          } else {
            raw = e.textContent || '';
          }
          return { found: true, isPassword: false, value: raw.trim().slice(0, 500) };
        } catch {
          return { found: false };
        }
      })()`;

      const result: unknown = await this.wc.executeJavaScriptInIsolatedWorld(DRIVER_WORLD_ID, [{ code: script }]);
      if (!result || typeof result !== 'object') {
        return { op: 'read', ok: false, error: 'selector-missing' };
      }

      const res = result as { found: boolean; isPassword?: boolean; value?: string | null };
      if (!res.found) {
        return { op: 'read', ok: false, error: 'selector-missing' };
      }

      if (res.isPassword) {
        return { op: 'read', ok: true, value: null };
      }

      return { op: 'read', ok: true, value: res.value ?? '' };
    } catch {
      return { op: 'read', ok: false, error: 'selector-missing' };
    }
  }

  private async executeClick(selector: string): Promise<DriverStepResult> {
    try {
      const script = `(() => {
        try {
          const e = document.querySelector(${JSON.stringify(selector)});
          if (!e) return { status: 'selector-missing' };

          let resolvedProtocol = null;
          let sameOrigin = false;
          const rawHref = e.getAttribute('href');
          if (rawHref) {
            try {
              const absUrl = e.href || new URL(rawHref, window.location.href).href;
              resolvedProtocol = new URL(absUrl).protocol;
              sameOrigin = Boolean(absUrl) && new URL(absUrl).origin === location.origin;
            } catch {
              resolvedProtocol = null;
              sameOrigin = false;
            }
          }

          const text = e.textContent || '';
          const aria = e.getAttribute('aria-label') || '';
          const title = e.getAttribute('title') || '';
          const label = (text + ' ' + aria + ' ' + title).trim();

          const info = {
            tag: e.tagName.toLowerCase(),
            href: rawHref,
            resolvedProtocol: resolvedProtocol,
            role: e.getAttribute('role'),
            label: label,
            sameOrigin: sameOrigin,
          };

          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return { status: 'not-visible', info };
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
            return { status: 'not-visible', info };
          }
          return { status: 'ok', x: cx, y: cy, info };
        } catch {
          return { status: 'selector-missing' };
        }
      })()`;

      const result: unknown = await this.wc.executeJavaScriptInIsolatedWorld(DRIVER_WORLD_ID, [{ code: script }]);
      if (!result || typeof result !== 'object') {
        return { op: 'click', ok: false, error: 'selector-missing' };
      }

      const res = result as {
        status: string;
        x?: number;
        y?: number;
        info?: {
          tag: string;
          href: string | null;
          resolvedProtocol: string | null;
          role: string | null;
          label: string;
          sameOrigin: boolean;
        };
      };
      if (res.status === 'selector-missing') {
        return { op: 'click', ok: false, error: 'selector-missing' };
      }
      if (!res.info || !isNavigationTarget(res.info)) {
        return { op: 'click', ok: false, error: 'invalid-step' };
      }
      if (res.status === 'not-visible' || typeof res.x !== 'number' || typeof res.y !== 'number') {
        return { op: 'click', ok: false, error: 'not-visible' };
      }

      const target: Point = { x: res.x, y: res.y };
      const zoom = this.wc.getZoomFactor() || 1;

      const pts = ghostPath(this.pos, target, { useTimestamps: true }) as Array<Point & { timestamp?: number }>;
      let last = pts[0]?.timestamp ?? Date.now();

      for (const p of pts) {
        if (this.stopped) return { op: 'click', ok: false, error: 'stopped' };
        if (this.wc.isDestroyed()) return { op: 'click', ok: false, error: 'destroyed' };

        const x = Math.round(p.x * zoom);
        const y = Math.round(p.y * zoom);
        this.wc.sendInputEvent({ type: 'mouseMove', x, y });

        const dt = Math.max(2, Math.min(40, (p.timestamp ?? last + 16) - last));
        last = p.timestamp ?? last + 16;
        await sleep(dt);
      }

      if (this.stopped) return { op: 'click', ok: false, error: 'stopped' };
      if (this.wc.isDestroyed()) return { op: 'click', ok: false, error: 'destroyed' };

      const tx = Math.round(target.x * zoom);
      const ty = Math.round(target.y * zoom);

      this.wc.sendInputEvent({ type: 'mouseDown', x: tx, y: ty, button: 'left', clickCount: 1 });
      await sleep(rand(40, 120));
      if (this.wc.isDestroyed()) {
        return { op: 'click', ok: false, error: 'destroyed' };
      }
      if (this.stopped) {
        this.wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });
        return { op: 'click', ok: false, error: 'stopped' };
      }
      this.wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });

      this.pos = target;
      return { op: 'click', ok: true };
    } catch {
      if (this.wc.isDestroyed()) {
        return { op: 'click', ok: false, error: 'destroyed' };
      }
      return { op: 'click', ok: false, error: 'selector-missing' };
    }
  }

  private async executeScroll(deltaY: number): Promise<DriverStepResult> {
    const zoom = this.wc.getZoomFactor() || 1;
    const sx = Math.round(this.pos.x * zoom);
    const sy = Math.round(this.pos.y * zoom);

    let remaining = deltaY;
    const sign = remaining >= 0 ? 1 : -1;
    let abs = Math.abs(remaining);

    while (abs > 0) {
      if (this.stopped) return { op: 'scroll', ok: false, error: 'stopped' };
      if (this.wc.isDestroyed()) return { op: 'scroll', ok: false, error: 'destroyed' };

      const chunk = Math.min(120, abs) * sign;
      // 드라이버 deltaY 는 DOM 과 같다(양수 = 아래) · sendInputEvent mouseWheel 은 양수 = 위라서 뒤집는다(2026-10-06 실측 scrollY)
      this.wc.sendInputEvent({
        type: 'mouseWheel',
        x: sx,
        y: sy,
        deltaX: 0,
        deltaY: -chunk,
      });

      abs -= Math.abs(chunk);
      if (abs > 0) {
        await sleep(rand(30, 80));
      }
    }

    return { op: 'scroll', ok: true };
  }

  private async executeWait(ms: number): Promise<DriverStepResult> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stopped) return { op: 'wait', ok: false, error: 'stopped' };
      if (this.wc.isDestroyed()) return { op: 'wait', ok: false, error: 'destroyed' };
      const chunk = Math.min(50, deadline - Date.now());
      if (chunk <= 0) break;
      await sleep(chunk);
    }
    return { op: 'wait', ok: true };
  }
}
