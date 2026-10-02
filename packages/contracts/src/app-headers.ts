// H03 · G04 · 서버 T41-2 — 헤더 이름은 여기 한 곳(CmhHub PHP 와 같은 이름)
export const APP_HEADERS = {
  installation: 'X-Cmh-App-Installation',
  timestamp: 'X-Cmh-App-Timestamp',
  nonce: 'X-Cmh-App-Nonce',
  signature: 'X-Cmh-App-Signature',
  version: 'X-Cmh-App-Version',
  /** 서버 → 앱 · 응답 헤더 · 값은 AppErrorCode */
  error: 'X-Cmh-App-Error',
} as const;

export type AppErrorCode = 'unknown-installation' | 'bad-signature' | 'blocked' | 'app-too-old';

/** 서버 라우트(T41 · T44) — 서버 호스트 뒤에 붙는다 */
export const APP_ROUTES = {
  installationRegister: '/api/_action/cmh-hub-app/installation/register',
  heartbeat: '/api/_action/cmh-hub-app/heartbeat',
  taskNext: '/api/_action/cmh-hub-app/task/next',
  taskHeartbeat: '/api/_action/cmh-hub-app/task/heartbeat',
  taskDone: '/api/_action/cmh-hub-app/task/done',
  taskRelease: '/api/_action/cmh-hub-app/task/release',
  companyModelKey: '/api/_action/cmh-hub-app/company/model-key',
} as const;

export interface InstallationRegisterRequest {
  installationId: string;
  publicKeyPem: string;
  os: string;
  osVersion: string;
  appVersion: string;
}

export interface HeartbeatRequest {
  activeSeconds: number;
  appVersion: string;
}

export interface HeartbeatResponse {
  status: 'active' | 'blocked';
  /** 선택 — 서버 어드민 빌드가 바뀌면 셸이 «새로고침» 띠(G04 끝줄) */
  adminBuildId?: string;
}
