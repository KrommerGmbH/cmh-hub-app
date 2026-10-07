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
      needsApproval: false,
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
