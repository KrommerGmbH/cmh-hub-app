import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { collectChat, type ChatChunk } from '../model-provider.js';
import { OpenAiCompatProvider, redactSecret } from './openai-compat-provider.js';

const KEY = 'sk-test-SECRET-0123456789abcdefXYZ';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server | null = null;
let seen: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];

async function startServer(handler: Handler): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

function sse(res: ServerResponse, events: unknown[], opts: { done?: boolean } = {}): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (opts.done !== false) res.write('data: [DONE]\n\n');
  res.end();
}

const req = { model: 'm1', messages: [{ role: 'user' as const, content: '안녕' }] };

async function all(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('OpenAiCompatProvider — SSE', () => {
  it('delta 조립 · reasoning 분리 · usage · 요청 꼴(키 · stream · 경로)', async () => {
    const base = await startServer((_r, _b, res) =>
      sse(res, [
        { choices: [{ delta: { role: 'assistant', reasoning_content: '생각1 ' } }] },
        { choices: [{ delta: { reasoning: '생각2' } }] },
        { choices: [{ delta: { content: '베를' } }] },
        { choices: [{ delta: { content: '린' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } },
      ]),
    );
    const p = new OpenAiCompatProvider({ id: 'p', baseUrl: `${base}/`, apiKey: KEY });
    const r = await collectChat(p.chat({ ...req, max_tokens: 20, temperature: 0 }));
    expect(r).toEqual({
      text: '베를린',
      reasoning: '생각1 생각2',
      toolCalls: [],
      usage: { promptTokens: 7, completionTokens: 5, reasoningTokens: 3 },
      finishReason: 'stop',
      error: null,
    });
    expect(seen[0]?.url).toBe('/v1/chat/completions');
    expect(seen[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body).toMatchObject({ model: 'm1', stream: true, stream_options: { include_usage: true }, max_tokens: 20, temperature: 0 });
  });

  it('tool_calls 를 index 별로 이어 붙여 끝에 낸다', async () => {
    const base = await startServer((_r, _b, res) =>
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'open', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"말차"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"id":1}' } }] }, finish_reason: 'tool_calls' }] },
      ]),
    );
    const p = new OpenAiCompatProvider({ id: 'p', baseUrl: base });
    const tools = [{ type: 'function' as const, function: { name: 'search', parameters: { type: 'object' } } }];
    const chunks = await all(p.chat({ ...req, tools }));
    expect(chunks).toEqual([
      { type: 'tool_call', id: 'call_a', name: 'search', argumentsJson: '{"q":"말차"}' },
      { type: 'tool_call', id: 'call_b', name: 'open', argumentsJson: '{"id":1}' },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
    expect(seen[0]?.auth).toBeUndefined();
    expect(seen[0]?.body['tools']).toEqual(tools);
  });

  it('조각이 줄 중간에서 잘려 와도(CRLF 포함) 조립된다', async () => {
    const base = await startServer((_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const all = `data: ${JSON.stringify({ choices: [{ delta: { content: '가나' } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: '다' }, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
      const parts = [all.slice(0, 13), all.slice(13, 40), all.slice(40)];
      let i = 0;
      const tick = (): void => {
        const part = parts[i++];
        if (part === undefined) return void res.end();
        res.write(part);
        setTimeout(tick, 5);
      };
      tick();
    });
    const r = await collectChat(new OpenAiCompatProvider({ id: 'p', baseUrl: base }).chat(req));
    expect(r.text).toBe('가나다');
    expect(r.finishReason).toBe('stop');
    expect(r.error).toBeNull();
  });

  it('HTTP 401 — 상태와 짧은 본문 · 키는 어디에도 없다', async () => {
    const base = await startServer((_r, _b, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Also ${KEY.slice(0, 8)}…${KEY.slice(-8)}` } }));
    });
    const p = new OpenAiCompatProvider({ id: 'p', baseUrl: base, apiKey: KEY });
    const chunks = await all(p.chat(req));
    expect(chunks).toHaveLength(1);
    const c = chunks[0];
    expect(c?.type).toBe('error');
    const msg = c?.type === 'error' ? c.message : '';
    expect(msg).toMatch(/^HTTP 401: /);
    expect(msg).toContain('Incorrect API key');
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain(KEY.slice(0, 8));
    expect(msg).not.toContain(KEY.slice(-8));
    // 공급자 객체를 찍어도 키가 안 보인다(private 필드)
    expect(JSON.stringify(p)).not.toContain(KEY);
    const r = await collectChat(p.chat(req));
    expect(r.error).not.toContain(KEY);
  });

  it('연결 실패 오류 글에도 키가 없다', async () => {
    const p = new OpenAiCompatProvider({ id: 'p', baseUrl: 'http://127.0.0.1:1', apiKey: KEY });
    const r = await collectChat(p.chat(req));
    expect(r.error).toMatch(/요청 실패/);
    expect(r.error).not.toContain(KEY);
  });

  it('[DONE] 없이 끊기면 그때까지 delta 를 낸 뒤 error', async () => {
    const base = await startServer((_r, _b, res) => sse(res, [{ choices: [{ delta: { content: '반쯤' } }] }], { done: false }));
    const chunks = await all(new OpenAiCompatProvider({ id: 'p', baseUrl: base }).chat(req));
    expect(chunks).toEqual([
      { type: 'delta', text: '반쯤' },
      { type: 'error', message: '스트림이 [DONE] 없이 끊겼습니다' },
    ]);
  });

  it('스트림 안의 error 사건 → error 조각(키 가림)', async () => {
    const base = await startServer((_r, _b, res) => sse(res, [{ error: { message: `upstream rejected ${KEY}` } }]));
    const r = await collectChat(new OpenAiCompatProvider({ id: 'p', baseUrl: base, apiKey: KEY }).chat(req));
    expect(r.error).toMatch(/스트림 오류: upstream rejected \*\*\*/);
    expect(r.finishReason).toBeNull();
  });

  it('abort — 스트림 중간에 끊으면 done(aborted) · 서버 연결도 닫힌다', async () => {
    let closed = false;
    const base = await startServer((req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '첫' } }] })}\n\n`);
      req.socket.on('close', () => (closed = true));
      // 끝내지 않는다
    });
    const ctrl = new AbortController();
    const out: ChatChunk[] = [];
    for await (const c of new OpenAiCompatProvider({ id: 'p', baseUrl: base }).chat(req, ctrl.signal)) {
      out.push(c);
      if (c.type === 'delta') ctrl.abort();
    }
    expect(out).toEqual([
      { type: 'delta', text: '첫' },
      { type: 'done', finishReason: 'aborted' },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it('이미 중단된 signal 이면 요청을 보내지 않는다', async () => {
    const base = await startServer((_r, _b, res) => sse(res, []));
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = await all(new OpenAiCompatProvider({ id: 'p', baseUrl: base }).chat(req, ctrl.signal));
    expect(chunks).toEqual([{ type: 'done', finishReason: 'aborted' }]);
    expect(seen).toHaveLength(0);
  });

  it('첫 바이트 시간초과', async () => {
    const base = await startServer(() => {
      /* 답하지 않는다 */
    });
    const r = await collectChat(new OpenAiCompatProvider({ id: 'p', baseUrl: base, firstByteTimeoutMs: 80 }).chat(req));
    expect(r.error).toMatch(/첫 바이트 시간초과\(80ms\)/);
  });

  it('stream 을 무시하고 JSON 한 번에 답하는 서버도 같은 꼴', async () => {
    const base = await startServer((_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '한 번에', reasoning_content: '음' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    });
    const r = await collectChat(new OpenAiCompatProvider({ id: 'p', baseUrl: base }).chat(req));
    expect(r).toMatchObject({ text: '한 번에', reasoning: '음', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } });
  });

  it('reasoning 칸 — 기본은 안 보냄 · openai · openrouter 꼴', () => {
    const r = { ...req, reasoning: 'high' as const };
    expect(new OpenAiCompatProvider({ id: 'p', baseUrl: 'http://x' }).buildBody(r)).not.toHaveProperty('reasoning');
    expect(new OpenAiCompatProvider({ id: 'p', baseUrl: 'http://x', reasoningParam: 'openai' }).buildBody(r)).toMatchObject({ reasoning_effort: 'high' });
    expect(new OpenAiCompatProvider({ id: 'p', baseUrl: 'http://x', reasoningParam: 'openrouter' }).buildBody({ ...req, reasoning: 'off' })).toMatchObject({ reasoning: { enabled: false } });
    expect(new OpenAiCompatProvider({ id: 'p', baseUrl: 'http://x', streamUsage: false }).buildBody(req)).not.toHaveProperty('stream_options');
  });
});

describe('redactSecret', () => {
  it('키 전체 · 앞뒤 8자를 가린다 · 키가 없으면 그대로', () => {
    expect(redactSecret(`a ${KEY} b`, KEY)).toBe('a *** b');
    expect(redactSecret(`${KEY.slice(0, 8)}...`, KEY)).toBe('***...');
    expect(redactSecret('그대로', null)).toBe('그대로');
  });
});
