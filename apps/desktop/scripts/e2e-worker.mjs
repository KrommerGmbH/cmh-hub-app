// 끝-끝 시험용 일꾼 — 앱의 task-worker 와 같은 요청 모양으로 서버 큐에서 llm-inference 1건을 받아 로컬 모델로 답한다.
// 인증은 통합(integration) 토큰(.mcp.json cmh-shop-api-mcp env) — 앱은 로그인 쿠키를 쓰지만 큐 API 모양은 같다.
// 쓰는 법: node scripts/e2e-worker.mjs [초 상한=300]
import { readFileSync } from 'node:fs';
import { LocalLlmEngine } from '../dist/main/worker/local-llm-engine.js';

const raw = JSON.parse(readFileSync('E:/Kang/project/.mcp.json', 'utf8')).mcpServers['cmh-shop-api-mcp'].env;
// .mcp.json 값은 ${VAR} 자리표다 — 실제 값은 셸 환경변수
const env = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /^\$\{(.+)\}$/.test(v) ? process.env[v.slice(2, -1)] ?? '' : v]));
const base = env.SHOPWARE_API_URL.replace(/\/$/, '').replace(/\/api$/, '');
const model = process.argv[3] ?? 'hf:unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL';
const runner = 'hub-app-e2e-kang-pc';
const limitMs = Number(process.argv[2] ?? 300) * 1000;

const tokenRes = await fetch(`${base}/api/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.SHOPWARE_API_CLIENT_ID, client_secret: env.SHOPWARE_API_CLIENT_SECRET }),
});
const token = (await tokenRes.json()).access_token;
const call = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

const engine = new LocalLlmEngine(`${process.env.LOCALAPPDATA}/cmh-hub-app/models`);
console.log('[e2e] 모델 미리 적재');
await engine.chatCompletion({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
console.log('[e2e] 큐 기다림…');
const t0 = Date.now();
let polls;
while (Date.now() - t0 < limitMs) {
  const r = await call('/api/_action/cmh-ai/task/next', { runner, market: 'local-llm', actionKey: 'llm-inference', models: [model] });
  const task = r.data?.task;
  if (!task) {
    polls = (polls ?? 0) + 1;
    if (polls % 10 === 1) console.log('[e2e] poll', polls, r.status, JSON.stringify(r.data).slice(0, 200));
    await new Promise((s) => setTimeout(s, 1000));
    continue;
  }
  console.log('[e2e] 받음', task.task_id, 'msgs', task.payload?.messages?.length);
  const s = Date.now();
  try {
    const result = await engine.chatCompletion({ model: task.payload.model, messages: task.payload.messages, ...(task.payload.max_tokens ? { max_tokens: task.payload.max_tokens } : {}) });
    const up = await call(`/api/_action/cmh-ai/task/${task.task_id}/result`, { runner, ok: true, result, durationMs: Date.now() - s });
    console.log('[e2e] 올림', up.status, `${Date.now() - s}ms`, JSON.stringify(result.choices[0].message.content).slice(0, 200));
  } catch (e) {
    await call(`/api/_action/cmh-ai/task/${task.task_id}/result`, { runner, ok: false, error: String(e) });
    console.log('[e2e] 실패', String(e));
  }
  break;
}
await engine.dispose();
