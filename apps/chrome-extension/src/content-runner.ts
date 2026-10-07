import {
  isNavigationTarget,
  validateStep,
  type DriverErrorCode,
  type DriverRunResult,
  type DriverStepResult,
  type NavigationTargetInfo,
} from '@cmh-hub-app/driver-core';

function extractNavigationTargetInfo(
  el: Element,
  win: Pick<Window, 'location'>,
): NavigationTargetInfo {
  const tag = el.tagName.toLowerCase();
  const href = el.getAttribute('href');
  const role = el.getAttribute('role');
  const label = el.textContent ?? '';

  let resolvedProtocol: string | null = null;
  let sameOrigin = false;

  if (href) {
    try {
      const base = win.location?.href || 'about:blank';
      const parsed = new URL(href, base);
      resolvedProtocol = parsed.protocol;
      if (win.location?.origin) {
        sameOrigin = parsed.origin === win.location.origin;
      }
    } catch {
      resolvedProtocol = null;
      sameOrigin = false;
    }
  }

  return {
    tag,
    href,
    resolvedProtocol,
    role,
    label,
    sameOrigin,
  };
}

function isElementVisible(el: Element): boolean {
  if (typeof (el as HTMLElement).getBoundingClientRect === 'function') {
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      return false;
    }
  }
  return true;
}

function extractReadValue(el: Element): string | null {
  const inputType = el.getAttribute('type')?.toLowerCase();
  if (inputType === 'password') {
    return null;
  }

  const tag = el.tagName.toLowerCase();
  let rawValue = '';

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const val = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    rawValue = typeof val === 'string' ? val : (el.textContent ?? '');
  } else {
    rawValue = el.textContent ?? '';
  }

  return rawValue.trim().slice(0, 500);
}

/**
 * content script 단계 실행기 — 순수 함수 · chrome API 0 · 첫 실패에서 즉시 중단
 */
export async function runReadSteps(
  doc: Document,
  win: Pick<Window, 'scrollBy' | 'innerHeight' | 'innerWidth' | 'location'>,
  steps: readonly unknown[],
): Promise<DriverRunResult> {
  if (!Array.isArray(steps)) {
    return {
      ok: false,
      steps: [],
      error: { code: 'invalid-step', message: 'steps 가 배열이 아닙니다' },
    };
  }

  const stepResults: DriverStepResult[] = [];

  for (const rawStep of steps) {
    const step = validateStep(rawStep);
    if (!step) {
      const errRes: DriverStepResult = {
        op: 'invalid',
        ok: false,
        error: 'invalid-step',
      };
      stepResults.push(errRes);
      return {
        ok: false,
        steps: stepResults,
        error: { code: 'invalid-step', message: '유효하지 않은 단계입니다' },
      };
    }

    if (step.op === 'goto') {
      // 탭 이동은 서비스 워커가 chrome.tabs.update 로 수행한다 (다음 단계 예정)
      const errRes: DriverStepResult = {
        op: 'goto',
        ok: false,
        error: 'invalid-step',
      };
      stepResults.push(errRes);
      return {
        ok: false,
        steps: stepResults,
        error: { code: 'invalid-step', message: 'goto 단계는 content script 에서 지원하지 않습니다' },
      };
    }

    if (step.op === 'read') {
      let el: Element | null = null;
      try {
        el = doc.querySelector(step.selector);
      } catch (err) {
        stepResults.push({
          op: 'read',
          ok: false,
          error: 'invalid-step',
        });
        const raw = err instanceof Error ? err.message : String(err);
        const firstLine = raw.split('\n')[0] ?? '';
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'invalid-step', message: firstLine.slice(0, 200) || `잘못된 선택자입니다: ${step.selector}` },
        };
      }
      if (!el) {
        stepResults.push({
          op: 'read',
          ok: false,
          error: 'selector-missing',
        });
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'selector-missing', message: `선택자 요소를 찾을 수 없습니다: ${step.selector}` },
        };
      }

      const value = extractReadValue(el);
      stepResults.push({
        op: 'read',
        ok: true,
        value,
      });
      continue;
    }

    if (step.op === 'wait') {
      await new Promise<void>((resolve) => setTimeout(resolve, step.ms));
      stepResults.push({
        op: 'wait',
        ok: true,
      });
      continue;
    }

    if (step.op === 'scroll') {
      win.scrollBy(0, step.deltaY);
      stepResults.push({
        op: 'scroll',
        ok: true,
      });
      continue;
    }

    if (step.op === 'click') {
      let el: Element | null = null;
      try {
        el = doc.querySelector(step.selector);
      } catch (err) {
        stepResults.push({
          op: 'click',
          ok: false,
          error: 'invalid-step',
        });
        const raw = err instanceof Error ? err.message : String(err);
        const firstLine = raw.split('\n')[0] ?? '';
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'invalid-step', message: firstLine.slice(0, 200) || `잘못된 선택자입니다: ${step.selector}` },
        };
      }
      if (!el) {
        stepResults.push({
          op: 'click',
          ok: false,
          error: 'selector-missing',
        });
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'selector-missing', message: `선택자 요소를 찾을 수 없습니다: ${step.selector}` },
        };
      }

      const info = extractNavigationTargetInfo(el, win);
      if (!isNavigationTarget(info)) {
        stepResults.push({
          op: 'click',
          ok: false,
          error: 'invalid-step',
        });
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'invalid-step', message: `안전하지 않은 클릭 대상입니다: ${step.selector}` },
        };
      }

      if (!isElementVisible(el)) {
        stepResults.push({
          op: 'click',
          ok: false,
          error: 'not-visible',
        });
        return {
          ok: false,
          steps: stepResults,
          error: { code: 'not-visible', message: `요소가 화면에 보이지 않습니다: ${step.selector}` },
        };
      }

      // 확장의 클릭은 isTrusted=false (DOM 이벤트) · 1차에서는 화면 이동(네비게이션)만 수행
      (el as HTMLElement).click();
      stepResults.push({
        op: 'click',
        ok: true,
      });
      continue;
    }
  }

  return {
    ok: true,
    steps: stepResults,
    error: null,
  };
}
