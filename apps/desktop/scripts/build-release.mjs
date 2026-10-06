// 배포판 서버 주소 고정(G01 선행 · 2026-10-06 사장님 «첫 exe 를 올리기 전에 서버 주소부터 고쳐줘»).
// `pnpm run build` 뒤 · electron-builder 앞에 돈다(package.json dist:win). 환경값 CMH_HUB_SERVER_ORIGIN 으로 dist/build-target.js 를 통째로 다시 쓴다.
// 값이 없거나 «https://호스트» 꼴이 아니면 exit 1 — 배포 빌드가 멈춘다(업체 앱이 시험 서버에 붙는 것을 막는다).
// 시험 서버로 배포판을 만들려면 CMH_HUB_ALLOW_TEST_SERVER=1 을 같이 준다(실수 막기).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_HOST = 'testumgebung.my-mik.de';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'build-target.js');

function fail(message) {
  console.error(`build-release: ${message}`);
  process.exit(1);
}

const raw = process.env['CMH_HUB_SERVER_ORIGIN'];
if (!raw) fail('CMH_HUB_SERVER_ORIGIN 이 없습니다 — 예: CMH_HUB_SERVER_ORIGIN=https://shop.example.com pnpm dist:win');
let url;
try {
  url = new URL(raw);
} catch {
  fail(`CMH_HUB_SERVER_ORIGIN 을 URL 로 못 읽습니다: ${raw}`);
}
// 어드민 · 로그인 판정은 hostname 으로 견준다(url-policy.ts · login-pages.ts) — 포트 · 경로 · 질의가 붙으면 판정과 어긋난다
// 원인마다 문장 하나(검수 2026-10-06 — 대문자 · 공백 · 한글 도메인도 같은 문장이면 원인을 못 찾는다)
if (url.protocol !== 'https:') fail(`https:// 로 시작해야 합니다: ${raw}`);
if (url.port !== '') fail(`포트를 빼십시오(https 기본 포트만): ${raw}`);
if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || raw.endsWith('/')) fail(`경로 · 끝 / 를 빼십시오: ${raw}`);
if (url.origin !== raw) fail(`이렇게 적으십시오(소문자 · 공백 없이 · 한글 도메인은 punycode · :443 없이): ${url.origin} — 받은 값: ${JSON.stringify(raw)}`);
if (url.hostname === TEST_HOST && process.env['CMH_HUB_ALLOW_TEST_SERVER'] !== '1') {
  fail(`시험 서버(${TEST_HOST})로 배포판을 만들려면 CMH_HUB_ALLOW_TEST_SERVER=1 을 같이 주십시오`);
}

// tsc 가 만든 파일이 있어야 한다(build 를 먼저 돌렸나)
try {
  readFileSync(target, 'utf8');
} catch {
  fail(`${target} 이 없습니다 — pnpm run build 를 먼저 돌리십시오`);
}
writeFileSync(target, `// scripts/build-release.mjs 가 썼다(${new Date().toISOString()})\nexport const SERVER_ORIGIN = ${JSON.stringify(url.origin)};\n`, 'utf8');
console.log(`build-release: 서버 주소 = ${url.origin}`);
