// R8 — 셸 스니펫. Shopware 어드민 snippet JSON 꼴(키 `cmh-hub-app.<module>.<key>` · ko-KR · en-GB · de-DE 세 장 항상 같이).
// electron 을 import 하지 않는다(vitest 로 시험한다). JSON 은 fs 로 읽는다 — copy-static.mjs 가 src/shell 을 통째로(.ts 빼고)
// dist/shell 로 옮기므로 src/shell/snippet/*.json 은 dist/shell/snippet/ 에 놓인다. 이 파일은 dist/main/i18n/snippet.js → ../../shell/snippet.
// 빠진 키는 en-GB 로 되돌아가고 onMissing 으로 알린다(개발 모드 경고는 부르는 쪽이 정한다 · PLAN R8 §5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNIPPET_LOCALES = ['ko-KR', 'en-GB', 'de-DE'] as const;
export type SnippetLocale = (typeof SNIPPET_LOCALES)[number];
export const FALLBACK_LOCALE: SnippetLocale = 'en-GB';

export type SnippetParams = Readonly<Record<string, string | number>>;

export interface SnippetMissing {
  readonly key: string;
  /** 키를 찾던 locale */
  readonly locale: SnippetLocale;
  /** en-GB 에서 찾았으면 'en-GB' · 거기에도 없으면 null(키 글자를 그대로 돌려준다) */
  readonly fellBackTo: SnippetLocale | null;
}

export interface LoadSnippetsOptions {
  /** 스니펫 폴더(시험용). 없으면 defaultSnippetDir() */
  readonly dir?: string;
  readonly onMissing?: (missing: SnippetMissing) => void;
}

export interface Snippets {
  readonly locale: SnippetLocale;
  t(key: string, params?: SnippetParams): string;
  has(key: string): boolean;
}

const here = dirname(fileURLToPath(import.meta.url)); // src/main/i18n · dist/main/i18n

export function defaultSnippetDir(): string {
  return join(here, '..', '..', 'shell', 'snippet');
}

/** 세 locale 말고는 전부 en-GB(OS 의 'ko' 같은 짧은 꼴도 en-GB — 짝 맞추기는 부르는 쪽 몫) */
export function resolveSnippetLocale(raw: string | null | undefined): SnippetLocale {
  return (SNIPPET_LOCALES as readonly (string | null | undefined)[]).includes(raw) ? (raw as SnippetLocale) : FALLBACK_LOCALE;
}

/** 중첩 객체 → 점 키 평평한 표. 잎은 문자열만 · 배열 · 숫자 · 빈 객체는 예외(스니펫 파일이 깨진 것) */
export function flattenSnippets(tree: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (path === '') throw new Error('snippet: root must be an object');
      out.set(path, node);
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`snippet: value at "${path}" must be a string or an object`);
    }
    const entries = Object.entries(node);
    if (entries.length === 0) throw new Error(`snippet: empty object at "${path}"`);
    for (const [key, child] of entries) {
      if (key.length === 0 || key.includes('.')) throw new Error(`snippet: bad key "${key}" under "${path}"`);
      walk(child, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(tree, '');
  return out;
}

export function readSnippetFile(locale: SnippetLocale, dir: string = defaultSnippetDir()): Map<string, string> {
  const text = readFileSync(join(dir, `${locale}.json`), 'utf8');
  return flattenSnippets(JSON.parse(text) as unknown);
}

/** `{name}` 자리표를 params 로 바꾼다. params 에 없는 자리표는 그대로 둔다 */
export function interpolate(template: string, params?: SnippetParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

export function loadSnippets(locale: string, options: LoadSnippetsOptions = {}): Snippets {
  const resolved = resolveSnippetLocale(locale);
  const dir = options.dir ?? defaultSnippetDir();
  const fallback = readSnippetFile(FALLBACK_LOCALE, dir);
  const primary = resolved === FALLBACK_LOCALE ? fallback : readSnippetFile(resolved, dir);
  const onMissing = options.onMissing;

  return {
    locale: resolved,
    has: (key) => primary.has(key),
    t(key, params) {
      const own = primary.get(key);
      if (own !== undefined) return interpolate(own, params);
      const backup = fallback.get(key);
      onMissing?.({ key, locale: resolved, fellBackTo: backup === undefined ? null : FALLBACK_LOCALE });
      return backup === undefined ? key : interpolate(backup, params);
    },
  };
}
