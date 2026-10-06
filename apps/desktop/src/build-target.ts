// 빌드마다 정하는 값 — 앱이 붙는 서버(어드민) 주소 하나(G01 선행 · 2026-10-06 사장님 «첫 exe 를 올리기 전에 서버 주소부터 고쳐줘»).
// 이 파일의 값은 개발판 기본값(시험 서버)이다. 배포판(pnpm dist:win)은 scripts/build-release.mjs 가 환경값 CMH_HUB_SERVER_ORIGIN 으로
// dist/build-target.js 를 통째로 다시 쓴다 — 값이 없으면 배포 빌드가 멈춘다. 값은 asar 안에 고정된다(사용자가 못 바꿈 · A02 phishing 차단).
export const SERVER_ORIGIN = 'https://testumgebung.my-mik.de';
