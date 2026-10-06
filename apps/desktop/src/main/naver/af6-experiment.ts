// AF-6 네이버 봇 탐지 실험 runner (U07a 다음 · 계획서 표 14 · 사장님 계정 실측 전 시험)
// - 사장님 승인 전: CMH_HUB_AF6=1 로 서버 origin 쇼핑몰 첫 화면만 도는 시험 모드
// - 사장님 승인 뒤: CMH_HUB_AF6=1 + CMH_HUB_AF6_NAVER=1 일 때만 네이버 판매자센터 탭을 조작
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG } from '../../config.js';
import type { ShellWindow } from '../window/shell-window.js';
import { NaverPaneDriver, type DriverStep } from './naver-pane-driver.js';

export interface Af6Signals {
  captcha: boolean;
  loginBounce: boolean;
  blocked: boolean;
}

const CAPTCHA_PATTERN = /captcha|자동입력\s?방지|보안\s?문자|로봇이\s?아닙니다|recaptcha/i;
const BLOCKED_PATTERN = /비정상적인\s?접근|접근이\s?제한|일시적으로\s?제한|unusual traffic|access denied|blocked/i;

export function detectSignals(bodyText: string, url: string): Af6Signals {
  const captcha = CAPTCHA_PATTERN.test(bodyText);
  const loginBounce =
    url.includes('nid.naver.com') ||
    url.includes('accounts.commerce.naver.com') ||
    url.includes('#/login');
  const blocked = BLOCKED_PATTERN.test(bodyText);
  return { captcha, loginBounce, blocked };
}

export interface Af6DayState {
  date: string;
  runs: number;
  captchas: number;
  bounces: number;
  blocks: number;
  stoppedReason: string | null;
}

export const AF6_DAILY_CAP = 50;
export const AF6_MAX_CAPTCHAS = 2;
export const AF6_MAX_BOUNCES = 1;
export const AF6_MAX_BLOCKS = 1;

export function stopReason(state: Af6DayState): string | null {
  // 차례: daily-cap -> login-bounce -> blocked -> captcha
  if (state.runs >= AF6_DAILY_CAP) return 'daily-cap';
  if (state.bounces >= AF6_MAX_BOUNCES) return 'login-bounce';
  if ((state.blocks ?? 0) >= AF6_MAX_BLOCKS) return 'blocked';
  if (state.captchas >= AF6_MAX_CAPTCHAS) return 'captcha';
  return null;
}

export function dayKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDayState(
  raw: string,
  today: string,
): { ok: true; state: Af6DayState } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['date'] !== 'string') {
    return { ok: false };
  }

  if (obj['date'] !== today) {
    return {
      ok: true,
      state: {
        date: today,
        runs: 0,
        captchas: 0,
        bounces: 0,
        blocks: 0,
        stoppedReason: null,
      },
    };
  }

  if (
    typeof obj['runs'] !== 'number' ||
    typeof obj['captchas'] !== 'number' ||
    typeof obj['bounces'] !== 'number'
  ) {
    return { ok: false };
  }

  const blocks = typeof obj['blocks'] === 'number' ? obj['blocks'] : 0;
  const stoppedReason =
    typeof obj['stoppedReason'] === 'string' || obj['stoppedReason'] === null
      ? (obj['stoppedReason'] as string | null)
      : null;

  return {
    ok: true,
    state: {
      date: today,
      runs: obj['runs'],
      captchas: obj['captchas'],
      bounces: obj['bounces'],
      blocks,
      stoppedReason,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRuns(envVal: string | undefined): number {
  const parsed = parseInt(envVal ?? '3', 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 3;
}

function parseGapMs(envVal: string | undefined): number {
  if (envVal !== undefined && envVal.trim() !== '') {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed)) {
      return Math.max(1000, parsed);
    }
  }
  return Math.floor(Math.random() * (90000 - 20000 + 1)) + 20000;
}

export function runAf6ExperimentIfRequested(w: ShellWindow): void {
  if (!process.env['CMH_HUB_AF6'] || app.isPackaged) return;

  void (async () => {
    try {
      await sleep(8000);

      const isNaverMode = process.env['CMH_HUB_AF6_NAVER'] === '1';
      const mode: 'naver' | 'test' = isNaverMode ? 'naver' : 'test';

      const active = w.activeTabOfFocusedPane();
      if (!active?.activeTabId) {
        console.warn('[af6] 포커스 pane 의 활성 탭을 찾을 수 없습니다');
        return;
      }

      const tab = w.engine.getTab(active.activeTabId);
      if (mode === 'naver') {
        if (tab?.kind !== 'naver') {
          console.warn('[af6] 네이버 모드에는 포커스 pane 활성 탭이 naver 여야 합니다');
          return;
        }
      } else {
        if (tab?.kind === 'naver') {
          console.warn('[af6] 시험 모드에서는 네이버 탭을 쓰지 않습니다');
          return;
        }
      }

      const view = w.views.get(active.activeTabId);
      if (!view || view.webContents.isDestroyed()) {
        console.warn('[af6] 활성 탭 view 를 찾을 수 없습니다');
        return;
      }

      const wc = view.webContents;
      const allowedOrigins =
        mode === 'naver'
          ? ['https://sell.smartstore.naver.com']
          : [new URL(APP_CONFIG.serverOrigin).origin];

      const logsDir = join(app.getPath('userData'), 'logs');
      mkdirSync(logsDir, { recursive: true });

      const today = dayKey(new Date());
      // 모드마다 따로 세지 않는다 — 시험 모드도 같이 센다고 주석으로 적고, 대신 test 모드 상태 파일 이름은 af6-state-test-<dayKey>.json 으로 갈라 네이버 상한을 먹지 않게
      const stateFileName = mode === 'naver' ? `af6-state-${today}.json` : `af6-state-test-${today}.json`;
      const stateFilePath = join(logsDir, stateFileName);
      const jsonlFilePath = join(logsDir, `af6-${today}.jsonl`);

      let state: Af6DayState = {
        date: today,
        runs: 0,
        captchas: 0,
        bounces: 0,
        blocks: 0,
        stoppedReason: null,
      };

      if (existsSync(stateFilePath)) {
        try {
          const raw = readFileSync(stateFilePath, 'utf8');
          const parsed = parseDayState(raw, today);
          if (!parsed.ok) {
            if (mode === 'naver') {
              console.warn('[af6] 상태 파일이 깨졌습니다 — 오늘 상한을 알 수 없어 멈춥니다', stateFilePath);
              return;
            }
            console.warn('[af6] 상태 파일 읽기 실패, 초기화합니다', stateFilePath);
          } else {
            state = parsed.state;
          }
        } catch (err) {
          if (mode === 'naver') {
            console.warn('[af6] 상태 파일이 깨졌습니다 — 오늘 상한을 알 수 없어 멈춥니다', stateFilePath);
            return;
          }
          console.warn('[af6] 상태 파일 읽기 실패, 초기화합니다', err);
        }
      }

      const requestedRuns = parseRuns(process.env['CMH_HUB_AF6_RUNS']);
      const remainingRuns = Math.max(0, AF6_DAILY_CAP - state.runs);
      const runsToExecute = Math.min(requestedRuns, remainingRuns);

      for (let i = 0; i < runsToExecute; i++) {
        const initialStop = stopReason(state);
        if (initialStop) {
          console.info(`[af6] 실행 전 중단 사유 발견 (${initialStop}) — 중단합니다`);
          state.stoppedReason = initialStop;
          writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
          break;
        }

        if (wc.isDestroyed()) {
          console.warn('[af6] webContents 가 소멸되었습니다');
          break;
        }

        let lastHttpStatus: number | null = null;
        const onDidNavigate = (
          _e: Electron.Event,
          _url: string,
          httpResponseCode: number,
        ): void => {
          lastHttpStatus = httpResponseCode;
        };

        wc.on('did-navigate', onDidNavigate);

        let driverOk = false;
        let driverError: unknown = null;

        try {
          const driver = new NaverPaneDriver(wc, { allowedOrigins });
          const deltaY = Math.floor(Math.random() * (900 - 300 + 1)) + 300;
          const waitMs = Math.floor(Math.random() * (2500 - 800 + 1)) + 800;

          const steps: DriverStep[] =
            mode === 'naver'
              ? [
                  { op: 'goto', url: 'https://sell.smartstore.naver.com/#/home' },
                  { op: 'read', selector: 'title' },
                  { op: 'scroll', deltaY },
                  { op: 'wait', ms: waitMs },
                  { op: 'scroll', deltaY: -deltaY },
                  { op: 'read', selector: 'title' },
                ]
              : [
                  { op: 'goto', url: `${APP_CONFIG.serverOrigin}/` },
                  { op: 'read', selector: 'title' },
                  { op: 'scroll', deltaY },
                  { op: 'wait', ms: waitMs },
                  { op: 'scroll', deltaY: -deltaY },
                  // 스크롤이 부드럽게 움직이는 중일 수 있다 · driver-check 와 같게
                  { op: 'wait', ms: 1200 },
                  { op: 'click', selector: 'a.header-logo-main-link' },
                  { op: 'wait', ms: 1500 },
                  { op: 'read', selector: 'title' },
                ];

          const result = await driver.run(steps);
          driverOk = result.ok;
          driverError = result.error;
        } catch (err) {
          driverOk = false;
          driverError = err instanceof Error ? { code: 'run-error', message: err.message } : err;
        } finally {
          wc.removeListener('did-navigate', onDidNavigate);
        }

        let bodyText = '';
        let bodyReadFailed = false;
        if (!wc.isDestroyed()) {
          try {
            const script =
              '(() => { try { return document.body ? document.body.innerText.slice(0, 20000) : ""; } catch { return ""; } })()';
            const text = await wc.executeJavaScriptInIsolatedWorld(1212, [{ code: script }]);
            if (typeof text === 'string') {
              bodyText = text;
            }
          } catch (err) {
            bodyText = '';
            bodyReadFailed = true;
            const firstLine = String(err instanceof Error ? err.message : err).split('\n')[0] ?? '';
            console.warn('[af6] 본문 읽기 실패 — 캡차 · 차단을 이번 실행에서 못 봄', firstLine);
          }
        }

        const currentUrl = !wc.isDestroyed() ? wc.getURL() : '';
        const signals = detectSignals(bodyText, currentUrl);

        state.runs += 1;
        if (signals.captcha) state.captchas += 1;
        if (signals.loginBounce) state.bounces += 1;
        if (signals.blocked) state.blocks += 1;
        state.stoppedReason = stopReason(state);

        writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');

        const logEntry = {
          at: new Date().toISOString(),
          mode,
          run: state.runs,
          url: currentUrl,
          httpStatus: lastHttpStatus,
          driverOk,
          driverError,
          signals,
          bodyReadFailed,
          state,
        };
        appendFileSync(jsonlFilePath, JSON.stringify(logEntry) + '\n', 'utf8');

        console.info(
          `[af6] run=${state.runs} mode=${mode} driverOk=${driverOk} captcha=${signals.captcha} bounce=${signals.loginBounce} blocked=${signals.blocked}`,
        );

        if (state.stoppedReason) {
          console.info(`[af6] 중단 사유 발생 (${state.stoppedReason}) — 다음 실행을 멈춥니다`);
          break;
        }

        if (i < runsToExecute - 1) {
          const gapMs = parseGapMs(process.env['CMH_HUB_AF6_GAP_MS']);
          await sleep(gapMs);
        }
      }

      console.info('[af6] 끝', JSON.stringify(state));
    } catch (error) {
      console.error('[af6] 실패', error);
    }
  })();
}
