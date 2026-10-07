import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LOCALE,
  SNIPPET_LOCALES,
  flattenSnippets,
  interpolate,
  loadSnippets,
  readSnippetFile,
  resolveSnippetLocale,
  type SnippetMissing,
} from './snippet.js';
import { MCP_IMPORT_SNIPPET } from '../mcp/mcp-config-import.js';
import { MCP_SNIPPET_KEYS } from '../mcp/mcp-server-manager.js';
import { PROMPT_ERROR, PROMPT_RENDER_SNIPPET } from '../prompts/prompt-file.js';
import { SKILL_ERROR, SKILL_WARNING } from '../skills/skill-manifest.js';

describe('셸 스니펫 세 장 (R8)', () => {
  const files = SNIPPET_LOCALES.map((locale) => ({ locale, map: readSnippetFile(locale) }));

  it('세 장의 키 집합이 같다 — 하나라도 빠지면 실패', () => {
    const all = new Set(files.flatMap((f) => [...f.map.keys()]));
    for (const { locale, map } of files) {
      const missing = [...all].filter((k) => !map.has(k)).map((k) => `${locale}: ${k}`);
      expect(missing).toEqual([]);
    }
  });

  it('모든 키는 cmh-hub-app. 접두 · 값은 빈 글자가 아니다', () => {
    for (const { locale, map } of files) {
      for (const [key, value] of map) {
        expect(key.startsWith('cmh-hub-app.'), `${locale} ${key}`).toBe(true);
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('자리표 이름이 세 장에서 같다', () => {
    const holes = (v: string) => [...v.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
    const en = files.find((f) => f.locale === 'en-GB')?.map ?? new Map<string, string>();
    for (const { locale, map } of files) {
      for (const [key, value] of map) {
        expect(holes(value), `${locale} ${key}`).toEqual(holes(en.get(key) ?? ''));
      }
    }
  });

  it('1차 키가 있다(사이드바 · 입력칸 · 도구 줄 · Guard · plan · 공통)', () => {
    const ko = loadSnippets('ko-KR');
    for (const key of [
      'cmh-hub-app.sidebar.chats',
      'cmh-hub-app.sidebar.agentTabs',
      'cmh-hub-app.composer.placeholder',
      'cmh-hub-app.toolbar.guard',
      'cmh-hub-app.guard.requiresApproval',
      'cmh-hub-app.plan.premium',
      'cmh-hub-app.common.cancel',
    ]) {
      expect(ko.has(key), key).toBe(true);
    }
    expect(ko.t('cmh-hub-app.toolbar.guard')).toBe('Guard');
    // 검수 권고 — ko-KR 낱말
    expect(ko.t('cmh-hub-app.toolbar.agentTabsCount', { count: 3 })).toBe('에이전트 탭 3');
    expect(ko.t('cmh-hub-app.toolbar.runLocal')).toBe('로컬');
    expect(ko.t('cmh-hub-app.toolbar.runServer')).toBe('서버');
    expect([ko.t('cmh-hub-app.toolbar.reasoningLow'), ko.t('cmh-hub-app.toolbar.reasoningMedium'), ko.t('cmh-hub-app.toolbar.reasoningHigh')]).toEqual(['낮음', '보통', '높음']);
    expect(ko.t('cmh-hub-app.composer.placeholder')).toBe('답장 입력, @ 로 컨텍스트 추가');
    expect(loadSnippets('en-GB').t('cmh-hub-app.composer.placeholder')).toBe('Reply, @ for context');
  });
});

describe('검수 차단 6 — 코드가 쓰는 스니펫 키가 세 장에 다 있다', () => {
  const groups: Record<string, Readonly<Record<string, string>>> = {
    MCP_IMPORT_SNIPPET,
    MCP_SNIPPET_KEYS,
    SKILL_ERROR,
    SKILL_WARNING,
    PROMPT_ERROR,
    PROMPT_RENDER_SNIPPET,
  };

  it.each(SNIPPET_LOCALES)('%s 에 MCP · 스킬 · 프롬프트 상수 키가 전부 있다', (locale) => {
    const map = readSnippetFile(locale);
    const missing: string[] = [];
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of Object.values(keys)) if (!map.has(key)) missing.push(`${group}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('loadSnippets · t', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmh-snippet-'));
  writeFileSync(join(dir, 'en-GB.json'), JSON.stringify({ app: { hello: 'Hello {name}', onlyEn: 'English only' } }));
  writeFileSync(join(dir, 'de-DE.json'), JSON.stringify({ app: { hello: 'Hallo {name}' } }));
  writeFileSync(join(dir, 'ko-KR.json'), JSON.stringify({ app: { hello: '안녕 {name}' } }));

  it('locale 은 세 값으로 — ko · ko-* → ko-KR · de · de-* → de-DE · en* · 나머지 → en-GB', () => {
    for (const raw of ['ko', 'ko-KR', 'KO-kr', 'ko_KR.UTF-8', 'ko-KP']) expect(resolveSnippetLocale(raw), raw).toBe('ko-KR');
    for (const raw of ['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE.UTF-8', 'DE']) expect(resolveSnippetLocale(raw), raw).toBe('de-DE');
    for (const raw of ['en', 'en-US', 'en-GB', 'EN-gb', 'fr-FR', 'kor', 'deu', '', '  ', null, undefined]) {
      expect(resolveSnippetLocale(raw), String(raw)).toBe(FALLBACK_LOCALE);
    }
    expect(loadSnippets('fr-FR', { dir }).locale).toBe('en-GB');
    expect(loadSnippets('ko', { dir }).locale).toBe('ko-KR');
  });

  it('자리표 {name} 을 바꾼다 · 없는 자리표는 그대로', () => {
    expect(loadSnippets('ko-KR', { dir }).t('app.hello', { name: '사장님' })).toBe('안녕 사장님');
    expect(loadSnippets('de-DE', { dir }).t('app.hello')).toBe('Hallo {name}');
    expect(interpolate('{a}-{b}-{a}', { a: 1 })).toBe('1-{b}-1');
    expect(interpolate('{toString}', {})).toBe('{toString}');
  });

  it('없는 키는 en-GB 로 되돌아가고 경고 콜백 · en-GB 에도 없으면 키 그대로', () => {
    const warnings: SnippetMissing[] = [];
    const de = loadSnippets('de-DE', { dir, onMissing: (m) => warnings.push(m) });
    expect(de.t('app.onlyEn')).toBe('English only');
    expect(de.t('app.nowhere')).toBe('app.nowhere');
    expect(de.t('app.hello', { name: 'Chef' })).toBe('Hallo Chef');
    expect(warnings).toEqual([
      { key: 'app.onlyEn', locale: 'de-DE', fellBackTo: 'en-GB' },
      { key: 'app.nowhere', locale: 'de-DE', fellBackTo: null },
    ]);
    expect(de.has('app.onlyEn')).toBe(false);
  });

  it('깨진 스니펫 모양은 예외', () => {
    expect(() => flattenSnippets({ a: { b: 1 } })).toThrow(/snippet/);
    expect(() => flattenSnippets({ a: ['x'] })).toThrow(/snippet/);
    expect(() => flattenSnippets({ a: {} })).toThrow(/snippet/);
    expect(() => flattenSnippets({ 'a.b': 'x' })).toThrow(/snippet/);
    expect(() => flattenSnippets('x')).toThrow(/snippet/);
    expect([...flattenSnippets({ a: { b: 'x', c: { d: 'y' } } })]).toEqual([
      ['a.b', 'x'],
      ['a.c.d', 'y'],
    ]);
  });
});
