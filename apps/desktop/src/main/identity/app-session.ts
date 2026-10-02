// H02 · H03 · H04 · W01 — 서버와 이야기하는 main 쪽 한 곳.
// ① 어드민 세션의 모든 서버 요청에 서명 헤더(onBeforeSendHeaders) ② 서버가 «모르는 설치»(403 + X-Cmh-App-Error) 라고 하면 설치 등록
// ③ main 이 직접 부르는 API(heartbeat · task)는 bearerAuth 쿠키의 토큰 + 서명으로.
import { app, session, type Session } from 'electron';
import { APP_HEADERS, APP_ROUTES, type AppErrorCode, type InstallationRegisterRequest } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../../config.js';
import { signHeaders } from './signature.js';
import type { InstallationIdentity } from './installation-identity.js';

export class AppSession {
  readonly admin: Session;
  private registering = false;
  private lastError: AppErrorCode | null = null;
  private onErrorListeners: Array<(code: AppErrorCode) => void> = [];

  constructor(private readonly identity: InstallationIdentity) {
    this.admin = session.fromPartition(APP_CONFIG.adminPartition);
  }

  start(): void {
    const filter = { urls: [`${APP_CONFIG.serverOrigin}/api/*`] };
    this.admin.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (!headers[APP_HEADERS.signature]) Object.assign(headers, this.sign(details.method, details.url));
      callback({ requestHeaders: headers });
    });
    this.admin.webRequest.onCompleted(filter, (details) => {
      if (details.statusCode !== 403) return;
      const raw = details.responseHeaders?.[APP_HEADERS.error] ?? details.responseHeaders?.[APP_HEADERS.error.toLowerCase()];
      const code = (Array.isArray(raw) ? raw[0] : raw) as AppErrorCode | undefined;
      if (!code) return;
      this.lastError = code;
      if (code === 'unknown-installation') void this.register();
      for (const l of this.onErrorListeners) l(code);
    });
  }

  onAppError(cb: (code: AppErrorCode) => void): void {
    this.onErrorListeners.push(cb);
  }

  get installationId(): string {
    return this.identity.installationId;
  }

  /** 어드민 로그인 토큰 — Shopware 어드민이 쿠키 bearerAuth 에 JSON {access, refresh, expiry} 로 둔다(login.service.ts:67-74) */
  async accessToken(): Promise<string | null> {
    const cookies = await this.admin.cookies.get({ url: APP_CONFIG.serverOrigin, name: 'bearerAuth' });
    const raw = cookies[0]?.value;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as { access?: unknown };
      return typeof parsed.access === 'string' ? parsed.access : null;
    } catch {
      return null;
    }
  }

  /** main 이 직접 부르는 서버 API — 로그인 전이면 null */
  async call<T>(path: string, body: unknown): Promise<{ status: number; data: T | null; appError: AppErrorCode | null } | null> {
    const token = await this.accessToken();
    if (!token) return null;
    const url = `${APP_CONFIG.serverOrigin}${path}`;
    const res = await this.admin.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}`, ...this.sign('POST', url) },
      body: JSON.stringify(body ?? {}),
    });
    const appError = (res.headers.get(APP_HEADERS.error) as AppErrorCode | null) ?? null;
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { status: res.status, data, appError };
  }

  private sign(method: string, url: string): Record<string, string> {
    return signHeaders({ installationId: this.identity.installationId, privateKey: this.identity.privateKey, method, url, appVersion: app.getVersion() });
  }

  private async register(): Promise<void> {
    if (this.registering) return;
    this.registering = true;
    try {
      const body: InstallationRegisterRequest = {
        installationId: this.identity.installationId,
        publicKeyPem: this.identity.publicKeyPem,
        os: process.platform,
        osVersion: process.getSystemVersion(),
        appVersion: app.getVersion(),
      };
      const r = await this.call<{ status?: string }>(APP_ROUTES.installationRegister, body);
      console.info('[identity] register', r?.status, r?.data);
      if (r && r.status < 300) this.lastError = null;
    } finally {
      this.registering = false;
    }
  }
}
