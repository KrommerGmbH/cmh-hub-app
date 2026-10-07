import { runReadSteps } from './content-runner.js';

// 메시지 수신 핸들러 — background 서비스 워커 또는 팝업 등에서 전송된 작업 실행
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cmh-run') return;
  runReadSteps(document, window, msg.steps)
    .then(sendResponse)
    .catch((err) => {
      const raw = err instanceof Error ? err.message : String(err);
      const firstLine = raw.split('\n')[0] ?? '';
      sendResponse({
        ok: false,
        steps: [],
        error: { code: 'invalid-step', message: firstLine.slice(0, 200) },
      });
    });
  return true;
});

// 개발 시험 고리: location.hash === '#cmh-ext-check' 이면 페이지 로드 후 고정 단계를 실행하여 DOM dataset 에 기록
// DOM 은 world 사이에 공유되므로 Electron 하네스가 읽는다 (B2)
// matches 는 심는 곳만 정한다 — 네이버에서는 hostname 으로 막는다(2026-10-07 검수)
if (window.location.hostname !== 'sell.smartstore.naver.com' && window.location.hash === '#cmh-ext-check') {
  const checkSteps = [
    { op: 'read', selector: 'title' },
    { op: 'scroll', deltaY: 300 },
    { op: 'wait', ms: 300 },
    { op: 'scroll', deltaY: -300 },
    { op: 'read', selector: 'a.header-logo-main-link' },
  ] as const;

  const runCheck = () => {
    runReadSteps(document, window, checkSteps).then((res) => {
      document.documentElement.dataset['cmhExtCheck'] = JSON.stringify(res);
    });
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    runCheck();
  } else {
    window.addEventListener('DOMContentLoaded', runCheck, { once: true });
  }
}
