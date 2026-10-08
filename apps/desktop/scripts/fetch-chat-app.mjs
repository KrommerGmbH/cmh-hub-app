// R6-a — CmhAiAgent chat-app(Vue 3.5 · Vite 8)의 빌드 산출을 apps/desktop/dist/chat-app/ 로 복사한다(빌드 때 · `pnpm --filter desktop build` 끝에).
// 이 저장소에는 복사본을 두지 않는다(dist/ 는 .gitignore · PLAN R6 합의안 4 «chat-app 은 CmhAiAgent 에서 빌드 → dist 복사»).
// 원본 폴더: 환경 변수 CMH_CHAT_APP_DIST(상대경로면 cmh-hub-app 저장소 뿌리 기준) · 없으면 ../CmhAiAgent/apps/chat-app/dist.
// 원본이 없어도 빌드는 실패시키지 않는다(경고만) — 그때 챗 탭은 안내 화면을 보인다(main/chat/chat-pane-host.ts fallback).
//
// chat-app 빌드(2026-10-08 실측 · CmhAiAgent 를 고치지 않고 · Linux · pnpm 10.28.0 · npm 저장소):
//   cd ../CmhAiAgent && pnpm install --frozen-lockfile
//   cd apps/chat-app && pnpm exec vite build --base ./ --outDir dist --emptyOutDir     ← 상대 주소 산출(이 스크립트의 기본 원본)
// chat-app 의 `pnpm run build`(vue-tsc -b && vite build)는 vite.config.ts 대로 ../../src/Resources/public/chat-app 에
//   base `/bundles/cmhaiagent/chat-app/` 로 낸다 — 그 폴더를 CMH_CHAT_APP_DIST 로 줘도 열린다(chat-policy.ts CHAT_APP_SHOP_BASE 를 떼고 읽는다).
// 심볼릭 링크는 복사하지 않는다(어차피 app:// 응답이 거부한다 · plugin-ui-policy.ts openAsset).
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');
const repoRoot = join(desktopRoot, '..', '..');
const dest = join(desktopRoot, 'dist', 'chat-app');
const raw = process.env['CMH_CHAT_APP_DIST'];
const source = raw && raw.trim() !== '' ? (isAbsolute(raw) ? raw : resolve(repoRoot, raw)) : resolve(repoRoot, '..', 'CmhAiAgent', 'apps', 'chat-app', 'dist');

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

try {
  // 옛 복사본을 먼저 지운다 — 원본이 사라졌는데 낡은 화면이 남지 않게
  rmSync(dest, { recursive: true, force: true });
  if (!existsSync(join(source, 'index.html'))) {
    console.warn(`fetch-chat-app: chat-app 빌드 산출이 없습니다 — ${source}/index.html`);
    console.warn('fetch-chat-app: 챗 탭은 안내 화면을 보입니다. 빌드 차례는 이 파일 머리 주석 · 다른 폴더면 CMH_CHAT_APP_DIST');
    process.exit(0);
  }
  const skipped = [];
  cpSync(source, dest, {
    recursive: true,
    filter: (path) => {
      if (lstatSync(path).isSymbolicLink()) {
        skipped.push(path);
        return false;
      }
      return true;
    },
  });
  const index = readFileSync(join(dest, 'index.html'), 'utf8');
  const shopBase = index.includes('/bundles/cmhaiagent/chat-app/');
  console.log(`fetch-chat-app: ${countFiles(dest)} files ← ${source}${shopBase ? ' (base /bundles/cmhaiagent/chat-app/ — app:// 가 앞부분을 떼고 읽는다)' : ''}`);
  if (skipped.length > 0) console.warn(`fetch-chat-app: 심볼릭 링크 ${skipped.length}개는 복사하지 않았습니다`, skipped.slice(0, 5));
} catch (error) {
  // 반쯤 복사된 것은 지운다(index.html 만 있고 자원이 빠진 화면보다 안내 화면이 낫다)
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    // 지우기도 실패하면 그대로 — 경고는 아래 줄
  }
  console.warn('fetch-chat-app: 복사 실패 — 챗 탭은 안내 화면을 보입니다', error instanceof Error ? error.message : String(error));
  process.exit(0);
}
