// R0 bench 의 순수 함수 시험 — 함수는 scripts/bench-local-models.mjs 안에 있다(스크립트가 dist 없이 돌게 · 시험은 상대경로 import).
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — .mjs 스크립트(타입 선언 없음 · tsconfig 는 시험 파일을 typecheck 하지 않는다)
import * as bench from '../../../scripts/bench-local-models.mjs';

describe('bench — 설정 검사', () => {
  it('기본값을 채우고 문자열 모델을 객체로', () => {
    const c = bench.normalizeConfig({ models: ['a/b', { id: 'c/d', kind: 'laya', sizeGB: 1 }], prompts: 'ko, de', repeat: 1 });
    expect(c).toEqual({
      models: [
        { id: 'a/b', kind: 'onnx' },
        { id: 'c/d', kind: 'laya', sizeGB: 1 },
      ],
      dtype: 'q4',
      device: 'cpu',
      prompts: ['ko', 'de'],
      maxNewTokens: 120,
      repeat: 1,
      reasoning: 'off',
      timeoutMs: 300_000,
    });
  });
  it('틀린 값은 예외', () => {
    expect(() => bench.normalizeConfig({ models: [] })).toThrow(/models/);
    expect(() => bench.normalizeConfig({ dtype: 'q3' })).toThrow(/dtype/);
    expect(() => bench.normalizeConfig({ device: 'cuda' })).toThrow(/device/);
    expect(() => bench.normalizeConfig({ prompts: 'ko,fr' })).toThrow(/prompts/);
    expect(() => bench.normalizeConfig({ repeat: 6 })).toThrow(/repeat/);
    expect(() => bench.normalizeConfig({ reasoning: 'yes' })).toThrow(/reasoning/);
    expect(() => bench.normalizeConfig({ models: [{ id: 'x', kind: 'gguf' }] })).toThrow(/kind/);
  });
  it('명령줄 — 설정 경로 · --out', () => {
    expect(bench.parseArgs([])).toEqual({ configPath: null, out: null });
    expect(bench.parseArgs(['c.json', '--out', 'r.json'])).toEqual({ configPath: 'c.json', out: 'r.json' });
    expect(bench.parseArgs(['--out=r.json'])).toEqual({ configPath: null, out: 'r.json' });
    expect(() => bench.parseArgs(['--out'])).toThrow(/경로/);
    expect(() => bench.parseArgs(['--x'])).toThrow(/모르는 인자/);
  });
  it('기본 결과 경로는 : 없는 ISO', () => {
    expect(bench.defaultOutPath(new Date('2026-10-07T12:34:56.789Z'))).toBe('./bench-2026-10-07T12-34-56Z.json');
  });
});

describe('bench — 건너뜀 판단', () => {
  const GB = 1e9;
  it('laya 는 측정 방법 다음 차례로 건너뜀', () => {
    expect(bench.decideSkip({ id: 'x', kind: 'laya' }, { dtype: 'q4', freeRamBytes: 100 * GB })).toMatchObject({ skip: true, status: 'skipped', reason: expect.stringMatching(/Laya/) });
  });
  it('RAM < 크기 × 1.5 면 RAM 부족 · 경계는 잰다', () => {
    const m = { id: 'onnx-community/Qwen3.5-2B-ONNX-OPT', kind: 'onnx' }; // q4 1.53 GB → 2.295 GB 필요
    expect(bench.decideSkip(m, { dtype: 'q4', freeRamBytes: 2.29 * GB })).toMatchObject({ skip: true, reason: expect.stringMatching(/RAM 부족/) });
    expect(bench.decideSkip(m, { dtype: 'q4', freeRamBytes: 2.295 * GB })).toEqual({ skip: false, ramCheck: 'ok' });
    // dtype 별 크기 · 설정 sizeGB 가 우선
    expect(bench.modelSizeGB(m, 'int8')).toBe(2.77);
    expect(bench.modelSizeGB({ ...m, sizeGB: 9 }, 'q4')).toBe(9);
  });
  it('크기를 모르면 잰다(unknown-size)', () => {
    expect(bench.decideSkip({ id: 'who/knows', kind: 'onnx' }, { dtype: 'q4', freeRamBytes: 1 })).toEqual({ skip: false, ramCheck: 'unknown-size' });
  });
});

describe('bench — 시간초과', () => {
  it('ms 안에 안 끝나면 timeout + onTimeout · 끝나면 ok', async () => {
    const onTimeout = vi.fn();
    expect(await bench.runWithTimeout(new Promise(() => {}), 20, onTimeout)).toEqual({ status: 'timeout' });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(await bench.runWithTimeout(Promise.resolve(7), 1000)).toEqual({ status: 'ok', value: 7 });
    await expect(bench.runWithTimeout(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
  });
  it('기본 상한은 300초', () => {
    expect(bench.MODEL_TIMEOUT_MS).toBe(300_000);
  });
});

describe('bench — 생각 토큰 / 답 토큰', () => {
  it('</think> 앞은 생각 · 뒤는 답(글 · 토큰 둘 다)', () => {
    const pieces = ['<think>', '음', '..', '</', 'think>', '\n', '베를', '린'];
    expect(bench.countThinkingSplit(pieces)).toEqual({ reasoningTokens: 5, answerTokens: 3 });
    expect(bench.splitThinking(pieces.join(''))).toEqual({ reasoning: '음..', answer: '베를린' });
  });
  it('Gemma 4 <channel|> 표지', () => {
    expect(bench.countThinkingSplit(['Thinking', '<channel|>', '답'])).toEqual({ reasoningTokens: 2, answerTokens: 1 });
    expect(bench.splitThinking('Thinking Process<channel|>답')).toEqual({ reasoning: 'Thinking Process', answer: '답' });
  });
  it('표지가 없으면 전부 답 · <think> 로 시작해 안 닫히면 전부 생각(잘림)', () => {
    expect(bench.countThinkingSplit(['베를', '린'])).toEqual({ reasoningTokens: 0, answerTokens: 2 });
    expect(bench.countThinkingSplit(['<think>', '아직'])).toEqual({ reasoningTokens: 2, answerTokens: 0 });
    expect(bench.splitThinking('<think>아직')).toEqual({ reasoning: '아직', answer: '' });
  });
  it('한 번 실행 요약 — 첫 토큰 · 토큰/초 · 생각/답 따로', () => {
    const r = bench.summarizeRun({ genStartMs: 1000, firstTokenMs: 1250, endMs: 3000, pieces: ['<think>', 'x', '</think>', 'A', 'B', 'C'] });
    expect(r).toEqual({ firstTokenMs: 250, tokensPerSec: 3, completionTokens: 6, reasoningTokens: 3, answerTokens: 3, reasoningChars: 1, answer: 'ABC' });
    expect(bench.summarizeRun({ genStartMs: 0, firstTokenMs: null, endMs: 10, pieces: [] })).toMatchObject({ firstTokenMs: null, tokensPerSec: null });
  });
});

describe('bench — 통계 · 결과 꼴', () => {
  it('stats — null 빼고 · 짝수 중앙값 · 비면 null', () => {
    expect(bench.stats([3, null, 1, 2, 10])).toEqual({ n: 4, mean: 4, median: 2.5, min: 1, max: 10 });
    expect(bench.stats([null])).toBeNull();
  });
  it('실행마다 한 줄 · 건너뜀/시간초과는 한 줄 · 모델별 요약', () => {
    const config = bench.normalizeConfig({ models: ['a/ok', 'a/slow'], prompts: 'ko,en', repeat: 1 });
    const [okModel, slowModel] = config.models;
    const run = (lang: string, tps: number) => ({ lang, repeat: 1, firstTokenMs: 100, tokensPerSec: tps, completionTokens: 4, reasoningTokens: 1, answerTokens: 3, reasoningChars: 2, answer: '답' });
    const rows = [
      ...bench.rowsForModel(okModel, config, { status: 'ok', loadMs: 900, rssMaxMB: 700, runs: [run('ko', 10), run('en', 20)] }),
      ...bench.rowsForModel(slowModel, config, { status: 'timeout', reason: '시간 초과(300초)' }),
    ];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ model: 'a/ok', status: 'ok', lang: 'ko', loadMs: 900, rssMaxMB: 700, reasoningTokens: 1, answerTokens: 3, dtype: 'q4', reasoning: 'off' });
    expect(rows[2]).toMatchObject({ model: 'a/slow', status: 'timeout', reason: '시간 초과(300초)', lang: null });
    const doc = bench.buildResultDoc({ pc: { cpu: 'x' }, config, startedAt: 's', finishedAt: 'f', rows });
    expect(doc.results).toBe(rows);
    expect(doc.summary).toEqual([
      {
        model: 'a/ok',
        status: 'ok',
        reason: null,
        loadMs: 900,
        rssMaxMB: 700,
        firstTokenMs: { n: 2, mean: 100, median: 100, min: 100, max: 100 },
        tokensPerSec: { n: 2, mean: 15, median: 15, min: 10, max: 20 },
        reasoningTokens: { n: 2, mean: 1, median: 1, min: 1, max: 1 },
        answerTokens: { n: 2, mean: 3, median: 3, min: 3, max: 3 },
      },
      { model: 'a/slow', status: 'timeout', reason: '시간 초과(300초)', loadMs: null, rssMaxMB: null, firstTokenMs: null, tokensPerSec: null, reasoningTokens: null, answerTokens: null },
    ]);
  });
  it('RSS 최대 — 샘플 중 가장 큰 값(MB)', () => {
    const values = [100, 300, 200].map((m) => m * 1024 * 1024);
    let i = 0;
    const s = bench.createRssSampler(() => values[Math.min(i++, values.length - 1)] ?? 0, 60_000);
    s.sample();
    s.sample();
    expect(s.stop()).toBe(300);
  });
});

describe('bench — 자식 프로세스', () => {
  it('bench: 부모가 끊기면 자식이 끝난다', async () => {
    const { fork } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const script = fileURLToPath(new URL('../../../scripts/bench-local-models.mjs', import.meta.url));
    const child = fork(script, ['--child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    // 자식이 'disconnect' 처리기를 걸 시간(모듈 적재)을 준 뒤 끊는다 — 처리기가 없으면 자식은 0 으로 끝난다(그래서 1 을 본다)
    await new Promise((r) => setTimeout(r, 1_000));
    child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      expect(await exited).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });
});
