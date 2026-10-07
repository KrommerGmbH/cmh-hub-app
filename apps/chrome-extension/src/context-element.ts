import type { ContextElement, ContextIntentKey } from '@cmh-hub-app/driver-core';

const TEXT_MAX = 200;
const LABEL_MAX = 120;
const BEFORE_TEXT_MAX = 60;

function clip(s: unknown, maxLen: number): string {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function quote(s: string): string {
  return '"' + s.replace(/["\\]/g, '\\$&') + '"';
}

function escId(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s;
}

export function readContextElement(el: Element | null): ContextElement | null {
  if (!el || el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    return null;
  }

  const target =
    (typeof el.closest === 'function'
      ? el.closest('input, textarea, select, button, a, [role="button"]')
      : null) || el;

  const doc = target.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const tag = target.tagName.toLowerCase();
  const attr = (name: string): string | null =>
    typeof target.getAttribute === 'function' ? target.getAttribute(name) : null;

  const targetAny = target as unknown as {
    type?: unknown;
    labels?: Iterable<{ textContent: string | null }>;
    value?: unknown;
    selectedOptions?: ArrayLike<{ textContent: string | null }>;
    id?: string;
  };

  const rawType = targetAny.type ?? attr('type');
  const type = tag === 'input' ? String(rawType || 'text').toLowerCase() : (attr('type') || null);
  const isPassword = tag === 'input' && type === 'password';

  let label: string | null = null;
  const labelsProp = targetAny.labels;
  const labels = labelsProp ? Array.from(labelsProp) : [];
  if (labels.length > 0) {
    label = clip(labels.map((l) => l.textContent ?? '').join(' '), LABEL_MAX);
  }
  if (!label && attr('aria-label')) {
    label = clip(attr('aria-label'), LABEL_MAX);
  }
  if (!label && attr('aria-labelledby') && doc) {
    const ids = (attr('aria-labelledby') ?? '').split(/\s+/);
    label = clip(
      ids
        .map((id) => (doc.getElementById(id)?.textContent ?? ''))
        .join(' '),
      LABEL_MAX,
    );
  }
  if (!label && attr('placeholder')) {
    label = clip(attr('placeholder'), LABEL_MAX);
  }
  if (!label && attr('title')) {
    label = clip(attr('title'), LABEL_MAX);
  }
  if (!label) {
    let node: Element | null = target;
    let before = '';
    for (let depth = 0; depth < 3 && !before && node?.parentElement; depth++) {
      let sib: Element | null = node.previousElementSibling;
      while (sib && !before) {
        before = clip(sib.textContent, BEFORE_TEXT_MAX);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    label = before || null;
  }

  let value: string | null = null;
  if (!isPassword) {
    if (tag === 'select') {
      const option = targetAny.selectedOptions && targetAny.selectedOptions[0];
      value = clip(option ? option.textContent : targetAny.value, TEXT_MAX);
    } else if (tag === 'input' || tag === 'textarea') {
      value = clip(targetAny.value, TEXT_MAX);
    }
  }

  const text =
    tag === 'input' || tag === 'textarea' || tag === 'select'
      ? ''
      : clip(target.textContent, TEXT_MAX);

  const unique = (sel: string): boolean => {
    if (!doc) return false;
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  let selector: string | null = null;
  const name = attr('name');
  if (name && unique(tag + '[name=' + quote(name) + ']')) {
    selector = tag + '[name=' + quote(name) + ']';
  }
  if (!selector && target.id && unique('#' + escId(target.id))) {
    selector = '#' + escId(target.id);
  }
  if (!selector && doc) {
    const parts: string[] = [];
    let n: Element | null = target;
    for (let depth = 0; n && n.nodeType === 1 && n !== doc.body && depth < 5; depth++) {
      const t = n.tagName.toLowerCase();
      const p: Element | null = n.parentElement;
      const same = p ? Array.from(p.children).filter((c) => n !== null && c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? t + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : t);
      const sel = parts.join(' > ');
      if (unique(sel)) {
        selector = sel;
        break;
      }
      n = p;
    }
    if (!selector) {
      selector = parts.join(' > ');
    }
  }
  if (!selector) {
    selector = tag;
  }

  return {
    tag,
    type,
    name: name || null,
    id: target.id || null,
    role: attr('role') || null,
    label,
    text,
    value,
    selector,
  };
}

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset']);
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'file']);

export function classifyContextElement(
  element: ContextElement | null,
): 'field' | 'button' | 'other' {
  if (!element) return 'other';
  const tag = element.tag.toLowerCase();
  const type = (element.type ?? '').toLowerCase();
  if (tag === 'input') {
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    return NON_FIELD_INPUT_TYPES.has(type) ? 'other' : 'field';
  }
  if (tag === 'textarea' || tag === 'select') return 'field';
  if (tag === 'button' || element.role === 'button') return 'button';
  return 'other';
}

export function intentsForElement(el: ContextElement | null): ContextIntentKey[] {
  switch (classifyContextElement(el)) {
    case 'field': {
      if ((el?.type ?? '').toLowerCase() === 'password') {
        return ['explain_field'];
      }
      return ['suggest_value', 'check_rules', 'explain_field'];
    }
    case 'button':
      return ['explain_button'];
    default:
      return ['summarize_screen'];
  }
}
