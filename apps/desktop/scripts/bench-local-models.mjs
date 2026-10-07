// R0 — ONNX 로컬 모델 실측(사장님 PC · CPU). 모델마다 적재 시간 · 첫 토큰 · 토큰/초 · 생각 토큰과 답 토큰(따로 · 합의안 7) · RSS 최대를 잰다.
// 쓰는 법: node scripts/bench-local-models.mjs [설정.json] [--out <경로>]
//   설정이 없으면 DEFAULT_CONFIG(PLAN R0 §5 후보) · 결과 기본 `./bench-<ISO>.json`(PLAN 의 userData/bench 대신 — Electron 없이 돈다).
// 엔진 = `@huggingface/transformers`(아직 앱 의존 아님) — 깔려 있으면 동적 import, 없으면 «필요합니다» 로 끝(종료코드 2).
// 모델 하나 = 자식 프로세스 하나(fork) — 시간초과면 죽여서 다음 모델 측정에 CPU · RAM 이 새지 않게 · RSS 도 그 모델 것만.
// 이 파일 위쪽의 순수 함수(설정 검사 · 건너뜀 판단 · 생각/답 나누기 · 통계 · 결과 꼴)는 src/main/models/bench-core.test.ts 가 시험한다.
// 🔴 transformers.js 를 부르는 부분(measureModel)은 이 클라우드 세션에서 한 번도 못 돌렸다(huggingface.co 차단) — 사장님 PC 첫 실행이 첫 확인.
import { fork } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem, platform, release, arch } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 프롬프트 3종 — 각 120 토큰 안쪽으로 답하게 짧게(PLAN R0 §5) */
export const PROMPTS = {
  ko: '한국의 수도는 어디인가요? 두 문장으로 답해 주세요.',
  en: 'What is the capital of Germany? Answer in two sentences.',
  de: 'Was ist die Hauptstadt von Frankreich? Antworte in zwei Sätzen.',
};

/**
 * 모델 크기(GB · 1 GB = 10⁹ B) — research/02 §1 표의 decoder + embed_tokens 합(dtype 별) · Laya 는 research/01 fp16.
 * 모르는 조합이면 RAM 판단을 못 하고 그냥 잰다(결과 ramCheck = 'unknown-size').
 */
export const KNOWN_SIZES_GB = {
  'onnx-community/Qwen3.5-0.8B-ONNX-OPT': { q4: 0.65, q4f16: 0.58, int8: 1.17 },
  'onnx-community/Qwen3.5-2B-ONNX-OPT': { q4: 1.53, q4f16: 1.38, int8: 2.77 },
  'onnx-community/gemma-4-E2B-it-ONNX': { q4: 3.63, q4f16: 3.11, int8: 6.22 },
  'onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX': { q4: 1.97, q4f16: 1.37, int8: 1.85 },
  'onnx-community/Qwen3-1.7B-ONNX': { q4: 2.15, q4f16: 1.43, int8: 1.74 },
  'onnx-community/laya-multilingual-ONNX': { fp16: 0.65 },
};

/** PLAN R0 §5 후보 + 합의안 7 Laya 바탕 모델(표시만) */
export const DEFAULT_CONFIG = {
  models: [
    'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
    'onnx-community/Qwen3.5-2B-ONNX-OPT',
    'onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX',
    'onnx-community/gemma-4-E2B-it-ONNX',
    { id: 'onnx-community/laya-multilingual-ONNX', kind: 'laya' },
  ],
  dtype: 'q4',
  device: 'cpu',
  prompts: 'ko,en,de',
  maxNewTokens: 120,
  repeat: 2,
  reasoning: 'off',
};

/** 【AI 임시 결정】 RAM 이 모델 크기 × 1.5 보다 작으면 건너뜀(PLAN R0 §9) — 「RAM」 = 측정 직전 os.freemem()(쓸 수 있는 RAM) */
export const RAM_FACTOR = 1.5;
/** 【AI 임시 결정】 모델 하나(적재 + 모든 프롬프트 · 반복) 상한 300초(PLAN R0 §9) */
export const MODEL_TIMEOUT_MS = 300_000;
/** RSS 샘플 간격 */
export const RSS_SAMPLE_MS = 200;

const DTYPES = ['q4', 'q4f16', 'int8', 'fp16', 'fp32'];
const DEVICES = ['cpu', 'dml'];
const LANGS = Object.keys(PROMPTS);

/** 입력 JSON → 검사한 설정(틀리면 Error) */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('설정은 JSON 객체여야 합니다');
  const src = { ...DEFAULT_CONFIG, ...raw };
  if (!Array.isArray(src.models) || src.models.length === 0) throw new Error('models 가 비었습니다');
  const models = src.models.map((m, i) => {
    const entry = typeof m === 'string' ? { id: m } : m;
    if (!entry || typeof entry.id !== 'string' || entry.id === '') throw new Error(`models[${i}] 에 id 가 없습니다`);
    const kind = entry.kind ?? 'onnx';
    if (kind !== 'onnx' && kind !== 'laya') throw new Error(`models[${i}].kind 는 onnx · laya 중 하나입니다`);
    if (entry.sizeGB !== undefined && !(typeof entry.sizeGB === 'number' && entry.sizeGB > 0)) throw new Error(`models[${i}].sizeGB 는 양수입니다`);
    return { id: entry.id, kind, ...(entry.sizeGB !== undefined ? { sizeGB: entry.sizeGB } : {}) };
  });
  if (!DTYPES.includes(src.dtype)) throw new Error(`dtype 은 ${DTYPES.join(' · ')} 중 하나입니다`);
  if (!DEVICES.includes(src.device)) throw new Error(`device 는 ${DEVICES.join(' · ')} 중 하나입니다`);
  const langs = String(src.prompts).split(',').map((s) => s.trim()).filter(Boolean);
  if (langs.length === 0 || langs.some((l) => !LANGS.includes(l))) throw new Error(`prompts 는 ${LANGS.join(',')} 중에서 쉼표로`);
  if (!Number.isInteger(src.maxNewTokens) || src.maxNewTokens < 1 || src.maxNewTokens > 4096) throw new Error('maxNewTokens 는 1~4096 정수');
  if (!Number.isInteger(src.repeat) || src.repeat < 1 || src.repeat > 5) throw new Error('repeat 는 1~5 정수');
  if (src.reasoning !== 'off' && src.reasoning !== 'on') throw new Error('reasoning 은 off · on');
  const timeoutMs = src.timeoutMs ?? MODEL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs 는 양의 정수');
  return {
    models,
    dtype: src.dtype,
    device: src.device,
    prompts: langs,
    maxNewTokens: src.maxNewTokens,
    repeat: src.repeat,
    reasoning: src.reasoning,
    timeoutMs,
    ...(typeof src.cacheDir === 'string' ? { cacheDir: src.cacheDir } : {}),
  };
}

/** 모델 크기(GB) — 설정 값 > 아는 표 > null */
export function modelSizeGB(model, dtype) {
  if (model.sizeGB !== undefined) return model.sizeGB;
  return KNOWN_SIZES_GB[model.id]?.[dtype] ?? null;
}

/** 측정 전 판단: laya → 건너뜀 · RAM 부족 → 건너뜀 · 아니면 잰다 */
export function decideSkip(model, { dtype, freeRamBytes }) {
  if (model.kind === 'laya') {
    return { skip: true, status: 'skipped', reason: 'Laya 측정 방법 다음 차례(입력 꼴이 텍스트 생성과 다름 — research/01)' };
  }
  const sizeGB = modelSizeGB(model, dtype);
  if (sizeGB === null) return { skip: false, ramCheck: 'unknown-size' };
  const needBytes = sizeGB * 1e9 * RAM_FACTOR;
  if (freeRamBytes < needBytes) {
    return {
      skip: true,
      status: 'skipped',
      reason: `RAM 부족(쓸 수 있는 ${(freeRamBytes / 1e9).toFixed(2)} GB < 모델 ${sizeGB} GB × ${RAM_FACTOR})`,
    };
  }
  return { skip: false, ramCheck: 'ok' };
}

/** 생각 끝 표지 — `</think>`(Qwen3 · DeepSeek-R1) 먼저 · 없으면 Gemma 4 `<channel|>`(local-llm-engine.ts stripThinking) */
const THINK_END_MARKERS = ['</think>', '<channel|>'];

/** 마지막 생각 끝 표지의 자리 { at, end } — 없으면 null */
function findThinkingEnd(text) {
  for (const marker of THINK_END_MARKERS) {
    const at = text.lastIndexOf(marker);
    if (at >= 0) return { at, end: at + marker.length };
  }
  return null;
}

/**
 * 생각 글과 답 글을 나눈다 — 마지막 표지 뒤가 답.
 * 표지 없이 `<think>` 로 시작하면 생각이 끝나기 전에 잘린 것 → 전부 생각.
 */
export function splitThinking(text) {
  const m = findThinkingEnd(text);
  if (m) return { reasoning: text.slice(0, m.at).replace(/^\s*<think>/, '').trim(), answer: text.slice(m.end).trim() };
  if (/^\s*<think>/.test(text)) return { reasoning: text.replace(/^\s*<think>/, '').trim(), answer: '' };
  return { reasoning: '', answer: text.trim() };
}

/**
 * 토큰 조각 목록 → 생각 토큰 수 · 답 토큰 수. 마지막 끝 표지를 완성하는 조각까지가 생각(splitThinking 과 같은 표지).
 * 표지가 없으면: `<think>` 로 시작했으면 전부 생각(잘림) · 아니면 전부 답.
 */
export function countThinkingSplit(pieces) {
  const full = pieces.join('');
  const m = findThinkingEnd(full);
  if (m) {
    let len = 0;
    for (let i = 0; i < pieces.length; i += 1) {
      len += pieces[i].length;
      if (len >= m.end) return { reasoningTokens: i + 1, answerTokens: pieces.length - (i + 1) };
    }
  }
  if (/^\s*<think>/.test(full)) return { reasoningTokens: pieces.length, answerTokens: 0 };
  return { reasoningTokens: 0, answerTokens: pieces.length };
}

/** 한 번 생성의 시각들 → 수치(ms · 토큰/초 = 생성 토큰 ÷ 생성 시작부터 끝까지) */
export function summarizeRun({ genStartMs, firstTokenMs, endMs, pieces }) {
  const { reasoningTokens, answerTokens } = countThinkingSplit(pieces);
  const completionTokens = pieces.length;
  const genSec = (endMs - genStartMs) / 1000;
  const text = pieces.join('');
  const { reasoning, answer } = splitThinking(text);
  return {
    firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs - genStartMs),
    tokensPerSec: genSec > 0 && completionTokens > 0 ? round2(completionTokens / genSec) : null,
    completionTokens,
    reasoningTokens,
    answerTokens,
    reasoningChars: reasoning.length,
    answer,
  };
}

/** 수 목록 → { n, mean, median, min, max } (null 은 빼고 · 비면 null) */
export function stats(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { n: xs.length, mean: round2(xs.reduce((a, b) => a + b, 0) / xs.length), median: round2(median), min: xs[0], max: xs[xs.length - 1] };
}

/** 모델 하나의 결과 → 결과 줄(PLAN R0 §7 · 실행마다 한 줄 · 건너뜀 · 실패는 한 줄) */
export function rowsForModel(model, config, outcome) {
  const base = { model: model.id, kind: model.kind, dtype: config.dtype, device: config.device, reasoning: config.reasoning };
  if (outcome.status !== 'ok') {
    return [{ ...base, status: outcome.status, reason: outcome.reason ?? null, lang: null, repeat: null, loadMs: null, rssMaxMB: outcome.rssMaxMB ?? null }];
  }
  return outcome.runs.map((r) => ({
    ...base,
    status: 'ok',
    reason: null,
    lang: r.lang,
    repeat: r.repeat,
    loadMs: outcome.loadMs,
    firstTokenMs: r.firstTokenMs,
    tokensPerSec: r.tokensPerSec,
    completionTokens: r.completionTokens,
    reasoningTokens: r.reasoningTokens,
    answerTokens: r.answerTokens,
    reasoningChars: r.reasoningChars,
    rssMaxMB: outcome.rssMaxMB,
    answer: r.answer,
  }));
}

/** 결과 파일 꼴 — { pc, config, startedAt, finishedAt, results(줄), summary(모델별 통계) } */
export function buildResultDoc({ pc, config, startedAt, finishedAt, rows }) {
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  const summary = [...byModel.entries()].map(([model, rs]) => {
    const ok = rs.filter((r) => r.status === 'ok');
    return {
      model,
      status: ok.length > 0 ? 'ok' : rs[0].status,
      reason: ok.length > 0 ? null : rs[0].reason,
      loadMs: ok[0]?.loadMs ?? null,
      rssMaxMB: rs[0].rssMaxMB ?? null,
      firstTokenMs: stats(ok.map((r) => r.firstTokenMs)),
      tokensPerSec: stats(ok.map((r) => r.tokensPerSec)),
      reasoningTokens: stats(ok.map((r) => r.reasoningTokens)),
      answerTokens: stats(ok.map((r) => r.answerTokens)),
    };
  });
  return { pc, config, startedAt, finishedAt, results: rows, summary };
}

/** 기본 결과 경로 — Windows 파일 이름에 `:` 를 못 쓰므로 `-` 로 */
export function defaultOutPath(now = new Date()) {
  return `./bench-${now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}.json`;
}

/** 명령줄 → { configPath, out } */
export function parseArgs(argv) {
  let configPath = null;
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[i + 1] ?? null;
      if (!out) throw new Error('--out 뒤에 경로가 필요합니다');
      i += 1;
    } else if (a.startsWith('--out=')) {
      out = a.slice('--out='.length);
    } else if (a.startsWith('--')) {
      throw new Error(`모르는 인자: ${a}`);
    } else if (configPath === null) {
      configPath = a;
    } else {
      throw new Error(`설정 파일은 하나만: ${a}`);
    }
  }
  return { configPath, out };
}

/** 약속이 ms 안에 안 끝나면 { status: 'timeout' } — 끝나면 { status: 'ok', value } · 실패는 그대로 던진다 */
export async function runWithTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((res) => {
    timer = setTimeout(() => res({ status: 'timeout' }), ms);
  });
  try {
    const r = await Promise.race([promise.then((value) => ({ status: 'ok', value })), timeout]);
    if (r.status === 'timeout') onTimeout?.();
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** RSS 최대를 잰다(read 는 시험용 주입 · 기본 process.memoryUsage().rss) */
export function createRssSampler(read = () => process.memoryUsage().rss, intervalMs = RSS_SAMPLE_MS) {
  let max = read();
  const timer = setInterval(() => {
    const v = read();
    if (v > max) max = v;
  }, intervalMs);
  timer.unref?.();
  return {
    sample() {
      const v = read();
      if (v > max) max = v;
    },
    stop() {
      clearInterval(timer);
      const v = read();
      if (v > max) max = v;
      return Math.round(max / (1024 * 1024));
    },
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// ───────────────────────────── 아래는 실제 실행(시험 안 함 · 사장님 PC) ─────────────────────────────

const TRANSFORMERS = '@huggingface/transformers';

async function hasTransformers() {
  try {
    import.meta.resolve(TRANSFORMERS);
    return true;
  } catch {
    try {
      await import(TRANSFORMERS);
      return true;
    } catch {
      return false;
    }
  }
}

/** 자식 프로세스 — 모델 하나 적재 · 프롬프트 × 반복 생성 */
async function measureModel(job) {
  const sampler = createRssSampler();
  const tf = await import(TRANSFORMERS);
  if (job.cacheDir) tf.env.cacheDir = job.cacheDir;
  const t0 = performance.now();
  // 확인 못 함: Gemma 4 · Qwen3.5 가 text-generation pipeline 으로 뜨는지(README 예제는 Gemma4ForConditionalGeneration · WebGPU) — 실패하면 error 줄로 남는다
  const generator = await tf.pipeline('text-generation', job.model, { dtype: job.dtype, device: job.device });
  const loadMs = Math.round(performance.now() - t0);
  sampler.sample();
  const runs = [];
  for (const lang of job.prompts) {
    for (let r = 1; r <= job.repeat; r += 1) {
      const messages = [{ role: 'user', content: PROMPTS[lang] }];
      // 생각 끄기 = 채팅 템플릿 변수 enable_thinking(Qwen3 계열) — 다른 모델 템플릿은 무시할 수 있다(DeepSeek-R1 은 늘 생각)
      const prompt = generator.tokenizer.apply_chat_template(messages, {
        tokenize: false,
        add_generation_prompt: true,
        enable_thinking: job.reasoning === 'on',
      });
      const pieces = [];
      let firstTokenMs = null;
      const streamer = new tf.TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: false,
        callback_function: () => {},
        token_callback_function: (ids) => {
          const now = performance.now();
          if (firstTokenMs === null) firstTokenMs = now;
          const list = Array.from(ids, Number);
          // 토큰 하나 = 조각 하나(생각/답 토큰을 세려고 한 토큰씩 글로 푼다)
          for (const id of list) pieces.push(generator.tokenizer.decode([id], { skip_special_tokens: false }));
        },
      });
      const genStartMs = performance.now();
      await generator(prompt, { max_new_tokens: job.maxNewTokens, do_sample: false, streamer, return_full_text: false });
      const endMs = performance.now();
      sampler.sample();
      runs.push({ lang, repeat: r, ...summarizeRun({ genStartMs, firstTokenMs, endMs, pieces }) });
      console.log(`[bench] ${job.model} ${lang}#${r} 첫 토큰 ${runs.at(-1).firstTokenMs}ms · ${runs.at(-1).tokensPerSec} tok/s`);
    }
  }
  await generator.dispose?.();
  return { status: 'ok', loadMs, runs, rssMaxMB: sampler.stop() };
}

function runChild(job, timeoutMs) {
  const child = fork(fileURLToPath(import.meta.url), ['--child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const done = new Promise((resolve) => {
    let settled = false;
    child.once('message', (msg) => {
      settled = true;
      resolve(msg);
    });
    child.once('exit', (code) => {
      if (!settled) resolve({ status: 'error', reason: `자식 프로세스가 답 없이 끝났습니다(종료코드 ${code})` });
    });
    child.send(job);
  });
  return runWithTimeout(done, timeoutMs, () => child.kill('SIGKILL')).then((r) =>
    r.status === 'timeout' ? { status: 'timeout', reason: `시간 초과(${Math.round(timeoutMs / 1000)}초)` } : r.value,
  );
}

async function childMain() {
  // 부모(bench)가 죽거나 끊으면 측정을 계속하지 않는다 — 고아로 CPU · RAM 을 잡고 있지 않게
  process.on('disconnect', () => process.exit(1));
  process.once('message', async (job) => {
    let out;
    try {
      out = await measureModel(job);
    } catch (e) {
      out = { status: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
    process.send(out, () => process.exit(0));
  });
}

async function main() {
  let args;
  let config;
  try {
    args = parseArgs(process.argv.slice(2));
    const raw = args.configPath ? JSON.parse(await readFile(args.configPath, 'utf8')) : {};
    config = normalizeConfig(raw);
  } catch (e) {
    console.error(`[bench] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!(await hasTransformers())) {
    console.error(`[bench] \`${TRANSFORMERS}\` 가 필요합니다 — 앱 의존에 아직 없습니다(R4 다음 차례). 이 폴더에서 따로 깔고 다시 돌려 주세요.`);
    process.exit(2);
  }
  const out = resolvePath(args.out ?? defaultOutPath());
  const startedAt = new Date().toISOString();
  const pc = { cpu: cpus()[0]?.model ?? null, cpuCount: cpus().length, ramGB: round2(totalmem() / 1e9), os: `${platform()} ${release()} ${arch()}`, node: process.version };
  console.log(`[bench] ${pc.cpu} · RAM ${pc.ramGB} GB · 모델 ${config.models.length}개 → ${out}`);
  const rows = [];
  for (const model of config.models) {
    const decision = decideSkip(model, { dtype: config.dtype, freeRamBytes: freemem() });
    let outcome;
    if (decision.skip) {
      outcome = { status: decision.status, reason: decision.reason };
    } else {
      console.log(`[bench] ${model.id} 적재 · 측정…`);
      outcome = await runChild(
        { model: model.id, dtype: config.dtype, device: config.device, prompts: config.prompts, repeat: config.repeat, maxNewTokens: config.maxNewTokens, reasoning: config.reasoning, cacheDir: config.cacheDir },
        config.timeoutMs,
      );
    }
    console.log(`[bench] ${model.id} → ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    rows.push(...rowsForModel(model, config, outcome));
    // 모델마다 써 둔다 — 중간에 멈춰도 앞 결과가 남게
    await writeFile(out, JSON.stringify(buildResultDoc({ pc, config, startedAt, finishedAt: null, rows }), null, 2));
  }
  const doc = buildResultDoc({ pc, config, startedAt, finishedAt: new Date().toISOString(), rows });
  await writeFile(out, JSON.stringify(doc, null, 2));
  console.table(doc.summary.map((s) => ({ model: s.model, status: s.status, loadMs: s.loadMs, firstTokenMs: s.firstTokenMs?.median ?? null, tokPerSec: s.tokensPerSec?.median ?? null, rssMaxMB: s.rssMaxMB })));
  console.log(`[bench] 끝 → ${out}`);
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (isEntry) {
  if (process.argv.includes('--child')) await childMain();
  else await main();
}
