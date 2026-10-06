// U10 2번 — 오른쪽 클릭한 자리의 요소를 «읽기만» 한다(isolated world · document.elementFromPoint). 리스너 · 전역 · 값 쓰기 0(U07 8-5 · readFieldState 와 같은 길).
// 1차: iframe 안 요소는 안 본다(elementFromPoint 가 iframe 을 주면 null) · 비밀번호 칸의 값은 절대 안 읽는다.
import type { WebContents } from 'electron';
import type { ElementInfo } from './element-intents.js';

/** 우리 읽기 전용 world — 0(main) · 999(preload) · 1207(credential-filler) · 1208(parallel-check) 과 겹치지 않는 고정 번호 */
export const ELEMENT_WORLD_ID = 1209;

const TEXT_MAX = 200;
const LABEL_MAX = 120;
const BEFORE_TEXT_MAX = 60;

/**
 * 좌표는 CSS px. 요소 → 가까운 input · textarea · select · button · a · [role=button] 으로 올라간다(없으면 그 요소 그대로).
 * 라벨 = 연결된 label → aria-label → aria-labelledby → placeholder → title → 바로 앞 글(같은 부모 안 · 부모 셋까지).
 * 선택자 = tag[name=…] 하나뿐이면 그것 → #id 하나뿐이면 그것 → 조상 다섯까지의 짧은 nth-of-type 경로.
 */
export function buildReadElementScript(x: number, y: number): string {
  return `(() => {
  const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
  if (!el || el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
  const target = el.closest('input, textarea, select, button, a, [role="button"]') || el;
  const tag = target.tagName.toLowerCase();
  const attr = (n) => target.getAttribute(n);
  const clip = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; };
  const type = tag === 'input' ? String(target.type || attr('type') || 'text').toLowerCase() : attr('type');
  const isPassword = tag === 'input' && type === 'password';
  let label = null;
  const labels = target.labels ? Array.from(target.labels) : [];
  if (labels.length > 0) label = clip(labels.map((l) => l.textContent).join(' '), ${LABEL_MAX});
  if (!label && attr('aria-label')) label = clip(attr('aria-label'), ${LABEL_MAX});
  if (!label && attr('aria-labelledby')) label = clip(attr('aria-labelledby').split(/\\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' '), ${LABEL_MAX});
  if (!label && attr('placeholder')) label = clip(attr('placeholder'), ${LABEL_MAX});
  if (!label && attr('title')) label = clip(attr('title'), ${LABEL_MAX});
  if (!label) {
    let node = target; let before = '';
    for (let depth = 0; depth < 3 && !before && node.parentElement; depth++) {
      let sib = node.previousElementSibling;
      while (sib && !before) { before = clip(sib.textContent, ${BEFORE_TEXT_MAX}); sib = sib.previousElementSibling; }
      node = node.parentElement;
    }
    label = before || null;
  }
  let value = null;
  if (!isPassword) {
    if (tag === 'select') { const o = target.selectedOptions && target.selectedOptions[0]; value = clip(o ? o.textContent : target.value, ${TEXT_MAX}); }
    else if (tag === 'input' || tag === 'textarea') value = clip(target.value, ${TEXT_MAX});
  }
  const text = tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : clip(target.textContent, ${TEXT_MAX});
  const quote = (s) => '"' + String(s).replace(/["\\\\]/g, '\\\\$&') + '"';
  const escId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
  let selector = null;
  const name = attr('name');
  if (name && unique(tag + '[name=' + quote(name) + ']')) selector = tag + '[name=' + quote(name) + ']';
  if (!selector && target.id && unique('#' + escId(target.id))) selector = '#' + escId(target.id);
  if (!selector) {
    const parts = []; let n = target;
    for (let depth = 0; n && n.nodeType === 1 && n !== document.body && depth < 5; depth++) {
      const t = n.tagName.toLowerCase(); const p = n.parentElement;
      const same = p ? Array.from(p.children).filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? t + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : t);
      const sel = parts.join(' > ');
      if (unique(sel)) { selector = sel; break; }
      n = p;
    }
    if (!selector) selector = parts.join(' > ');
  }
  return { tag, type, name: name || null, id: target.id || null, role: attr('role'), label, text, value, selector };
})()`;
}

function isElementInfo(value: unknown): value is ElementInfo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['tag'] === 'string' && typeof v['selector'] === 'string' && typeof v['text'] === 'string';
}

/**
 * ContextMenuParams 의 x · y 는 view 의 DIP · elementFromPoint 는 CSS px — 줌(Ctrl+휠)이면 배율로 나눈다(credential-filler.ts clickAt 의 반대 방향).
 * isolated world 는 실패해도 reject 하지 않고 undefined 를 준다 — 그때 null.
 */
export async function readElementAtPoint(wc: WebContents, x: number, y: number): Promise<ElementInfo | null> {
  if (wc.isDestroyed()) return null;
  const zoom = wc.getZoomFactor() || 1;
  try {
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(ELEMENT_WORLD_ID, [{ code: buildReadElementScript(x / zoom, y / zoom) }]);
    return isElementInfo(result) ? result : null;
  } catch {
    return null;
  }
}
