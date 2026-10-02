// 앱 진입점 — 차례: CDP 가드 → Chromium 스위치(ready 전) → ready → 세션 → IPC → 창
import { app } from 'electron';
import { assertNoRemoteDebugging } from './cdp-guard.js';
import { registerIpc } from './ipc.js';
import { prepareSessions } from './naver/naver-session.js';
import { runSmokeIfRequested } from './smoke.js';
import { createShellWindow } from './window/shell-window.js';

assertNoRemoteDebugging();
// U07 8-2 — navigator.webdriver 를 false 로(Chromium 스위치 · 실제 값은 실측)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(async () => {
  prepareSessions();
  registerIpc();
  const w = await createShellWindow();
  void runSmokeIfRequested(w);
});

app.on('window-all-closed', () => {
  app.quit();
});
