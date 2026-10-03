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
  /** 앱 오류 보내기(2026-10-03 사장님 «오류보내기») — 서버 var/log/cmh_hub_app_errors-<날짜>.log 에 쓴다 */
  errorReport: '/api/_action/cmh-hub-app/error-report',
  // 작업 큐는 CmhAiAgent 기존 라우트 /api/_action/cmh-ai/task/* 를 쓴다(task-worker.ts) — 옛 cmh-hub-app/task/* 넷은 서버에 없어 지웠다(2026-10-03)
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

/** 앱 오류 한 건 — 오류 문장 · 스택만(상품 · 고객 자료를 넣지 않는다 · app-logger.ts) */
export interface AppErrorEntry {
  /** ISO 시각(앱 PC 시계) */
  time: string;
  level: 'warn' | 'error';
  /** 한 줄 또는 스택 — 앱이 4000자로 자른다 */
  message: string;
}

export interface AppErrorReportRequest {
  appVersion: string;
  /** 한 번에 50건까지 */
  entries: AppErrorEntry[];
}

/** 200 = stored | over-limit(하루 상한 · 다시 보내지 않는다) · 429 = 분당 2번 넘음(다음 틱에 다시) */
export interface AppErrorReportResponse {
  stored: number;
  result: 'stored' | 'over-limit' | 'throttled';
}

export const APP_ERROR_REPORT_LIMITS = { maxEntries: 50, maxMessageLength: 4000 } as const;
