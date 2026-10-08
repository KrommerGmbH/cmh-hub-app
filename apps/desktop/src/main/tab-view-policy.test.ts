// 2026-10-07 검수(RD-a) — 탭 종류 · partition · 첫 주소 규칙(electron 없이)
import { describe, expect, it } from 'vitest';
import type { ShellCommand, TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';
import { initialTabUrl, isCreatableTabKind, partitionForTabKind, rejectTabCreation } from './tab-view-policy.js';

const ADMIN_FIRST = `${APP_CONFIG.serverOrigin}${APP_CONFIG.adminPath}`;
const DEFAULT_SPEC = { kind: 'admin', url: ADMIN_FIRST, title: 'Shopware' } as const;

describe('admin-view — 모르는 kind 는 partition 을 받지 않는다', () => {
  it('admin · naver · web 은 각자 저장 공간(옛 삼항식과 같은 값)', () => {
    expect(partitionForTabKind('admin')).toBe(APP_CONFIG.adminPartition);
    expect(partitionForTabKind('naver')).toBe(APP_CONFIG.naverPartition);
    expect(partitionForTabKind('web')).toBe(APP_CONFIG.webPartition);
  });
  it('chat · 아무 글자는 예외 — 어드민 공간으로 떨어지지 않는다', () => {
    expect(() => partitionForTabKind('chat')).toThrow(/partition 이 없다/);
    expect(() => partitionForTabKind('evil' as TabKind)).toThrow(/partition 이 없다/);
    expect(() => partitionForTabKind(undefined as unknown as TabKind)).toThrow();
  });
});

describe('newTab kind — admin · naver · web 만', () => {
  it("newTab kind 'chat' 은 거절된다(순수 규칙)", () => {
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat', url: 'https://evil.example/' }, DEFAULT_SPEC)).toMatch(/'chat'/);
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'x' as TabKind }, DEFAULT_SPEC)).toMatch(/'x'/);
    // 새 탭 기본값이 chat 이면 split 등 빈 pane 을 채우는 명령도 거절
    expect(rejectTabCreation({ cmd: 'split', paneId: 'p', orientation: 'horizontal' }, { kind: 'chat', url: 'app://chat' })).toMatch(/split/);
  });
  it('admin · naver · web · kind 없음(기본값) 은 통과', () => {
    for (const kind of ['admin', 'naver', 'web'] as const) {
      expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind } as ShellCommand, DEFAULT_SPEC)).toBeNull();
    }
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p' }, DEFAULT_SPEC)).toBeNull();
    expect(rejectTabCreation({ cmd: 'closeTab', tabId: 't' }, DEFAULT_SPEC)).toBeNull();
    expect(isCreatableTabKind('chat')).toBe(false);
  });
});

describe('R6-a — chat 탭은 챗 pane 호스트가 있을 때 newTab 으로만', () => {
  it('chatEnabled 면 주소 없음 · CHAT_ENTRY_URL 만 통과', () => {
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat' }, DEFAULT_SPEC, { chatEnabled: true })).toBeNull();
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat', url: 'app://chat/index.html' }, DEFAULT_SPEC, { chatEnabled: true })).toBeNull();
  });
  it('chatEnabled 여도 다른 주소 · 새 탭 기본값 chat(split 등)은 거절', () => {
    for (const url of ['https://evil.example/', 'app://chat/', 'app://chat/index.html?x=1', 'app://evil/index.html', 'file:///etc/passwd']) {
      expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat', url }, DEFAULT_SPEC, { chatEnabled: true }), url).toMatch(/'chat'/);
    }
    expect(rejectTabCreation({ cmd: 'split', paneId: 'p', orientation: 'horizontal' }, { kind: 'chat', url: 'app://chat/index.html' }, { chatEnabled: true })).toMatch(/split/);
  });
  it('chatEnabled 가 없으면(호스트 없음) 주소가 맞아도 거절', () => {
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat', url: 'app://chat/index.html' }, DEFAULT_SPEC)).toMatch(/'chat'/);
    expect(rejectTabCreation({ cmd: 'newTab', paneId: 'p', kind: 'chat' }, DEFAULT_SPEC, { chatEnabled: false })).toMatch(/'chat'/);
  });
});

describe('첫 loadURL — 이동과 같은 검사', () => {
  it('admin 첫 화면(DEFAULT_TAB) · AI 채팅 · 대시보드는 그대로(기존 admin 동작 그대로)', () => {
    expect(initialTabUrl('admin', ADMIN_FIRST, null)).toBe(ADMIN_FIRST);
    for (const choice of APP_CONFIG.newTabChoices) {
      if (choice.kind === 'admin') expect(initialTabUrl('admin', choice.url, null)).toBe(choice.url);
    }
    expect(initialTabUrl('web', 'about:blank', null)).toBe('about:blank');
    expect(initialTabUrl('web', 'https://example.com/', null)).toBe('https://example.com/');
  });
  it('허용 밖 주소는 about:blank', () => {
    expect(initialTabUrl('admin', 'https://evil.example/admin', null)).toBe('about:blank');
    expect(initialTabUrl('naver', 'http://127.0.0.1:8000/', null)).toBe('about:blank');
    expect(initialTabUrl('web', 'file:///C:/x.html', null)).toBe('about:blank');
    expect(initialTabUrl('chat', 'app://chat/index.html', null)).toBe('about:blank');
  });
  it('개발판 지문 하네스 주소 하나만 예외(배포판은 null)', () => {
    expect(initialTabUrl('naver', 'http://127.0.0.1:8000/', 'http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/');
    expect(initialTabUrl('naver', 'http://127.0.0.1:9999/', 'http://127.0.0.1:8000/')).toBe('about:blank');
    expect(initialTabUrl('naver', 'about:blank', '')).toBe('about:blank');
  });
});
