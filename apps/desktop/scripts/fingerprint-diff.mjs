#!/usr/bin/env node
// U07 8-13b — 사장님이 «실제로 쓰는» 크롬과 앱의 네이버 view 의 지문을 견준다.
//   ① 127.0.0.1 에 지문 페이지 서버를 띄운다
//   ② chrome.exe 에 주소만 넘긴다 — 크롬이 떠 있으면 그 창(사장님 프로필)에 탭 하나가 열린다 · 자동화 연결(CDP) 없음
//   ③ 앱을 CMH_HUB_FP_URL 로 띄운다 — 네이버 탭과 같은 view 가 같은 페이지를 연다(src/main/fingerprint-probe.ts)
//   ④ 둘이 보낸 JSON · 요청 헤더를 diff 해서 out 폴더에 fingerprint-<src>.json · fingerprint-diff.md 를 쓴다
// 쓰는 법: pnpm run build && node scripts/fingerprint-diff.mjs [--out=<폴더>] [--port=47821] [--timeoutSec=120]
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const port = Number(arg('port', '47821'));
const outDir = arg('out', join(tmpdir(), 'cmh-fingerprint'));
const timeoutSec = Number(arg('timeoutSec', '120'));
const timeoutMs = (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 120) * 1000;
const chromeExe = arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const page = readFileSync(join(here, 'fingerprint', 'fp-page.html'));

const reports = {};
const headers = {};
let electron = null;
let finished = false;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const src = url.searchParams.get('src') ?? 'unknown';
  if (req.method === 'GET' && url.pathname === '/fp.html') {
    headers[src] = req.rawHeaders; // 순서까지 그대로
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        reports[src] = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        console.error(`[fp] ${src} 본문을 못 읽었습니다(잘린 POST)`);
        return;
      }
      res.writeHead(204).end();
      console.info(`[fp] 받음: ${src}`);
      if (reports.chrome && reports.electron) finish(0);
    });
    return;
  }
  res.writeHead(404).end();
});

function flatten(obj, prefix = '', out = {}) {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = JSON.stringify(obj);
  return out;
}

function headerMap(raw = []) {
  const m = {};
  for (let i = 0; i < raw.length; i += 2) m[raw[i].toLowerCase()] = raw[i + 1];
  m['(order)'] = raw.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase()).join(' > ');
  return m;
}

function finish(code) {
  if (finished) return;
  finished = true;
  mkdirSync(outDir, { recursive: true });
  for (const [src, r] of Object.entries(reports)) writeFileSync(join(outDir, `fingerprint-${src}.json`), JSON.stringify({ report: r, headers: headerMap(headers[src]) }, null, 2));
  const a = { ...flatten(reports.chrome ?? {}), ...Object.fromEntries(Object.entries(headerMap(headers.chrome)).map(([k, v]) => [`header.${k}`, JSON.stringify(v)])) };
  const b = { ...flatten(reports.electron ?? {}), ...Object.fromEntries(Object.entries(headerMap(headers.electron)).map(([k, v]) => [`header.${k}`, JSON.stringify(v)])) };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff = keys.filter((k) => a[k] !== b[k]);
  const cell = (v) => (v === undefined ? '(없음)' : String(v).replace(/\|/g, '\\|').slice(0, 220));
  const md = [
    `# 지문 비교 — 사장님 크롬 vs 앱 네이버 view`,
    '',
    `- 같은 칸 ${keys.length - diff.length}개 · **다른 칸 ${diff.length}개** · 받은 쪽: ${Object.keys(reports).join(', ') || '없음'}`,
    '',
    '| 칸 | 크롬 | 앱(네이버 view) |',
    '|---|---|---|',
    ...diff.map((k) => `| \`${k}\` | ${cell(a[k])} | ${cell(b[k])} |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'fingerprint-diff.md'), md);
  console.info(md);
  console.info(`[fp] 파일: ${outDir}`);
  if (electron?.pid && electron.exitCode === null) {
    // 먼저 창 닫기(WM_CLOSE → window-all-closed → app.quit · 쿠키 DB flush) · 5초 뒤에도 살아 있으면 강제로
    spawnSync('taskkill', ['/PID', String(electron.pid), '/T'], { stdio: 'ignore' });
    setTimeout(() => {
      if (electron.exitCode === null) spawnSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' });
      server.close();
      process.exit(code);
    }, 5000);
    return;
  }
  server.close();
  process.exit(code);
}

server.listen(port, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${port}/fp.html`;
  console.info(`[fp] 서버 ${base}`);
  const chrome = spawn(chromeExe, [`${base}?src=chrome`], { detached: true, stdio: 'ignore' });
  chrome.on('error', (e) => { console.error(`[fp] 크롬을 못 띄웠습니다 — ${chromeExe}`, e.message); finish(1); });
  chrome.unref();
  electron = spawn(process.execPath, [join(here, 'run-electron.mjs')], {
    env: { ...process.env, CMH_HUB_FP_URL: `${base}?src=electron` },
    stdio: 'inherit',
  });
  electron.on('error', (e) => { console.error('[fp] 앱을 못 띄웠습니다', e.message); finish(1); });
  electron.on('exit', (c) => { if (!(reports.chrome && reports.electron)) { console.error(`[fp] 앱이 먼저 꺼졌습니다(exit ${c})`); finish(1); } });
  setTimeout(() => {
    console.error(`[fp] 시간 초과 — 받은 쪽: ${Object.keys(reports).join(', ') || '없음'}`);
    finish(1);
  }, timeoutMs);
});
