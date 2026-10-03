// 앱 로그 파일 — main 프로세스의 console · 잡히지 않은 오류 · renderer/자식 프로세스 죽음을 `userData/logs/main.log` 에 남긴다.
// 2026-10-03 사장님 «에러 로직 · 별도 log 파일». electron-log 을 안 쓰는 까닭: 그 `initialize()` 는 모든 renderer 에
// preload 를 넣는다 → 서버 · 네이버 페이지 «preload 0»(A02 · U07 8-6)이 깨지고 지문 흔적이 된다.
// 사용자 PC 에 상품 · 고객 자료를 남기지 않는다(W02 9번) — 오류 문장 · 스택 · URL 의 호스트까지만 적는다.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { APP_ERROR_REPORT_LIMITS, type AppErrorEntry } from '@cmh-hub-app/contracts';

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3; // main.log + main.1.log + main.2.log

let logDir: string | null = null;

// ── 서버로 보낼 오류 줄(warn · error) — worker/error-reporter.ts 가 60초마다 가져간다(2026-10-03 사장님 «오류보내기») ──
const REPORT_QUEUE_MAX = 200;
/** 보내는 쪽 자신의 로그 — 다시 줄에 넣으면 보내기 실패가 끝없이 쌓인다 */
export const ERROR_REPORT_TAG = '[error-report]';
const reportQueue: AppErrorEntry[] = [];

function enqueueForReport(level: LogLevel, line: string, now: Date): void {
  if (level === 'info' || line.startsWith(ERROR_REPORT_TAG)) return;
  reportQueue.push({ time: now.toISOString(), level, message: line.slice(0, APP_ERROR_REPORT_LIMITS.maxMessageLength) });
  if (reportQueue.length > REPORT_QUEUE_MAX) reportQueue.splice(0, reportQueue.length - REPORT_QUEUE_MAX); // 오래된 것부터 버린다
}

/** 보낼 묶음을 꺼낸다(최대 max 건) */
export function takeErrorReportBatch(max: number = APP_ERROR_REPORT_LIMITS.maxEntries): AppErrorEntry[] {
  return reportQueue.splice(0, max);
}

/** 보내기 실패 — 꺼낸 묶음을 앞에 되돌린다(상한은 그대로) */
export function returnErrorReportBatch(batch: readonly AppErrorEntry[]): void {
  reportQueue.unshift(...batch);
  if (reportQueue.length > REPORT_QUEUE_MAX) reportQueue.splice(REPORT_QUEUE_MAX);
}

export function pendingErrorReportCount(): number {
  return reportQueue.length;
}

/** `userData/logs` — app 이름(productName)마다 다른 폴더다. 처음 쓸 때 만든다 */
export function logDirectory(): string {
  if (logDir === null) {
    logDir = join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

export function logFilePath(): string {
  return join(logDirectory(), 'main.log');
}

function rotateIfLarge(file: string): void {
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
  const dir = logDirectory();
  rmSync(join(dir, `main.${KEEP_FILES - 1}.log`), { force: true });
  for (let i = KEEP_FILES - 2; i >= 1; i--) {
    const from = join(dir, `main.${i}.log`);
    if (existsSync(from)) renameSync(from, join(dir, `main.${i + 1}.log`));
  }
  renameSync(file, join(dir, 'main.1.log'));
}

/** 값 하나를 한 줄 글로 — Error 는 stack 까지, 객체는 JSON(순환이면 String) */
export function formatLogArg(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatLogLine(level: LogLevel, args: readonly unknown[], now: Date = new Date()): string {
  return `${now.toISOString()} [${level}] ${args.map(formatLogArg).join(' ')}\n`;
}

/** 동기 쓰기 — 죽기 직전 오류도 남게. 로그 쓰기가 실패해도 앱은 멈추지 않는다 */
export function writeLog(level: LogLevel, ...args: unknown[]): void {
  const now = new Date();
  enqueueForReport(level, args.map(formatLogArg).join(' '), now);
  try {
    const file = logFilePath();
    rotateIfLarge(file);
    appendFileSync(file, formatLogLine(level, args, now), 'utf8');
  } catch {
    // 디스크가 꽉 찼거나 권한이 없다 — 콘솔에는 이미 나갔다
  }
}

let installed = false;

/**
 * main.ts 맨 처음에 한 번 부른다. ①console.log/info/warn/error 를 파일에도 ②잡히지 않은 예외 · Promise 거절
 * ③renderer · 자식 프로세스(GPU · utility)가 죽은 것. Electron 기본 «A JavaScript error occurred» 창은 띄우지 않는다 —
 * 사용자에게는 쓸모없는 스택 창이고, 기록은 파일에 남는다(Electron 도 그 창 뒤에 앱을 끄지 않고 계속 돈다).
 */
export function installAppLogger(): void {
  if (installed) return;
  installed = true;
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { original.log(...a); writeLog('info', ...a); };
  console.info = (...a: unknown[]) => { original.info(...a); writeLog('info', ...a); };
  console.warn = (...a: unknown[]) => { original.warn(...a); writeLog('warn', ...a); };
  console.error = (...a: unknown[]) => { original.error(...a); writeLog('error', ...a); };

  process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

  app.on('render-process-gone', (_event, webContents, details) => {
    let host = '';
    try {
      host = new URL(webContents.getURL()).host;
    } catch {
      host = '(주소 없음)';
    }
    console.error('[render-process-gone]', { reason: details.reason, exitCode: details.exitCode, host });
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error('[child-process-gone]', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name });
  });
  writeLog('info', `[app] 시작 · ${app.getName()} ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform} ${process.getSystemVersion()}`);
}
