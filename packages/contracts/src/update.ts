// G03 · G04 — 앱 업데이트 상태(셸 모달이 그린다)
export interface UpdateState {
  state: 'none' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'required';
  version?: string;
  size?: number;
  percent?: number;
  /** 원인 하나만 · 한 줄 */
  message?: string;
  /** G04 — 서버가 이 판을 거절함 · 셸이 «나중에 · 다음 실행 때» 를 숨긴다 */
  mandatory?: boolean;
}
