// R6-a — 챗 pane 규칙(electron 없이): 주소 · 경로 · CSP · 요청 거름 · 안내 화면 · 스니펫 키 · preload 채널 글자
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SNIPPET_LOCALES, readSnippetFile } from '../i18n/snippet.js';
import {
  CHAT_APP_SHOP_BASE,
  CHAT_ENTRY_URL,
  CHAT_PROXY_CONFIG,
  CHAT_SCHEME_PRIVILEGES,
  CHAT_SNIPPET_KEYS,
  chatAssetPathFromUrl,
  chatCsp,
  chatFallbackCsp,
  chatResponseHeaders,
  escapeHtml,
  isAllowedChatNavigation,
  isAllowedChatRequest,
  isChatEntryUrl,
  isChatUrl,
  renderChatFallbackHtml,
} from './chat-policy.js';
import { PLUGIN_UI_SCHEME_PRIVILEGES } from '../plugin/plugin-ui-policy.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('챗 주소 (app://chat)', () => {
  it('scheme 은 app · 권한은 cmh-plugin 과 같다 · 이름이 겹치지 않는다', () => {
    expect(CHAT_SCHEME_PRIVILEGES.scheme).toBe('app');
    expect(CHAT_SCHEME_PRIVILEGES.privileges).toEqual(PLUGIN_UI_SCHEME_PRIVILEGES.privileges);
    expect(CHAT_SCHEME_PRIVILEGES.scheme).not.toBe(PLUGIN_UI_SCHEME_PRIVILEGES.scheme);
    expect(CHAT_ENTRY_URL).toBe('app://chat/index.html');
  });
  it('isChatUrl — 호스트 chat · 사용자 · 비밀번호 · 포트 없음', () => {
    expect(isChatUrl('app://chat/index.html')).toBe(true);
    expect(isChatUrl('app://chat/assets/x.js?v=1')).toBe(true);
    expect(isChatUrl('app://evil/index.html')).toBe(false);
    expect(isChatUrl('app://u:p@chat/index.html')).toBe(false);
    expect(isChatUrl('app://chat:8080/index.html')).toBe(false);
    expect(isChatUrl('https://chat/index.html')).toBe(false);
    expect(isChatUrl('cmh-plugin://chat/index.html')).toBe(false);
    expect(isChatUrl('not a url')).toBe(false);
  });
  it('isChatEntryUrl — 첫 화면 하나만(쿼리 · 조각 · 다른 경로 거절)', () => {
    expect(isChatEntryUrl(CHAT_ENTRY_URL)).toBe(true);
    expect(isChatEntryUrl('app://chat/')).toBe(false);
    expect(isChatEntryUrl('app://chat/index.html?x=1')).toBe(false);
    expect(isChatEntryUrl('app://chat/other.html')).toBe(false);
    expect(isChatEntryUrl('https://evil.example/')).toBe(false);
  });
  it('이동 잠금 — app://chat 밖(https · file · about · 다른 scheme) 은 거부', () => {
    expect(isAllowedChatNavigation('app://chat/index.html#/x')).toBe(true);
    for (const url of ['https://example.com/', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'cmh-plugin://p/index.html', 'app://other/']) {
      expect(isAllowedChatNavigation(url), url).toBe(false);
    }
  });
  it('요청 거름 — 자기 주소 · data: · 자기 blob: · devtools: 만', () => {
    expect(isAllowedChatRequest('app://chat/assets/a.js')).toBe(true);
    expect(isAllowedChatRequest('data:image/png;base64,AA')).toBe(true);
    expect(isAllowedChatRequest('blob:app://chat/1234')).toBe(true);
    expect(isAllowedChatRequest('blob:https://evil.example/1234')).toBe(false);
    expect(isAllowedChatRequest('https://testumgebung.my-mik.de/api/x')).toBe(false);
    expect(isAllowedChatRequest('http://127.0.0.1:9/')).toBe(false);
    expect(isAllowedChatRequest('ws://127.0.0.1/')).toBe(false);
  });
  it('막힌 프록시 — .invalid · <-loopback> 로 루프백도 프록시로', () => {
    expect(CHAT_PROXY_CONFIG.mode).toBe('fixed_servers');
    expect(new URL(CHAT_PROXY_CONFIG.proxyRules).hostname.endsWith('.invalid')).toBe(true);
    expect(CHAT_PROXY_CONFIG.proxyBypassRules).toBe('<-loopback>');
  });
});

describe('chatAssetPathFromUrl — dist 안 상대경로만', () => {
  it('보통 파일 · 빈 경로는 index.html · 쿼리는 버린다', () => {
    expect(chatAssetPathFromUrl('app://chat/index.html')).toBe('index.html');
    expect(chatAssetPathFromUrl('app://chat/')).toBe('index.html');
    expect(chatAssetPathFromUrl('app://chat')).toBe('index.html');
    expect(chatAssetPathFromUrl('app://chat/assets/index-ABC.js?x=1#y')).toBe('assets/index-ABC.js');
    expect(chatAssetPathFromUrl('app://chat/assets/a%20b.js')).toBe('assets/a b.js');
  });
  it('Shopware 공개 폴더 base(/bundles/cmhaiagent/chat-app/) 산출도 연다', () => {
    expect(chatAssetPathFromUrl(`app://chat/${CHAT_APP_SHOP_BASE}assets/index-X.js`)).toBe('assets/index-X.js');
    expect(chatAssetPathFromUrl(`app://chat/${CHAT_APP_SHOP_BASE}`)).toBe('index.html');
  });
  it('탈출 · 깨진 인코딩 · 남의 주소는 null', () => {
    // URL 파서가 평범한 `..` 를 먼저 접는다 → 뿌리 밖으로 못 나간다(dist 안 경로로만 남는다)
    expect(chatAssetPathFromUrl('app://chat/../../etc/passwd')).toBe('etc/passwd');
    expect(chatAssetPathFromUrl('app://chat/%2e%2e/%2e%2e/etc/passwd')).toBe('etc/passwd');
    expect(chatAssetPathFromUrl('app://chat/a%2f..%2fb')).toBeNull();
    expect(chatAssetPathFromUrl('app://chat/a%5cb')).toBeNull();
    expect(chatAssetPathFromUrl('app://chat/a%00b')).toBeNull();
    expect(chatAssetPathFromUrl('app://chat/%E0%A4%A')).toBeNull();
    expect(chatAssetPathFromUrl('app://evil/index.html')).toBeNull();
    expect(chatAssetPathFromUrl('https://chat/index.html')).toBeNull();
  });
});

describe('응답 머리 · CSP', () => {
  it('nosniff · no-store · CSP 를 늘 붙인다', () => {
    const h = chatResponseHeaders('text/javascript; charset=utf-8');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['Content-Security-Policy']).toBe(chatCsp());
  });
  it('챗 CSP — 스크립트는 자기 것 + wasm 만 · unsafe-eval · unsafe-inline 스크립트 없음 · 바깥 연결 없음 · 끼우기 막음', () => {
    const csp = chatCsp();
    const script = csp.split('; ').find((d) => d.startsWith('script-src')) ?? '';
    expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/https?:/);
  });
  it('안내 화면 CSP — 스크립트 0', () => {
    expect(chatFallbackCsp()).toContain("default-src 'none'");
    expect(chatFallbackCsp()).not.toContain('script-src');
  });
});

describe('안내 화면(chat-app dist 없음)', () => {
  it('글자를 이스케이프하고 빌드 명령을 보인다 · 스크립트 태그 없음', () => {
    const html = renderChatFallbackHtml({ lang: 'ko-KR', title: '<b>t</b>', body: 'a & b', env: '"CMH_CHAT_APP_DIST"' });
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&quot;CMH_CHAT_APP_DIST&quot;');
    expect(html).toContain('vite build --base ./ --outDir dist');
    expect(html).toContain('data-chat-fallback="1"');
    expect(html).not.toMatch(/<script/i);
    expect(escapeHtml(`<'">&`)).toBe('&lt;&#39;&quot;&gt;&amp;');
  });
  it('스니펫 키 셋이 세 장에 다 있다 · fallbackEnv 는 {env} 자리표', () => {
    for (const locale of SNIPPET_LOCALES) {
      const map = readSnippetFile(locale);
      for (const key of Object.values(CHAT_SNIPPET_KEYS)) expect(map.has(key), `${locale} ${key}`).toBe(true);
      expect(map.get(CHAT_SNIPPET_KEYS.fallbackEnv)).toContain('{env}');
    }
  });
});

describe('preload 채널 글자', () => {
  it('chat-preload.cts 의 채널 = chat-pane-host.ts CHAT_PING_CHANNEL', () => {
    const preload = readFileSync(join(here, '..', '..', 'preload', 'chat-preload.cts'), 'utf8');
    const host = readFileSync(join(here, 'chat-pane-host.ts'), 'utf8');
    const channelOf = (src: string): string | undefined => /CHAT_PING_CHANNEL = '([^']+)'/.exec(src)?.[1];
    expect(channelOf(preload)).toBe('cmh-chat:ping');
    expect(channelOf(host)).toBe(channelOf(preload));
    // preload 가 여는 것은 cmhChat 하나 · ipcRenderer 를 통째로 넘기지 않는다
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
  });
});
