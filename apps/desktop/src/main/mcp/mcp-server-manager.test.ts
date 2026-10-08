// R3-b McpServerManager 시험 — 진짜 stdio 자식(`process.execPath` + __fixtures__/echo-server.mjs)과 메모리 안 HTTP(createMcpHandler + 가짜 fetch).
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  MCP_SNIPPET_KEYS,
  McpManagerError,
  McpServerManager,
  defaultNeedsApproval,
  findExecutable,
  isAlive,
  redactSecrets,
  truncateBytes,
  type McpServerManagerOptions,
  type McpServerRow,
} from './mcp-server-manager.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/echo-server.mjs', import.meta.url));
const TOKEN = 'tok-SECRET-9f3a71';

function row(over: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 'srv-1',
    code: 'echo',
    name: 'Echo',
    type: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    url: null,
    envKeys: ['CMH_TEST_TOKEN'],
    active: true,
    ...over,
  };
}

const managers: McpServerManager[] = [];
function manager(secrets: Record<string, string> = { CMH_TEST_TOKEN: TOKEN }, over: Partial<McpServerManagerOptions> = {}) {
  const resolveSecret = vi.fn(async (_id: string, name: string) => secrets[name] ?? null);
  const warn = vi.fn();
  const m = new McpServerManager({ resolveSecret, logger: { warn }, connectTimeoutMs: 15_000, ...over });
  managers.push(m);
  return { m, resolveSecret, warn };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
});

describe('McpServerManager · stdio', () => {
  it('붙고 → 도구 목록(캐시 · cmh_ai_mcp_tool 꼴 · `:` 건너뜀) → echo → 프롬프트 → close 뒤 자식 pid 가 없다', async () => {
    const { m, warn } = manager();
    const state = await m.connect(row());
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe('2026-07-28'); // serveStdio 고정물 → versionNegotiation auto 가 modern 을 골랐다
    expect(state.pid).toEqual(expect.any(Number));
    const pid = state.pid as number;
    expect(isAlive(pid)).toBe(true);

    const first = await m.listTools('echo');
    expect(first.tools.map((t) => t.name)).toEqual(['echo', 'slow', 'env_keys', 'fail', 'big']);
    expect(first.warnings.join('\n')).toContain('bad:name');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad:name'));
    expect(first.tools[0]).toEqual({
      serverId: 'srv-1',
      name: 'echo',
      title: 'Echo',
      description: 'Returns the given text.',
      parameters: expect.objectContaining({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
      active: true,
      needsApproval: true, // 검수 5 차단 2 — 저장 행 없는 처음 보는 도구는 읽기 꼴 이름(get · list · search …)이 아니면 true
    });
    const cached = await m.listTools('echo');
    expect(cached.tools).toEqual(first.tools);
    expect(cached.warnings).toEqual([]); // 캐시에서 — 다시 묻지 않았다

    expect(await m.callTool('echo', 'echo', { text: '안녕 MCP' })).toEqual({ ok: true, text: '안녕 MCP', truncated: false, bytes: Buffer.byteLength('안녕 MCP') });
    const skipped = await m.callTool('echo', 'bad:name', {});
    expect(skipped).toMatchObject({ ok: false, errorKey: MCP_SNIPPET_KEYS.toolNotFound });

    const prompts = await m.listPrompts('echo');
    expect(prompts).toEqual([
      { serverId: 'srv-1', code: 'echo', name: 'greet', title: 'Greet', description: 'Greets someone.', arguments: [{ name: 'name', description: null, required: true }] },
    ]);
    expect(await m.getPrompt('echo', 'greet', { name: 'Kang' })).toEqual({ description: null, messages: [{ role: 'user', text: 'Hello, Kang!' }] });

    expect(await m.close('echo')).toEqual({ code: 'echo', exited: true });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(m.getState('echo')?.status).toBe('closed');
    await expect(m.listTools('echo')).rejects.toBeInstanceOf(McpManagerError);
  }, 30_000);

  it('옛 서버(2025 initialize 만)에도 auto 협상으로 붙는다', async () => {
    const { m } = manager({ CMH_TEST_TOKEN: TOKEN, ECHO_LEGACY: '1' });
    const state = await m.connect(row({ envKeys: ['CMH_TEST_TOKEN', 'ECHO_LEGACY'] }));
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).not.toBe('2026-07-28');
    expect(await m.callTool('echo', 'echo', { text: 'legacy' })).toMatchObject({ ok: true, text: 'legacy' });
  }, 30_000);

  it('slow 를 시간초과 · 취소하면 던지지 않고 ok:false · 그 뒤에도 연결은 산다', async () => {
    const { m } = manager();
    await m.connect(row());
    const timedOut = await m.callTool('echo', 'slow', { ms: 10_000 }, { timeoutMs: 300 });
    expect(timedOut).toMatchObject({ ok: false, errorKey: MCP_SNIPPET_KEYS.callTimeout });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const aborted = await m.callTool('echo', 'slow', { ms: 10_000 }, { signal: ac.signal });
    expect(aborted).toMatchObject({ ok: false, errorKey: MCP_SNIPPET_KEYS.callAborted });
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(await m.callTool('echo', 'slow', { ms: 10 })).toMatchObject({ ok: true, text: 'slept 10' });
  }, 30_000);

  it('자식 env = SDK 기본 목록 + envKeys 만(부모 env 전체를 넘기지 않는다)', async () => {
    process.env.CMH_LEAK_CHECK = 'must-not-reach-child';
    try {
      const { m } = manager();
      await m.connect(row());
      const res = await m.callTool('echo', 'env_keys', {});
      expect(res.ok).toBe(true);
      const keys = JSON.parse(res.ok ? res.text : '[]') as string[];
      const allowed = new Set([...DEFAULT_INHERITED_ENV_VARS, 'CMH_TEST_TOKEN']);
      expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
      expect(keys).toContain('CMH_TEST_TOKEN');
      expect(keys).not.toContain('CMH_LEAK_CHECK');
    } finally {
      delete process.env.CMH_LEAK_CHECK;
    }
  }, 30_000);

  it('resolveSecret 값은 도구 오류 · 연결 오류 글에 나오지 않는다', async () => {
    const { m } = manager();
    await m.connect(row());
    const failed = await m.callTool('echo', 'fail', {});
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.errorKey).toBe(MCP_SNIPPET_KEYS.toolFailed);
    expect(failed.error).toContain('upstream rejected token ***');
    expect(failed.error).not.toContain(TOKEN);

    const crash = manager({ CMH_TEST_TOKEN: TOKEN, ECHO_CRASH_AT_START: '1' });
    const state = await crash.m.connect(row({ code: 'crash', envKeys: ['CMH_TEST_TOKEN', 'ECHO_CRASH_AT_START'] }));
    expect(state.status).toBe('error');
    expect(state.errorKey).toBe(MCP_SNIPPET_KEYS.connectFailed);
    expect(state.errorMessage).toContain('fatal: cannot start (token=***)');
    expect(state.errorMessage).not.toContain(TOKEN);
  }, 30_000);

  it('비밀값이 없으면 띄우지 않고 error(secretMissing) · 이름만 남긴다', async () => {
    const { m } = manager({});
    const state = await m.connect(row());
    expect(state).toMatchObject({ status: 'error', errorKey: MCP_SNIPPET_KEYS.secretMissing, pid: null });
    expect(state.errorMessage).toContain('CMH_TEST_TOKEN');
  });

  it('active:false 는 띄우지 않는다(resolveSecret 도 안 부른다)', async () => {
    const { m, resolveSecret } = manager();
    const state = await m.connect(row({ active: false }));
    expect(state).toMatchObject({ status: 'idle', pid: null });
    expect(resolveSecret).not.toHaveBeenCalled();
    expect((await m.callTool('echo', 'echo', { text: 'x' })).ok).toBe(false);
  });

  it('런타임이 PATH 에 없으면 error + 안내 스니펫 키 · 비밀값을 꺼내지 않는다', async () => {
    const { m, resolveSecret } = manager();
    const bare = await m.connect(row({ code: 'missing', command: 'cmh-no-such-runtime-7f2c', args: [] }));
    expect(bare).toMatchObject({ status: 'error', errorKey: 'cmh-hub-app.mcp.runtimeMissing' });
    const abs = await m.connect(row({ code: 'missing-abs', command: '/nonexistent/cmh/node', args: [] }));
    expect(abs).toMatchObject({ status: 'error', errorKey: MCP_SNIPPET_KEYS.runtimeMissing });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('토큰 상한 — maxTools(64) · maxDescriptionChars(1000) 로 자르고 경고', async () => {
    const { m } = manager({ CMH_TEST_TOKEN: TOKEN, ECHO_EXTRA_TOOLS: '70' });
    await m.connect(row({ envKeys: ['CMH_TEST_TOKEN', 'ECHO_EXTRA_TOOLS'] }));
    const { tools, warnings } = await m.listTools('echo');
    expect(tools).toHaveLength(64);
    expect(warnings.join('\n')).toMatch(/kept 64 tools, dropped 11/);
    const extra = tools.find((t) => t.name === 'extra_0');
    expect(extra?.description).toHaveLength(1001); // 1000 + «…»
    expect(warnings.join('\n')).toMatch(/cut 59 descriptions to 1000 chars/);
  }, 30_000);

  it('큰 결과는 maxResultBytes(64KB)로 잘라 표시한다', async () => {
    const { m } = manager();
    await m.connect(row());
    const res = await m.callTool('echo', 'big', { bytes: 70_000 });
    expect(res).toMatchObject({ ok: true, truncated: true, bytes: 70_000 });
    if (!res.ok) return;
    expect(res.text.startsWith('x'.repeat(64 * 1024))).toBe(true);
    expect(res.text).toContain('[truncated: 70000 bytes, showing 65536]');
  }, 30_000);

  it('연결 시간초과 → error(connectTimeout) · 띄운 자식은 정리한다', async () => {
    // 답하지 않는 자식 — 자기 pid 를 파일에 적는다(auto 협상의 떠보기 자식까지 둘일 수 있다)
    const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'cmh-mcp-')), 'pids');
    const script = "require('fs').appendFileSync(process.argv[1], process.pid + '\\n'); setInterval(() => {}, 1000)";
    const { m } = manager({}, { connectTimeoutMs: 800 });
    const started = Date.now();
    const state = await m.connect(row({ code: 'mute', args: ['-e', script, pidFile], envKeys: [] }));
    expect(state).toMatchObject({ status: 'error', errorKey: MCP_SNIPPET_KEYS.connectTimeout, pid: null });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.filter((pid) => isAlive(pid))).toEqual([]);
  }, 30_000);

  it('자식이 혼자 죽으면 상태가 error(connectionClosed)로 바뀐다', async () => {
    const { m } = manager();
    const state = await m.connect(row());
    process.kill(state.pid as number, 'SIGKILL');
    await vi.waitFor(() => expect(m.getState('echo')?.status).toBe('error'), { timeout: 5_000 });
    expect(m.getState('echo')?.errorKey).toBe(MCP_SNIPPET_KEYS.connectionClosed);
  }, 30_000);
});

describe('McpServerManager · http', () => {
  it('헤더 값을 resolveSecret 로 채워 Streamable HTTP 로 붙는다', async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'cmh-http-fixture', version: '1.0.0' });
      server.registerTool('echo', { description: 'echo', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
      return server;
    });
    const seen: (string | null)[] = [];
    const httpFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(url, init);
      seen.push(req.headers.get('X-Api-Key'));
      return handler.fetch(req);
    };
    const { m } = manager({ 'X-Api-Key': TOKEN }, { httpFetch });
    const state = await m.connect(row({ code: 'remote', type: 'http', command: null, args: [], url: 'http://127.0.0.1:65530/mcp', envKeys: ['X-Api-Key'] }));
    expect(state).toMatchObject({ status: 'connected', pid: null });
    expect(await m.callTool('remote', 'echo', { text: 'over http' })).toMatchObject({ ok: true, text: 'over http' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === TOKEN)).toBe(true);
    expect(await m.close('remote')).toEqual({ code: 'remote', exited: true });
    await handler.close();
  }, 30_000);
});

describe('도우미', () => {
  it('redactSecrets — 긴 값부터 가린다', () => {
    expect(redactSecrets('a=abc123 b=abc', ['abc', 'abc123'])).toBe('a=*** b=***');
    expect(redactSecrets('nothing', [''])).toBe('nothing');
  });

  it('truncateBytes — 멀티바이트 중간에서 깨진 조각을 남기지 않는다', () => {
    const r = truncateBytes('가나다', 4); // 가(3) + 나의 첫 바이트
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('가\n…[truncated: 9 bytes')).toBe(true);
  });

  it('findExecutable — PATH 에서 찾고 없으면 null', async () => {
    expect(await findExecutable('node', process.env.PATH ?? '', process.platform)).not.toBeNull();
    expect(await findExecutable('cmh-no-such-runtime-7f2c', process.env.PATH ?? '', process.platform)).toBeNull();
  });
});

// ── 3차 검수 ─────────────────────────────────────────────

/** 메모리 안 HTTP MCP 서버 — 도구 · 프롬프트를 마음대로 단다 */
function httpServer(setup: (server: McpServer) => void) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'cmh-http-fixture-3', version: '1.0.0' });
    setup(server);
    return server;
  });
  const httpFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => handler.fetch(new Request(url, init));
  return { handler, httpFetch };
}

const httpRow = (over: Partial<McpServerRow> = {}): McpServerRow =>
  row({ id: 'srv-http', code: 'remote', type: 'http', command: null, args: [], url: 'http://127.0.0.1:65531/mcp', envKeys: [], ...over });

const textTool = (server: McpServer, name: string): void => {
  server.registerTool(name, { description: name, inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
};

describe('3차 검수 차단 1 — needsApproval', () => {
  it('listTools 는 cmh_ai_mcp_tool.needs_approval 값을 실어 준다', async () => {
    const { handler, httpFetch } = httpServer((s) => {
      for (const n of ['echo', 'save_draft', 'lookup', 'off_tool']) textTool(s, n);
    });
    const stored = [
      { name: 'lookup', needsApproval: true, active: true }, // 사람이 true 로 정함 — 이름 규칙(읽기 꼴 → false)보다 이긴다
      { name: 'save_draft', needsApproval: false, active: true }, // 사람이 false 로 정함 — 이름 규칙(true)보다 이긴다
      { name: 'off_tool', needsApproval: false, active: false }, // 꺼 둔 도구는 목록에서 빠지고 부를 수 없다
    ];
    const knownToolRows = vi.fn(async (serverId: string) => (serverId === 'srv-http' ? stored : []));
    const { m } = manager({}, { httpFetch, knownToolRows });
    expect((await m.connect(httpRow())).status).toBe('connected');
    const first = await m.listTools('remote');
    expect(first.tools.map((t) => [t.name, t.needsApproval])).toEqual([
      ['echo', true], // 저장 행 없음 · 읽기 꼴 이름 아님 → true(검수 5 차단 2)
      ['save_draft', false],
      ['lookup', true],
    ]);
    expect(first.warnings.join('\n')).toContain('off_tool');
    expect(knownToolRows).toHaveBeenCalledWith('srv-http');
    // 캐시에서도 저장 행을 다시 합친다 — 사람이 바꾼 값이 바로 먹는다
    stored[0] = { name: 'lookup', needsApproval: false, active: true };
    expect((await m.listTools('remote')).tools.find((t) => t.name === 'lookup')?.needsApproval).toBe(false);
    expect(await m.callTool('remote', 'off_tool', { text: 'x' })).toMatchObject({ ok: false, errorKey: MCP_SNIPPET_KEYS.toolNotFound });
    // 저장 행을 못 읽으면 모두 승인 필요(막는 쪽)
    knownToolRows.mockRejectedValueOnce(new Error('db down'));
    expect((await m.listTools('remote')).tools.every((t) => t.needsApproval)).toBe(true);
    await m.close('remote');
    await handler.close();
  }, 30_000);

  it('처음 보는 쓰기 꼴 도구는 needsApproval true', async () => {
    const names = ['save_draft', 'sendMessage', 'dal_update', 'createOrder', 'file_upload', 'publish_post', 'search', 'get_price', 'list_items'];
    const { handler, httpFetch } = httpServer((s) => {
      for (const n of names) textTool(s, n);
    });
    const { m } = manager({}, { httpFetch }); // knownToolRows 없음 = 저장 행 없음
    await m.connect(httpRow());
    const { tools } = await m.listTools('remote');
    expect(Object.fromEntries(tools.map((t) => [t.name, t.needsApproval]))).toEqual({
      save_draft: true,
      sendMessage: true,
      dal_update: true,
      createOrder: true,
      file_upload: true,
      publish_post: true,
      search: false,
      get_price: false,
      list_items: false,
    });
    for (const n of ['approve_request', 'remove_item', 'write_file', 'pay_invoice', 'submit_form', 'delete_row']) expect(defaultNeedsApproval(n), n).toBe(true);
    await m.close('remote');
    await handler.close();
  }, 30_000);

  it('검수 5 차단 2(E4) — 처음 보는 도구는 needsApproval true · 읽기 꼴 이름만 false · 쓰기 낱말이 읽기 낱말을 이긴다', () => {
    // cmh-mcp packages 의 실제 도구 이름(registerTool) — 이름 규칙이 거꾸로 되기 전에는 모두 false 였다(검수 5 재현)
    for (const n of [
      'browser_api',
      'browser_api_patch',
      'browser_evaluate',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_act',
      'browser_cookies_import',
      'market_task_done',
      'market_element_fix',
      'market_approval_hold',
      'market_approval_decide',
      'talk_send',
      'browser_field_save',
      'echo',
      'unknown',
      '',
      'search_and_delete', // 쓰기 낱말이 이긴다
      'getAndUpdate',
      'list_then_patch',
    ]) {
      expect(defaultNeedsApproval(n), n).toBe(true);
    }
    for (const n of [
      'browser_snapshot',
      'browser_take_screenshot',
      'browser_wait_for',
      'browser_status',
      'browser_extract',
      'market_product_search',
      'market_approval_pending',
      'market_screen_brief',
      'market_screen_detail',
      'market_capabilities',
      'market_help_read',
      'dal_get',
      'dal_search',
      'dalAggregate',
      'order_list',
      'getPrice',
    ]) {
      expect(defaultNeedsApproval(n), n).toBe(false);
    }
  });
});

describe('3차 검수 권고 — connect · close 경합', () => {
  it('connect 는 close 중이면 close 가 끝나기를 기다린 뒤 새로 띄운다', async () => {
    const { m } = manager();
    const first = await m.connect(row());
    const oldPid = first.pid as number;
    const closing = m.close('echo');
    const second = await m.connect(row());
    expect(await closing).toEqual({ code: 'echo', exited: true });
    expect(second.status).toBe('connected');
    expect(second.pid).not.toBe(oldPid);
    expect(isAlive(oldPid)).toBe(false);
    expect(m.getState('echo')?.status).toBe('connected');
    expect(await m.callTool('echo', 'echo', { text: 'again' })).toMatchObject({ ok: true, text: 'again' });
  }, 30_000);

  it('connect 도중 close 하면 connect 결과는 closed', async () => {
    const { m } = manager();
    const connecting = m.connect(row());
    await new Promise((r) => setTimeout(r, 5));
    const closed = await m.close('echo');
    const state = await connecting;
    expect(closed).toEqual({ code: 'echo', exited: true });
    expect(state).toMatchObject({ status: 'closed', pid: null });
    expect(m.getState('echo')?.status).toBe('closed');
    expect(await m.callTool('echo', 'echo', { text: 'x' })).toMatchObject({ ok: false, errorKey: MCP_SNIPPET_KEYS.notConnected });
  }, 30_000);
});

describe('3차 검수 권고 — 토큰 상한 · http 비밀 헤더 · 가리기', () => {
  it('inputSchema JSON 이 8KB 를 넘는 도구는 건너뛰고 경고 · prompts 는 maxPrompts 까지', async () => {
    const { handler, httpFetch } = httpServer((s) => {
      textTool(s, 'small');
      const shape: Record<string, z.ZodString> = {};
      for (let i = 0; i < 200; i += 1) shape[`field_${i}`] = z.string().describe('x'.repeat(40));
      s.registerTool('huge', { description: 'huge schema', inputSchema: z.object(shape) }, async () => ({ content: [{ type: 'text', text: 'h' }] }));
      for (let i = 0; i < 3; i += 1) s.registerPrompt(`p${i}`, { description: `prompt ${i}` }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: String(i) } }] }));
    });
    const { m, warn } = manager({}, { httpFetch, maxPrompts: 2 });
    await m.connect(httpRow());
    const { tools, warnings } = await m.listTools('remote');
    expect(tools.map((t) => t.name)).toEqual(['small']);
    expect(warnings.join('\n')).toMatch(/skipped tool "huge" — inputSchema larger than 8192 bytes/);
    expect((await m.listPrompts('remote')).map((p) => p.name)).toEqual(['p0', 'p1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept 2 prompts, dropped 1 (maxPrompts)'));
    await m.close('remote');
    await handler.close();
  }, 30_000);

  it('루프백이 아닌 http: 로 비밀 헤더를 보내야 하면 연결 거부(insecureHttpSecret) · 비밀값을 꺼내지 않는다', async () => {
    const { m, resolveSecret } = manager({ 'X-Api-Key': TOKEN });
    const state = await m.connect(httpRow({ url: 'http://mcp.example.com/mcp', envKeys: ['X-Api-Key'] }));
    expect(state).toMatchObject({ status: 'error', errorKey: MCP_SNIPPET_KEYS.insecureHttpSecret });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('redactSecrets — encodeURIComponent · base64 · JSON 이스케이프 · Bearer 뗀 꼴도 가린다', () => {
    const secret = 'p@ss/w0rd+SECRET=';
    expect(redactSecrets(`token=${encodeURIComponent(secret)}`, [secret])).toBe('token=***');
    expect(redactSecrets(`basic ${Buffer.from(secret).toString('base64')}`, [secret])).toBe('basic ***');
    expect(redactSecrets(`u ${Buffer.from(secret).toString('base64url')}`, [secret])).toBe('u ***');
    const quoted = 'ab"c\\dSECRETX';
    expect(redactSecrets(JSON.stringify({ t: quoted }), [quoted])).toBe('{"t":"***"}');
    expect(redactSecrets('invalid token sk-abc123', ['Bearer sk-abc123'])).toBe('invalid token ***');
  });
});
