// 빌드에 고정되는 값(A02 — 사용자가 URL 을 넣지 않는다 · phishing 차단)
export const APP_CONFIG = {
  /** 서버 어드민 호스트 — https:// 만 */
  serverOrigin: 'https://testumgebung.my-mik.de',
  adminPath: '/admin',
  /** admin 탭이 갈 수 있는 호스트 */
  adminHosts: ['testumgebung.my-mik.de'],
  /**
   * naver 탭이 갈 수 있는 호스트 — 접미사로 본다. 판매자센터 정확한 호스트는 코딩 전 실측(cmh_ai_screen 의 URL · PLAN A02).
   * 로그인(nid.naver.com)도 naver.com 아래라 같이 통과한다.
   */
  naverHostSuffixes: ['naver.com', 'naver.net', 'pstatic.net'],
  /** «+» 메뉴 — 서버 어드민 라우트(U06 챗봇 = admin 탭) */
  newTabChoices: [
    { label: '대시보드', kind: 'admin', url: 'https://testumgebung.my-mik.de/admin#/sw/dashboard/index' },
    { label: 'AI 채팅', kind: 'admin', url: 'https://testumgebung.my-mik.de/admin#/cmh/ai/chat/index' },
    { label: '네이버 스마트스토어센터', kind: 'naver', url: 'https://sell.smartstore.naver.com/' },
  ] as const,
  /** 네이버 pane 세션 — 우리 어드민 쿠키와 한 바구니에 두지 않는다 */
  naverPartition: 'persist:naver',
  /** W04 — 기본 로컬 모델(unsloth Gemma 4 E4B QAT · UD-Q4_K_XL 4.2 GB · 사장님 2026-10-02 «sloth 거로»). RAM 이 적은 PC 는 E2B(2.6 GB) */
  localModels: {
    default: 'hf:unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL',
    small: 'hf:unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
  },
  adminPartition: 'persist:admin',
} as const;
