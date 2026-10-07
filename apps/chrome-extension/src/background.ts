// 앱 WebSocket 연결(U11 4번) · 서비스 워커는 30초 쉬면 잠든다

import type {
  ContextElement,
  ContextIntentKey,
  DriverErrorCode,
  DriverRunResult,
} from '@cmh-hub-app/driver-core';
import { BRIDGE_DEFAULT_PORT } from '@cmh-hub-app/driver-core';

import type { WebSocketLike } from './bridge-client.js';
import { BridgeClient } from './bridge-client.js';

export type BackgroundErrorCode =
  | DriverErrorCode
  | 'no-seller-tab'
  | 'tab-error'
  | 'no-content-script';

export interface BackgroundRunResult extends Omit<DriverRunResult, 'error'> {
  error: { code: BackgroundErrorCode; message: string } | null;
}

function extractErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split('\n')[0] ?? '').slice(0, 200);
}

export function runInSellerTab(steps: unknown[]): Promise<BackgroundRunResult> {
  const matches = chrome.runtime.getManifest().content_scripts?.[0]?.matches;
  const urlPattern =
    matches && matches.length > 0 ? matches : ['https://sell.smartstore.naver.com/*'];

  return chrome.tabs
    .query({ url: urlPattern })
    .then((tabs) => {
      // 활성(active) 상태인 탭을 먼저 고르고, 없으면 유효한 id를 가진 첫 번째 탭을 선택한다
      const targetTab =
        tabs.find((t) => t.active && typeof t.id === 'number') ??
        tabs.find((t) => typeof t.id === 'number');

      if (!targetTab || typeof targetTab.id !== 'number') {
        const failure: BackgroundRunResult = {
          ok: false,
          steps: [],
          error: {
            code: 'no-seller-tab',
            message: '판매자센터 탭이 없습니다',
          },
        };
        return failure;
      }

      return chrome.tabs
        .sendMessage(targetTab.id, { type: 'cmh-run', steps })
        .then((result: BackgroundRunResult | undefined) => {
          if (!result) {
            const failure: BackgroundRunResult = {
              ok: false,
              steps: [],
              error: {
                code: 'no-content-script',
                message: 'content script 응답이 없습니다',
              },
            };
            return failure;
          }
          return result;
        })
        .catch((err: unknown) => {
          const failure: BackgroundRunResult = {
            ok: false,
            steps: [],
            error: {
              code: 'tab-error',
              message: extractErrorMessage(err),
            },
          };
          return failure;
        });
    })
    .catch((err: unknown) => {
      const failure: BackgroundRunResult = {
        ok: false,
        steps: [],
        error: {
          code: 'tab-error',
          message: extractErrorMessage(err),
        },
      };
      return failure;
    });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'cmh-run-in-tab') {
    return;
  }

  runInSellerTab(message.steps).then(sendResponse);
  return true;
});

const client = new BridgeClient('ws://127.0.0.1:' + BRIDGE_DEFAULT_PORT, {
  createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike,
  runSteps: (steps) => runInSellerTab(steps) as Promise<DriverRunResult>,
  extVersion: chrome.runtime.getManifest().version,
  log: (m) => console.info('[cmh-bridge] ' + m),
  setTimer: (fn, ms) => setTimeout(fn, ms),
});
client.connect();

// Chrome 116+ 는 WebSocket 송수신이 잠듦 타이머를 되돌린다 · alarms 는 최소 30초(공식 문서)
chrome.alarms.create('cmh-bridge-wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cmh-bridge-wake' && !client.isOpen()) {
    client.connect();
  }
});

chrome.runtime.onStartup.addListener(() => {
  client.connect();
});

function setupContextMenus(): void {
  if (!chrome.contextMenus) {
    return;
  }
  chrome.contextMenus.removeAll(() => {
    const matches = chrome.runtime.getManifest().content_scripts?.[0]?.matches;
    const documentUrlPatterns =
      matches && matches.length > 0 ? matches : ['https://sell.smartstore.naver.com/*'];

    chrome.contextMenus.create({
      id: 'cmh-ai',
      title: 'CMH AI 작업',
      contexts: ['all'],
      documentUrlPatterns,
    });

    const menuItems: Array<{ key: ContextIntentKey; label: string }> = [
      { key: 'suggest_value', label: 'AI 값 제안' },
      { key: 'check_rules', label: '네이버 규칙 검사' },
      { key: 'explain_field', label: '이 칸 설명' },
      { key: 'explain_button', label: '이 단추가 하는 일' },
      { key: 'summarize_screen', label: '이 화면 요약' },
    ];

    for (const item of menuItems) {
      chrome.contextMenus.create({
        id: `cmh-ai:${item.key}`,
        parentId: 'cmh-ai',
        title: item.label,
        contexts: ['all'],
        documentUrlPatterns,
      });
    }
  });
}

// 앱 파서(driver-core parseBridgeToApp)는 문자열 칸이 500자를 넘으면 메시지를 통째로 버린다 → 보내기 전에 자른다
const CONTEXT_STRING_MAX = 500;

function clipText(v: string): string {
  return v.length > CONTEXT_STRING_MAX ? v.slice(0, CONTEXT_STRING_MAX) : v;
}

function clipNullable(v: string | null): string | null {
  return v === null ? null : clipText(v);
}

function clipContextElement(el: ContextElement): ContextElement {
  return {
    tag: clipText(el.tag),
    type: clipNullable(el.type),
    name: clipNullable(el.name),
    id: clipNullable(el.id),
    role: clipNullable(el.role),
    label: clipNullable(el.label),
    text: clipText(el.text),
    value: clipNullable(el.value),
    selector: clipText(el.selector),
  };
}

function forwardContextAction(
  intentKey: ContextIntentKey,
  element: ContextElement | null,
  pageUrl: string,
  pageTitle: string,
): void {
  // 요소에 맞지 않는 작업(예: 단추에 «AI 값 제안»)을 골라도 그대로 넘긴다(앱이 글을 만든다 · 1차)
  const sent = client.send({
    type: 'context-action',
    intentKey,
    element: element ? clipContextElement(element) : null,
    pageUrl: clipText(pageUrl),
    pageTitle: clipText(pageTitle),
  });
  if (!sent) {
    // 알림 API 는 권한을 더 늘리니 이번엔 안 씀
    console.warn('[cmh-bridge] 앱이 연결되지 않아 AI 작업을 넘기지 못했습니다');
  }
}

// Electron(ext-check)은 chrome.contextMenus 가 없다 — 없으면 메뉴만 건너뛰고 연결은 산다
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  const menuId = String(info.menuItemId);
  if (!menuId.startsWith('cmh-ai:')) {
    return;
  }
  const intentKey = menuId.slice('cmh-ai:'.length) as ContextIntentKey;
  if (!tab || typeof tab.id !== 'number') {
    return;
  }
  const fallbackUrl = tab.url || info.pageUrl || '';
  const fallbackTitle = tab.title || '';

  // content script 는 맨 위 프레임에만 있다 — iframe 안 클릭은 그 프레임의 contextmenu 를 못 받아
  // 기억한 요소가 옛것이다 → 요소 없이(화면 기준) 넘긴다 · 주소는 탭 주소(앱이 판매자센터 화면을 찾는 기준)
  if (info.frameId !== undefined && info.frameId !== 0) {
    forwardContextAction(intentKey, null, fallbackUrl, fallbackTitle);
    return;
  }

  chrome.tabs
    .sendMessage(tab.id, { type: 'cmh-last-element' }, { frameId: 0 })
    .then((response: { element?: ContextElement | null; pageUrl?: string; pageTitle?: string } | undefined) => {
      forwardContextAction(
        intentKey,
        response?.element ?? null,
        response?.pageUrl || fallbackUrl,
        response?.pageTitle || fallbackTitle,
      );
    })
    .catch(() => {
      forwardContextAction(intentKey, null, fallbackUrl, fallbackTitle);
    });
});

chrome.runtime.onInstalled.addListener(() => {
  client.connect();
  setupContextMenus();
});
