// H04 — 60초마다 «실제로 쓴 시간»만 보낸다(idle < 300초 · 창 focus). suspend 동안 멈춘다. 끊기면 모아 뒀다가 보낸다(하루 상한 86400).
import { app, powerMonitor, type BaseWindow } from 'electron';
import { APP_ROUTES, type HeartbeatRequest, type HeartbeatResponse } from '@cmh-hub-app/contracts';
import type { AppSession } from '../identity/app-session.js';

const TICK_MS = 60_000;
const IDLE_LIMIT_S = 300;

export function startHeartbeat(appSession: AppSession, window: BaseWindow, onBlocked: () => void): () => void {
  let pending = 0;
  let suspended = false;
  let lastTick = Date.now();
  powerMonitor.on('suspend', () => { suspended = true; });
  powerMonitor.on('resume', () => { suspended = false; lastTick = Date.now(); });

  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      const elapsed = Math.round((now - lastTick) / 1000);
      lastTick = now;
      if (!suspended && window.isFocused() && powerMonitor.getSystemIdleTime() < IDLE_LIMIT_S) {
        pending = Math.min(86_400, pending + Math.min(elapsed, 90));
      }
      if (pending === 0) return;
      const body: HeartbeatRequest = { activeSeconds: Math.min(pending, 90), appVersion: app.getVersion() };
      const r = await appSession.call<HeartbeatResponse>(APP_ROUTES.heartbeat, body).catch(() => null);
      if (!r || r.status >= 300) return; // 모아 둔 채 다음 틱
      pending -= body.activeSeconds;
      if (r.data?.status === 'blocked') onBlocked();
    })();
  }, TICK_MS);
  return () => clearInterval(timer);
}
