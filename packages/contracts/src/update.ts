// G03 · G04 — 앱 업데이트 상태(셸 모달이 그린다)
export interface UpdateState {
  state: 'none' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'required';
  version?: string;
  size?: number;
  percent?: number;
  /** 원인 하나만 · 한 줄 */
  message?: string;
}
