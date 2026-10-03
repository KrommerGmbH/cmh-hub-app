// 앱 아이콘 만들기 — resources/icon.svg 를 Electron(Chromium)으로 그려 PNG 여럿 + Windows ICO(PNG 담은 꼴)로 낸다.
// 쓰는 법(apps/desktop 에서): `npx electron scripts/render-icon.mjs` — VS Code 터미널이면 ELECTRON_RUN_AS_NODE 를 지우고(`env -u ELECTRON_RUN_AS_NODE npx electron scripts/render-icon.mjs`)
// 결과: resources/icon.png(512) · resources/icon-256.png · resources/icon.ico(16 · 24 · 32 · 48 · 64 · 128 · 256) · src/shell/icon.svg(셸 제목줄)
import { app, BrowserWindow } from 'electron';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** ICO 머리 + 항목(크기 · PNG 바이트) — Vista 부터 ICO 안에 PNG 를 그대로 담을 수 있다 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function render(size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img;
}

app.whenReady().then(async () => {
  // 512 로 한 번만 그리고 줄인다 — 작은 창(16px)을 띄우면 data: URL 로드가 ERR_FAILED 로 끝났다(2026-10-03 실측)
  const big = await render(512);
  writeFileSync(join(root, 'resources', 'icon.png'), big.toPNG());
  const pngs = ICO_SIZES.map((size) => ({ size, data: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  writeFileSync(join(root, 'resources', 'icon-256.png'), pngs[pngs.length - 1].data);
  writeFileSync(join(root, 'resources', 'icon.ico'), buildIco(pngs));
  copyFileSync(join(root, 'resources', 'icon.svg'), join(root, 'src', 'shell', 'icon.svg'));
  console.info(`[icon] png 512 · ico ${ICO_SIZES.join('/')} · shell/icon.svg`);
  app.quit();
}).catch((error) => {
  console.error('[icon] 실패', error);
  app.exit(1);
});
