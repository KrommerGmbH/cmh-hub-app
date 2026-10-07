import { BRIDGE_DEFAULT_PORT } from '@cmh-hub-app/driver-core';
import { SERVER_ORIGIN } from './build-target.js';

/** 서버 호스트 이름(포트 없음) — url-policy.ts · login-pages.ts 가 URL.hostname 과 견준다. 서버 주소 하나(build-target.ts)에서 나온다 */
const SERVER_HOST = new URL(SERVER_ORIGIN).hostname;

// 빌드에 고정되는 값(A02 — 어드민 · 네이버 탭은 사용자가 URL 을 넣지 않는다 · phishing 차단. 예외는 빈 탭(web · 2026-10-05) 하나 — 따로 된 세션 · 저장된 계정 안 씀)
export const APP_CONFIG = {
  /** 서버 어드민 호스트 — https:// 만 */
  serverOrigin: SERVER_ORIGIN,
  adminPath: '/admin',
  /** admin 탭이 갈 수 있는 호스트 */
  adminHosts: [SERVER_HOST],
  /**
   * naver 탭이 갈 수 있는 호스트 — 접미사로 본다. 판매자센터 정확한 호스트는 코딩 전 실측(cmh_ai_screen 의 URL · PLAN A02).
   * 로그인(nid.naver.com)도 naver.com 아래라 같이 통과한다.
   */
  naverHostSuffixes: [
    'naver.com',
    'naver.net',
    'pstatic.net',
    // «네이버.com» 한글 도메인 — 메인이 node -e "new URL('https://네이버.com/').hostname" 로 잼 · 2026-10-07
    'xn--950bt9s8xi.com',
  ],
  /** «+» 메뉴 — 서버 어드민 라우트(U06 챗봇 = admin 탭) */
  newTabChoices: [
    // 빈 탭(2026-10-05) — 주소창으로 아무 http(s) · 검색. 저장 공간은 webPartition(어드민 · 네이버와 따로)
    { label: '빈 탭', kind: 'web', url: 'about:blank' },
    { label: '대시보드', kind: 'admin', url: `${SERVER_ORIGIN}/admin#/sw/dashboard/index` },
    // 메뉴 없는 챗봇 길(CmhAiAgent cmh.ai.chat.solo · coreRoute) — 어드민 안 챗봇(#/cmh/ai/chat/index)과 화면 부품 하나를 같이 쓴다
    { label: 'AI 채팅', kind: 'admin', url: `${SERVER_ORIGIN}/admin#/cmh/ai/chat-solo` },
    { label: '네이버 스마트스토어센터 (크롬에서 열림)', kind: 'naver', url: 'https://sell.smartstore.naver.com/' },
  ] as const,
  /** U11 · 2026-10-07 셋 합의 — 앱 안 네이버 탭은 크롬과 다른 세션이라 끈다 · 네이버는 크롬(확장) · true 로 켜면 옛 길 그대로 */
  naverTabEnabled: false,
  /** 네이버 pane 세션 — 우리 어드민 쿠키와 한 바구니에 두지 않는다 */
  naverPartition: 'persist:naver',
  /** U11 · id = manifest key 로 고정한 압축 해제판 · 웹스토어 Unlisted 판 id 는 올린 뒤 더한다(셋 합의 2026-10-07) */
  extensionBridge: {
    enabled: true,
    host: '127.0.0.1',
    port: BRIDGE_DEFAULT_PORT,
    allowedExtensionIds: ['njdfehbchcmplpbjddcjopbceieajona'] as const,
  },
  /** W04 — 기본 로컬 모델(unsloth Gemma 4 E4B QAT · UD-Q4_K_XL 4.2 GB · 사장님 2026-10-02 «sloth 거로»). RAM 이 적은 PC 는 E2B(2.6 GB) */
  localModels: {
    default: 'hf:unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL',
    small: 'hf:unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
  },
  adminPartition: 'persist:admin',
  /** 빈 탭(web) 세션 — 어드민 · 네이버 로그인 쿠키 · 저장된 계정과 한 바구니에 두지 않는다 */
  webPartition: 'persist:web',
  /** 빈 탭 주소창 검색(크롬 기본과 같은 Google) — 검색어는 encodeURIComponent 로 뒤에 붙인다 */
  webSearchUrl: 'https://www.google.com/search?q=',
  /**
   * U08 저장된 계정 자동입력(2026-10-05 사장님 «크롬처럼 아이디 · 비밀번호 넣게») — 로그인 페이지 표. 빌드 고정(A02 · 앱은 DB 를 안 읽는다).
   * admin 선택자 = 2026-10-04 Playwright 로그인 실측 · naver = DB `cmh_ai_platform.login_flow`(accounts.commerce.naver.com · loginUrl 경로 /login).
   * 호스트 + 경로 + (admin) 해시로 로그인 화면만 가른다 — 같은 호스트의 회원가입 · 비밀번호 변경 화면에서는 안 뜬다(제미나이 검수 2026-10-05).
   * nid.naver.com(네이버 아이디 로그인)은 경로 · 칸을 재지 않아 넣지 않았다 — 재면 한 줄 더한다.
   */
  loginPages: [
    {
      kind: 'admin',
      hosts: [SERVER_HOST],
      pathPrefix: '/admin',
      hashPrefix: '#/login',
      /** 로그인 뒤 도착 화면 — 여기에 와야 «로그인 성공»으로 보고 자동 저장한다(어드민 해시 화면 · #/login 은 아님) */
      successUrlPrefixes: [`${SERVER_ORIGIN}/admin#/`],
      usernameSelectors: ['#sw-field--username'],
      passwordSelectors: ['#sw-field--password'],
    },
    {
      kind: 'naver',
      hosts: ['accounts.commerce.naver.com'],
      pathPrefix: '/login',
      hashPrefix: null,
      /** 2단계 인증 · 기기 등록을 거쳐 판매자센터 첫 화면에 들어가야 «로그인 성공» — DB login_flow.returnUrlDefault = #/home/dashboard(판매자 가입 등 다른 화면은 아님) */
      successUrlPrefixes: ['https://sell.smartstore.naver.com/#/home'],
      usernameSelectors: ['input[placeholder="아이디 또는 이메일 주소"]', '#id'],
      passwordSelectors: ['input[type="password"]', '#pw'],
    },
  ],
} as const;
