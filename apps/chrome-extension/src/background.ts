// 앱 WebSocket 연결(U11 4번)은 다음 단계 · 서비스 워커는 30초 쉬면 잠든다

import type { DriverErrorCode, DriverRunResult } from '@cmh-hub-app/driver-core';

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'cmh-run-in-tab') {
    return;
  }

  const steps = message.steps;

  chrome.tabs
    .query({ url: 'https://sell.smartstore.naver.com/*' })
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
        sendResponse(failure);
        return;
      }

      chrome.tabs
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
            sendResponse(failure);
            return;
          }
          sendResponse(result);
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
          sendResponse(failure);
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
      sendResponse(failure);
    });

  return true;
});
