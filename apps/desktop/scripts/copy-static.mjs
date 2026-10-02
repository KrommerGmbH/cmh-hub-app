// 셸 페이지의 정적 파일(html · css)을 dist 로 복사한다. tsc 는 .ts 만 옮기므로.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pairs = [
  [join(root, 'src/shell'), join(root, 'dist/shell')],
];
for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.ts') });
}
// chrome-tabs 의 CSS(MIT) — 셸이 <link> 로 읽는다
const chromeTabsCss = join(root, 'node_modules/chrome-tabs/css');
if (existsSync(chromeTabsCss)) {
  mkdirSync(join(root, 'dist/shell/vendor/chrome-tabs'), { recursive: true });
  cpSync(chromeTabsCss, join(root, 'dist/shell/vendor/chrome-tabs'), { recursive: true });
}
console.log('copy-static: done');
