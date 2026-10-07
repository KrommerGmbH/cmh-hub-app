// 앱 WebSocket 연결(U11 4번) · 서비스 워커는 30초 쉬면 잠든다

import type { DriverErrorCode, DriverRunResult } from '@cmh-hub-app/driver-core';
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

chrome.runtime.onInstalled.addListener(() => {
  client.connect();
});
