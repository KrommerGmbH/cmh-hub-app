// 끝-끝 시험 한 번: (웹 OPcache 리셋) → 서버에서 askModelById 를 띄움(ssh · 배경) → 이 PC 가 task/next 로 집음 → 로컬 모델 → result → 서버 출력
// 쓰는 법: node scripts/e2e-run.mjs <모델 URI> <서버 모델 행 id>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LocalLlmEngine } from '../dist/main/worker/local-llm-engine.js';

const [model, modelRowId] = process.argv.slice(2);
const raw = JSON.parse(readFileSync('E:/Kang/project/.mcp.json', 'utf8')).mcpServers['cmh-shop-api-mcp'].env;
const env = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /^\$\{(.+)\}$/.test(v) ? process.env[v.slice(2, -1)] ?? '' : v]));
const base = 'https://testumgebung.my-mik.de';
const runner = 'hub-app-e2e-kang-pc';

const token = (await (await fetch(`${base}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.SHOPWARE_API_CLIENT_ID, client_secret: env.SHOPWARE_API_CLIENT_SECRET }) })).json()).access_token;
const call = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

console.log('[run] opcache', (await (await fetch(`${base}/opcache-reset.php`)).text()).trim());
const engine = new LocalLlmEngine(`${process.env.LOCALAPPDATA}/cmh-hub-app/models`);
await engine.chatCompletion({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
console.log('[run] model warm');

const remote = 'cd /var/www/vhosts/my-mik.de/testumgebung.my-mik.de && printf %s \'{"product":"Bio Matcha Pulver 100g","brand":"Teekanne"}\' > /tmp/e2e-diag.json && S=$(date +%s); timeout 170 /opt/plesk/php/8.3/bin/php -d memory_limit=1G bin/console cmh:ai:naver-optimize:try /tmp/e2e-diag.json tag --model ' + modelRowId + ' </dev/null 2>&1 | tail -20; echo "server took $(( $(date +%s)-S ))s"; rm -f /tmp/e2e-diag.json';
const server = spawn('ssh', ['-o', 'BatchMode=yes', 'mymik-main', remote], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const serverDone = new Promise((res) => server.on('close', res));

const t0 = Date.now();
let claimed = null;
while (Date.now() - t0 < 60_000 && !claimed) {
  const r = await call('/api/_action/cmh-ai/task/next', { runner, market: 'local-llm', actionKey: 'llm-inference', models: [model] });
  if (r.data?.task) claimed = r.data.task;
  else await new Promise((s) => setTimeout(s, 1000));
}
if (!claimed) {
  console.log('[run] 60초 안에 못 집음');
} else {
  console.log('[run] 집음', claimed.task_id, `${Math.round((Date.now() - t0) / 1000)}s`);
  const s = Date.now();
  const result = await engine.chatCompletion({ model: claimed.payload.model, messages: claimed.payload.messages });
  const up = await call(`/api/_action/cmh-ai/task/${claimed.task_id}/result`, { runner, ok: true, result, durationMs: Date.now() - s });
  console.log('[run] 답', `${Date.now() - s}ms`, 'result', up.status, JSON.stringify(result.choices[0].message.content).slice(0, 300));
}
await serverDone;
console.log('[run] server:\n' + serverOut.trim());
await engine.dispose();
