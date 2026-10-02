// W04 실측 — 작은 GGUF 모델을 내려받아 OpenAI 모양 요청 하나를 돌린다(Node 로 · Electron 없이).
// 쓰는 법: node scripts/llm-smoke.mjs [hf:URI]
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLlmEngine } from '../dist/main/worker/local-llm-engine.js';

const uri = process.argv[2] ?? 'hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M';
const engine = new LocalLlmEngine(join(tmpdir(), 'cmh-hub-app-models'));
const t0 = Date.now();
let lastPct = -1;
const path = await engine.ensureModel(uri, (d, t) => {
  const pct = t ? Math.floor((d / t) * 100) : 0;
  if (pct >= lastPct + 25) { lastPct = pct; console.log(`[llm] download ${pct}%`); }
});
console.log('[llm] model', path, `${Date.now() - t0}ms`);
console.log('[llm] engine', JSON.stringify(await engine.info()));
const t1 = Date.now();
const res = await engine.chatCompletion({
  model: uri,
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'What is the capital of Germany? Answer in one word.' },
  ],
  temperature: 0,
  max_tokens: 16,
});
console.log('[llm] answer', JSON.stringify(res.choices[0].message.content), `${Date.now() - t1}ms`, JSON.stringify(res.usage));
await engine.dispose();
