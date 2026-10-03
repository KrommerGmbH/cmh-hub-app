// 앱 오류 보내기(2026-10-03 사장님 «오류보내기») — app-logger 가 모은 warn · error 를 60초마다 서버로 보낸다.
// 서버(CmhHub HubAppInstallationController::errorReport)가 서명을 보고 var/log/cmh_hub_app_errors-<날짜>.log 에 쓴다.
// 로그인 전 · 서버가 안 받으면 줄에 그대로 두고 다음 틱에 다시 보낸다(앱 PC 의 main.log 에는 이미 남아 있다).
import { app } from 'electron';
import { APP_ROUTES, type AppErrorReportRequest, type AppErrorReportResponse } from '@cmh-hub-app/contracts';
import type { AppSession } from '../identity/app-session.js';
import { ERROR_REPORT_TAG, pendingErrorReportCount, returnErrorReportBatch, takeErrorReportBatch } from '../logging/app-logger.js';

const TICK_MS = 60_000;

export function startErrorReporter(appSession: AppSession): () => void {
  let sending = false;
  const timer = setInterval(() => {
    if (sending || pendingErrorReportCount() === 0) return;
    sending = true;
    void (async () => {
      const entries = takeErrorReportBatch();
      const body: AppErrorReportRequest = { appVersion: app.getVersion(), entries };
      try {
        const r = await appSession.call<AppErrorReportResponse>(APP_ROUTES.errorReport, body);
        if (!r || r.status >= 300) {
          returnErrorReportBatch(entries);
          if (r) console.info(`${ERROR_REPORT_TAG} 서버가 안 받았습니다 · HTTP ${r.status} · 다음 틱에 다시`);
        }
      } catch (error) {
        returnErrorReportBatch(entries);
        console.info(`${ERROR_REPORT_TAG} 보내기 실패 · 다음 틱에 다시`, error instanceof Error ? error.message : String(error));
      } finally {
        sending = false;
      }
    })();
  }, TICK_MS);
  return () => clearInterval(timer);
}
