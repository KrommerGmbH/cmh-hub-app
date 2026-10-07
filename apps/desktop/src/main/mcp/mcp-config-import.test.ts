import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyValue, knownConfigPaths, McpConfigImportError, parseMcpConfig } from './mcp-config-import.js';

const fixture = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const expectImportError = (text: string, snippetKey: string): void => {
  try {
    parseMcpConfig(text);
    expect.unreachable(text);
  } catch (e) {
    expect(e).toBeInstanceOf(McpConfigImportError);
    expect((e as McpConfigImportError).snippetKey).toBe(snippetKey);
  }
};

describe('MCP 설정 가져오기 — Claude Desktop(mcpServers · ${NAME})', () => {
  const result = parseMcpConfig(fixture('claude-desktop.json'));

  it('세 서버를 내부 꼴로 · 로컬 = stdio · 원격 = http', () => {
    expect(result.format).toBe('mcpServers');
    expect(result.servers.map((s) => s.code)).toEqual(['cmh-shop-api-mcp', 'filesystem', 'remote-example']);
    const shop = result.servers[0];
    expect(shop).toMatchObject({
      code: 'cmh-shop-api-mcp',
      name: 'cmh-shop-api-mcp',
      type: 'stdio',
      command: 'node',
      args: ['E:/Kang/project/cmh-mcp/packages/cmh-shop-api-mcp/dist/index.js'],
      url: null,
      envKeys: ['SHOPWARE_API_CLIENT_ID', 'SHOPWARE_API_SECRET'],
      headerKeys: [],
    });
    expect(result.servers[1]).toMatchObject({ type: 'stdio', command: 'npx', envKeys: [], secretRefs: [] });
    expect(result.servers[2]).toMatchObject({ type: 'http', command: null, args: [], url: 'https://example.com/mcp', headerKeys: ['Authorization'] });
  });

  it('자리표는 이름만 · literal 값은 버리고 경고', () => {
    expect(result.servers[0]?.secretRefs).toEqual([
      { field: 'env', name: 'SHOPWARE_API_CLIENT_ID', placeholder: 'SHOPWARE_API_CLIENT_ID', syntax: 'plain' },
      { field: 'env', name: 'SHOPWARE_API_SECRET', placeholder: '', syntax: 'literal' },
    ]);
    expect(result.servers[2]?.secretRefs).toEqual([{ field: 'header', name: 'Authorization', placeholder: 'TOKEN', syntax: 'plain' }]);
    expect(result.warnings.some((w) => w.includes('SHOPWARE_API_SECRET') && w.includes('literal'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Authorization') && w.includes('around'))).toBe(true);
    expect(result.warnings).toContain('Unknown top-level key "globalShortcut" ignored');
  });

  it('literal 비밀값 · 자리표 밖 글자가 결과 어디에도 없다', () => {
    const dump = JSON.stringify(result);
    expect(dump).not.toContain('literal-secret-value-should-not-leak');
    expect(dump).not.toContain('Bearer');
  });
});

describe('MCP 설정 가져오기 — Cursor(${env:NAME})', () => {
  const result = parseMcpConfig(fixture('cursor.json'));

  it('env 자리표 · 원격 headers', () => {
    expect(result.format).toBe('mcpServers');
    expect(result.servers[0]).toMatchObject({ code: 'github', type: 'stdio', command: 'docker', envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'] });
    expect(result.servers[0]?.secretRefs).toEqual([
      { field: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN', placeholder: 'GITHUB_PERSONAL_ACCESS_TOKEN', syntax: 'env' },
    ]);
    expect(result.servers[1]?.secretRefs).toEqual([
      { field: 'header', name: 'X-Api-Key', placeholder: 'DOCS_API_KEY', syntax: 'env' },
      { field: 'header', name: 'X-Team', placeholder: '', syntax: 'literal' },
    ]);
    expect(JSON.stringify(result)).not.toContain('cursor-literal-header-should-not-leak');
  });
});

describe('MCP 설정 가져오기 — VS Code(servers · inputs · ${input:id})', () => {
  const result = parseMcpConfig(fixture('vscode.json'));

  it('servers + type · inputs(default 값은 버림)', () => {
    expect(result.format).toBe('vscode');
    expect(result.servers[0]).toMatchObject({ code: 'perplexity', type: 'stdio', command: 'npx', args: ['-y', 'server-perplexity-ask'] });
    expect(result.servers[0]?.secretRefs).toEqual([{ field: 'env', name: 'PERPLEXITY_API_KEY', placeholder: 'perplexity-key', syntax: 'input' }]);
    expect(result.servers[1]).toMatchObject({ code: 'github-remote', type: 'http', url: 'https://api.githubcopilot.com/mcp/' });
    expect(result.inputs).toEqual([
      { id: 'perplexity-key', type: 'promptString', description: 'Perplexity API Key', password: true },
      { id: 'unused-input', type: 'promptString', description: 'Not referenced', password: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('default-value-should-not-leak');
  });

  it('없는 input 을 가리키면 경고', () => {
    expect(result.warnings.some((w) => w.includes('unknown input "missing-input"'))).toBe(true);
  });
});

describe('MCP 설정 가져오기 — 경고와 예외', () => {
  it('깨진 JSON = importInvalidJson · 메시지에 원문이 없다', () => {
    const text = '{"mcpServers": {"x": {"command": "node", "env": {"K": "secret-in-broken-json"}}';
    expectImportError(text, 'cmh-hub-app.mcp.importInvalidJson');
    try { parseMcpConfig(text); } catch (e) { expect((e as Error).message).not.toContain('secret-in-broken-json'); }
  });

  it('꼴이 틀리면 importInvalid', () => {
    const cases = [
      '[]',
      '{}',
      '{"mcpServers": {}, "servers": {}}',
      '{"mcpServers": []}',
      '{"mcpServers": {"x": "node"}}',
      '{"mcpServers": {"x": {}}}',
      '{"mcpServers": {"x": {"command": "node", "url": "https://a"}}}',
      '{"mcpServers": {"x": {"command": "node", "args": "a b"}}}',
      '{"mcpServers": {"x": {"command": "node", "args": [1]}}}',
      '{"mcpServers": {"x": {"command": "node", "env": {"K": 1}}}}',
      '{"mcpServers": {"x": {"command": "node", "env": {"BAD-NAME": "v"}}}}',
      '{"mcpServers": {"x": {"command": ["node"]}}}',
      '{"servers": {"x": {"type": "websocket", "url": "wss://a"}}}',
      '{"servers": {}, "inputs": {}}',
      '{"servers": {}, "inputs": [{"id": "a"}, {"id": "a"}]}',
      `{"mcpServers": {"${'x'.repeat(65)}": {"command": "node"}}}`,
    ];
    for (const c of cases) expectImportError(c, 'cmh-hub-app.mcp.importInvalid');
  });

  it('빈 command · 모르는 키 · sse · type 빠진 VS Code 는 경고만', () => {
    const r = parseMcpConfig(JSON.stringify({
      mcpServers: {
        empty: { command: '  ' },
        extra: { command: 'node', cwd: '/tmp' },
        legacy: { type: 'sse', url: 'https://a/sse' },
      },
    }));
    expect(r.servers[0]).toMatchObject({ code: 'empty', type: 'stdio', command: null });
    expect(r.servers[2]).toMatchObject({ type: 'http', url: 'https://a/sse' });
    expect(r.warnings).toEqual([
      'Server "empty": empty "command"',
      'Server "extra": unknown key "cwd" ignored',
      'Server "legacy": type "sse" imported as "http" (SSE is deprecated)',
    ]);
    const v = parseMcpConfig('{"servers": {"a": {"command": "node"}}}');
    expect(v.servers[0]?.type).toBe('stdio');
    expect(v.warnings[0]).toContain('missing "type"');
  });

  it('BOM 이 붙은 파일도 읽는다', () => {
    expect(parseMcpConfig('\uFEFF{"mcpServers": {}}').servers).toEqual([]);
  });

  it('classifyValue — 자리표 여럿 · 틀린 이름은 literal', () => {
    expect(classifyValue('${A}:${env:B}')).toEqual([{ placeholder: 'A', syntax: 'plain' }, { placeholder: 'B', syntax: 'env' }]);
    expect(classifyValue('${not valid}')).toEqual([]);
    expect(classifyValue('plain-value')).toEqual([]);
  });
});

describe('knownConfigPaths(research/04 §1)', () => {
  it('Windows — %APPDATA%\\Claude · ~\\.cursor', () => {
    const paths = knownConfigPaths('win32', 'C:\\Users\\kang', 'C:\\Users\\kang\\AppData\\Roaming');
    expect(paths).toEqual([
      { app: 'claude-desktop', scope: 'global', path: 'C:\\Users\\kang\\AppData\\Roaming\\Claude\\claude_desktop_config.json', format: 'mcpServers' },
      { app: 'cursor', scope: 'global', path: 'C:\\Users\\kang\\.cursor\\mcp.json', format: 'mcpServers' },
      { app: 'portable', scope: 'workspace', path: '.mcp.json', format: 'mcpServers' },
      { app: 'cursor', scope: 'workspace', path: '.cursor\\mcp.json', format: 'mcpServers' },
      { app: 'vscode', scope: 'workspace', path: '.vscode\\mcp.json', format: 'vscode' },
    ]);
  });

  it('macOS · Linux — appData 아래 Claude', () => {
    expect(knownConfigPaths('darwin', '/Users/k', '/Users/k/Library/Application Support')[0]?.path)
      .toBe('/Users/k/Library/Application Support/Claude/claude_desktop_config.json');
    expect(knownConfigPaths('linux', '/home/k', '/home/k/.config')[0]?.path).toBe('/home/k/.config/Claude/claude_desktop_config.json');
    expect(knownConfigPaths('freebsd', '/home/k', '/home/k/.config').some((p) => p.app === 'claude-desktop')).toBe(false);
  });
});
