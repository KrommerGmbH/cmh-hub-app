// 앱 진입점 — 차례: CDP 가드 → Chromium 스위치(ready 전) → ready → 세션 → IPC → 창
import { app } from 'electron';
import { assertNoRemoteDebugging } from './cdp-guard.js';
import { APP_USER_MODEL_ID, ensureDevShortcuts } from './app-identity.js';
import { installAppLogger } from './logging/app-logger.js';
import { AppSession } from './identity/app-session.js';
import { ensureInstallationIdentity } from './identity/installation-identity.js';
import { startErrorReporter } from './worker/error-reporter.js';
import { startHeartbeat } from './worker/heartbeat.js';
import { LocalLlmEngine } from './worker/local-llm-engine.js';
import { installedLocalModels } from './worker/installed-models.js';
import { startTaskWorker } from './worker/task-worker.js';
import { join } from 'node:path';
import { registerIpc } from './ipc.js';
import { prepareSessions } from './naver/naver-session.js';
import { runFingerprintProbeIfRequested } from './fingerprint-probe.js';
import { runSmokeIfRequested } from './smoke.js';
import { runCredentialCheckIfRequested } from './credentials/credential-check.js';
import { runParallelCheckIfRequested } from './parallel-check.js';
import { runDriverCheckIfRequested } from './naver/driver-check.js';
import { createShellWindow } from './window/shell-window.js';

installAppLogger(); // 맨 먼저 — 아래 가드가 앱을 끄는 까닭도 파일에 남게
assertNoRemoteDebugging();
// U07 8-2 — navigator.webdriver 를 false 로(Chromium 스위치 · 실제 값은 실측)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// U07 8-13b — navigator.language · Intl 이 OS 표시 언어(사장님 PC 는 독일어 → "de")를 따라가 네이버 사용자 크롬(ko-KR)과 어긋났다(2026-10-03 지문 비교)
app.commandLine.appendSwitch('lang', 'ko-KR');
// Windows 작업 표시줄이 이 앱을 electron.exe 가 아니라 «CMH Hub» 로 묶고 창 아이콘을 쓰게(electron-builder appId 와 같은 값)
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

app.whenReady().then(async () => {
  ensureDevShortcuts(); // 개발판만 — 작업 표시줄 · 알림에 Electron 로고 대신 CMH Hub 아이콘(2026-10-05)
  await prepareSessions();
  registerIpc();
  // H01 · H03 — 설치 ID 와 서명은 창보다 먼저(첫 요청부터 서명이 붙게)
  const appSession = new AppSession(ensureInstallationIdentity());
  appSession.start();
  // 오류 보내기 — 로그인 전에 쌓인 것도 로그인 뒤 첫 틱에 간다
  startErrorReporter(appSession);
  // 끝-끝 시험용(개발판만) — 서버 var/log/cmh_hub_app_errors-<날짜>.log 에 이 줄이 오면 길이 다 이어진 것이다
  if (process.env['CMH_HUB_TEST_ERROR'] && !app.isPackaged) console.error('[test] 오류 보내기 끝-끝 시험', new Date().toISOString());
  const w = await createShellWindow(appSession); // U10 — 오른쪽 클릭 «AI 작업» 이 서버 화면 표(cmh-ai-screen)를 읽는 데 세션을 쓴다
  w.updater.start(); // G03 — 배포판만 확인(개발판은 안 함)
  // G04 — 서버가 이 판을 거절하면(403 app-too-old) 필수 업데이트 모달(«나중에» 없음)
  appSession.onAppError((code) => { if (code === 'app-too-old') w.updater.markRequired(); });
  startHeartbeat(appSession, w.window, () => {
    console.warn('[heartbeat] 사장님이 이 설치를 차단했습니다 — 창을 닫습니다');
    w.window.close();
  });
  // W01 · W04 — 이미 내려받은 로컬 모델이 있을 때만 작업을 집는다(내려받기는 W03 동의 뒤)
  const engine = new LocalLlmEngine(join(app.getPath('userData'), 'models'));
  // 지문 비교 실행(CMH_HUB_FP_URL)은 곧 강제로 꺼지므로 작업을 집지 않는다 — 집은 채로 꺼지면 lease 가 10분 묶인다
  if (!process.env['CMH_HUB_FP_URL'] && !process.env['CMH_HUB_CRED_CHECK'] && !process.env['CMH_HUB_PARALLEL']) {
    startTaskWorker(appSession, engine, { models: () => installedLocalModels(join(app.getPath('userData'), 'models')) });
  }
  app.on('before-quit', () => void engine.dispose());
  void runSmokeIfRequested(w);
  runFingerprintProbeIfRequested(w);
  runCredentialCheckIfRequested(w.window);
  runParallelCheckIfRequested(w); // U07 ⑥⑦ 병렬 시험(개발판 · CMH_HUB_PARALLEL=1)
  runDriverCheckIfRequested(w); // U07a 읽기 전용 드라이버 실측(개발판 · CMH_HUB_DRIVER_CHECK=1 · 어드민 탭만)
});

app.on('window-all-closed', () => {
  app.quit();
});
