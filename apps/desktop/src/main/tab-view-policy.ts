// 2026-10-07 검수(RD-a 묶음) — 탭을 만들 때 지키는 규칙 셋. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// ① 셸 명령이 만들 탭 종류는 admin · naver · web 뿐(chat 은 R6 가 자기 정책을 갖기 전까지 만들지 않는다 · 합의안 6)
// ② 탭 view 의 저장 공간(partition)은 종류별로 정해진 것만 — 모르는 종류는 예외(어드민 로그인 쿠키 공간으로 흘리지 않는다)
// ③ 첫 loadURL 도 이동 검사(isAllowedUrl)를 거친다 — 안 맞으면 about:blank
import type { NewTabSpec, ShellCommand, TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../config.js';
import { isAllowedUrl } from './url-policy.js';

export type CreatableTabKind = Exclude<TabKind, 'chat'>;

/** 지금 만들 수 있는 탭 종류 — chat(R6 챗 pane · preload 있음)은 빠진다 */
export const CREATABLE_TAB_KINDS: readonly CreatableTabKind[] = ['admin', 'naver', 'web'];

export function isCreatableTabKind(kind: unknown): kind is CreatableTabKind {
  return typeof kind === 'string' && (CREATABLE_TAB_KINDS as readonly string[]).includes(kind);
}

/**
 * 셸 명령을 엔진(LayoutEngine.apply)에 넘기기 전에 — 만들 탭의 종류가 admin · naver · web 이 아니면 거절 이유(문장) · 괜찮으면 null.
 * newTab 은 명령의 kind 를, 나머지(split · closePane · closeTab · applyLayout — 빈 pane 을 채울 때)는 새 탭 기본값(newTab)의 kind 를 본다.
 * IPC 로 온 명령은 cmd 글자만 확인된 채 오므로(ipc.ts isShellCommand) kind 가 아무 글자일 수 있다.
 */
export function rejectTabCreation(cmd: ShellCommand, newTab: NewTabSpec): string | null {
  if (cmd.cmd === 'newTab' && cmd.kind !== undefined && !isCreatableTabKind(cmd.kind)) {
    return `newTab: 탭 종류 '${String(cmd.kind)}' 는 만들 수 없다(admin · naver · web 만 · chat 은 R6 전까지 막음)`;
  }
  if (!isCreatableTabKind(newTab.kind)) {
    return `${cmd.cmd}: 새 탭 기본값의 종류 '${String(newTab.kind)}' 는 만들 수 없다(admin · naver · web 만)`;
  }
  return null;
}

/** 탭 view 의 partition. 모르는 종류(chat 포함)는 예외 — 기본값(어드민 공간)으로 떨어뜨리지 않는다 */
export function partitionForTabKind(kind: TabKind): string {
  switch (kind) {
    case 'admin':
      return APP_CONFIG.adminPartition;
    case 'naver':
      return APP_CONFIG.naverPartition;
    case 'web':
      return APP_CONFIG.webPartition;
    default:
      throw new Error(`탭 종류 '${String(kind)}' 에는 partition 이 없다(admin · naver · web 만 · chat 은 R6 가 정한다)`);
  }
}

/**
 * 첫 loadURL 주소. 이동(will-navigate · will-redirect)과 같은 isAllowedUrl 을 지나야 하고, 안 맞으면 about:blank.
 * devProbeUrl — 개발판 지문 하네스(fingerprint-probe.ts · CMH_HUB_FP_URL)가 연 주소 하나만 예외(그쪽이 이미 «배포판 아님 · 로컬 http» 를 본다).
 * 배포판은 null 을 넘긴다.
 */
export function initialTabUrl(kind: TabKind, url: string, devProbeUrl: string | null): string {
  if (isAllowedUrl(kind, url)) return url;
  if (devProbeUrl !== null && devProbeUrl !== '' && url === devProbeUrl) return url;
  return 'about:blank';
}
