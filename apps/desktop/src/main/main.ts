// 앱 진입점 — 차례: CDP 가드 → Chromium 스위치(ready 전) → ready → 세션 → IPC → 창
import { app } from 'electron';
import { assertNoRemoteDebugging } from './cdp-guard.js';
import { AppSession } from './identity/app-session.js';
import { ensureInstallationIdentity } from './identity/installation-identity.js';
import { startHeartbeat } from './worker/heartbeat.js';
import { LocalLlmEngine } from './worker/local-llm-engine.js';
import { installedLocalModels } from './worker/installed-models.js';
import { startTaskWorker } from './worker/task-worker.js';
import { join } from 'node:path';
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
  // H01 · H03 — 설치 ID 와 서명은 창보다 먼저(첫 요청부터 서명이 붙게)
  const appSession = new AppSession(ensureInstallationIdentity());
  appSession.start();
  const w = await createShellWindow();
  startHeartbeat(appSession, w.window, () => {
    console.warn('[heartbeat] 사장님이 이 설치를 차단했습니다 — 창을 닫습니다');
    w.window.close();
  });
  // W01 · W04 — 이미 내려받은 로컬 모델이 있을 때만 작업을 집는다(내려받기는 W03 동의 뒤)
  const engine = new LocalLlmEngine(join(app.getPath('userData'), 'models'));
  startTaskWorker(appSession, engine, { models: () => installedLocalModels(join(app.getPath('userData'), 'models')) });
  app.on('before-quit', () => void engine.dispose());
  void runSmokeIfRequested(w);
});

app.on('window-all-closed', () => {
  app.quit();
});
