// U07 8-1 · 8-8 · A02 — 세션(partition) 준비. 네이버 세션은 UA 를 «Electron 토막을 뺀 Chromium» 으로 둔다(앞뒤가 맞는 UA · 꾸미지 않는다).
import { app, session, type Session } from 'electron';
import { APP_CONFIG } from '../../config.js';

const DENIED_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'display-capture']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Electron 기본 UA 에서 ` Electron/<판>` 과 ` <앱이름>/<판>` 토막만 뺀다 — Chromium 판은 그대로 남는다 */
export function chromiumLikeUserAgent(base: string = app.userAgentFallback, appName: string = app.getName(), appVersion: string = app.getVersion()): string {
  return base
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${escapeRegExp(appName)}\\/${escapeRegExp(appVersion)}`), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function denyRiskyPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
}

export function prepareSessions(): void {
  const naver = session.fromPartition(APP_CONFIG.naverPartition);
  naver.setUserAgent(chromiumLikeUserAgent(), 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7');
  denyRiskyPermissions(naver);

  const admin = session.fromPartition(APP_CONFIG.adminPartition);
  denyRiskyPermissions(admin);
}
