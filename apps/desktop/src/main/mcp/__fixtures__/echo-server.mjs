// R3-b 시험용 stdio MCP 서버 — mcp-server-manager.test.ts 가 `process.execPath`(node) 로 띄운다. 앱 빌드에는 안 들어간다.
// 도구: echo · slow(ms 만큼 기다림 · 취소 신호를 따른다) · env_keys(자식이 받은 env 이름 목록) · fail(비밀값을 넣은 오류) · big(큰 글) · `bad:name`(`:` 든 이름)
// 프롬프트: greet. 시험 손잡이는 env 로만 받는다(부모 env 는 안 넘어오므로 매니저의 envKeys + resolveSecret 를 거쳐야 닿는다):
//   ECHO_LEGACY=1 → `server.connect(new StdioServerTransport())`(2025 `initialize` 만) · 없으면 `serveStdio`(2026-07-28 `server/discover` 도 받음)
//   ECHO_CRASH_AT_START=1 → stderr 에 CMH_TEST_TOKEN 을 찍고 바로 끝남 · ECHO_EXTRA_TOOLS=N → extra_0..N-1 도구를 더함(긴 설명)
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

if (process.env.ECHO_CRASH_AT_START === '1') {
  process.stderr.write(`fatal: cannot start (token=${process.env.CMH_TEST_TOKEN ?? ''})\n`);
  process.exit(1);
}

function build() {
  const server = new McpServer({ name: 'cmh-echo-fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    { title: 'Echo', description: 'Returns the given text.', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  server.registerTool(
    'slow',
    { description: 'Waits ms milliseconds, then answers.', inputSchema: z.object({ ms: z.number().int().min(0) }) },
    async ({ ms }, ctx) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content: [{ type: 'text', text: `slept ${ms}` }] }), ms);
        ctx.mcpReq.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('cancelled'));
        });
      }),
  );

  server.registerTool('env_keys', { description: 'Lists the environment variable names this process received.' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).sort()) }],
  }));

  server.registerTool('fail', { description: 'Fails with a message that contains CMH_TEST_TOKEN.' }, async () => {
    throw new Error(`upstream rejected token ${process.env.CMH_TEST_TOKEN ?? ''}`);
  });

  server.registerTool(
    'big',
    { description: 'Returns a text of the given size in bytes.', inputSchema: z.object({ bytes: z.number().int().min(0) }) },
    async ({ bytes }) => ({ content: [{ type: 'text', text: 'x'.repeat(bytes) }] }),
  );

  // `:` 는 SEP-986 허용 글자가 아니지만 SDK 는 경고만 하고 등록한다 — 매니저가 건너뛰는지 본다
  server.registerTool('bad:name', { description: 'Name with a colon.' }, async () => ({ content: [{ type: 'text', text: 'should not be reachable' }] }));

  const extra = Number(process.env.ECHO_EXTRA_TOOLS ?? '0');
  for (let i = 0; i < extra; i++) {
    server.registerTool(`extra_${i}`, { description: `extra tool ${i} `.padEnd(3000, 'd') }, async () => ({ content: [{ type: 'text', text: String(i) }] }));
  }

  server.registerPrompt(
    'greet',
    { title: 'Greet', description: 'Greets someone.', argsSchema: z.object({ name: z.string() }) },
    ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${name}!` } }] }),
  );

  return server;
}

if (process.env.ECHO_LEGACY === '1') {
  await build().connect(new StdioServerTransport());
} else {
  serveStdio(build);
}
