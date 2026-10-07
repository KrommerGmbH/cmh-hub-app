import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyValue, knownConfigPaths, McpConfigImportError, parseMcpConfig, type ImportedMcpServer } from './mcp-config-import.js';

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

  it('맨 위 꼴이 틀리면 importInvalid', () => {
    const cases = [
      '[]',
      '{}',
      '{"mcpServers": {}, "servers": {}}',
      '{"mcpServers": []}',
      '{"servers": {}, "inputs": {}}',
      '{"servers": {}, "inputs": [{"id": "a"}, {"id": "a"}]}',
    ];
    for (const c of cases) expectImportError(c, 'cmh-hub-app.mcp.importInvalid');
  });

  it('서버 하나가 틀리면 그 서버만 건너뛰고 경고 · 나머지는 가져온다', () => {
    const bad: Record<string, unknown> = {
      s1: 'node',
      s2: {},
      s3: { command: 'node', url: 'https://a' },
      s4: { command: 'node', args: 'a b' },
      s5: { command: 'node', args: [1] },
      s6: { command: ['node'] },
      s7: { type: 'websocket', url: 'wss://a' },
      s8: { url: 'file:///etc/passwd' },
      s9: { url: 'not a url' },
    };
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { good: { command: 'node' }, ...bad, tail: { url: 'https://ok.example/mcp' } } }));
    expect(r.servers.map((s) => s.code)).toEqual(['good', 'tail']);
    for (const code of Object.keys(bad)) {
      expect(r.warnings.filter((w) => w.startsWith(`Server "${code}"`) && w.endsWith('server skipped')), code).toHaveLength(1);
    }
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

const one = (server: Record<string, unknown>, extra: Record<string, unknown> = {}): { server: ImportedMcpServer; warnings: string[]; dump: string } => {
  const r = parseMcpConfig(JSON.stringify({ mcpServers: { x: server }, ...extra }));
  const found = r.servers[0];
  if (!found) throw new Error(`no server: ${r.warnings.join(' | ')}`);
  return { server: found, warnings: r.warnings, dump: JSON.stringify(r) };
};

describe('검수 차단 4 — 비밀값 평문(url · args · command · 오류 문구)', () => {
  it('url userinfo(user:pass@)는 떼고 secretRef(url) + 경고', () => {
    const { server, warnings, dump } = one({ url: 'https://user:SECRET4@h.example/mcp' });
    expect(server.url).toBe('https://h.example/mcp');
    expect(server.secretRefs).toEqual([{ field: 'url', name: 'userinfo', placeholder: '', syntax: 'literal' }]);
    expect(warnings).toContain('Server "x": url userinfo removed');
    expect(dump).not.toContain('SECRET4');
    expect(dump).not.toContain('user:');
  });

  it('url 쿼리 값은 떼고 키 이름만 secretRef(url · query:<키>) · fragment 도 뗀다', () => {
    const { server, warnings, dump } = one({ url: 'https://h.example/mcp?api_key=SECRET3&team=${env:TEAM}&flag#tok=SECRET9' });
    expect(server.url).toBe('https://h.example/mcp');
    expect(server.secretRefs).toEqual([
      { field: 'url', name: 'query:api_key', placeholder: '', syntax: 'literal' },
      { field: 'url', name: 'query:team', placeholder: 'TEAM', syntax: 'env' },
    ]);
    expect(warnings.some((w) => w.includes('query values removed'))).toBe(true);
    expect(warnings.some((w) => w.includes('fragment removed'))).toBe(true);
    expect(dump).not.toContain('SECRET3');
    expect(dump).not.toContain('SECRET9');
  });

  // 3차 검수 권고로 `--x=값` 은 비밀 이름 플래그일 때만 값을 버린다 — 전에 쓰던 `-p=SECRET10` 은 `--secret=SECRET10` 으로 바꿨다
  it('args — 비밀 이름 플래그(--api-key · --token · --password …) 다음 값 · 비밀 이름 --x=값 · -x=값 의 값은 버리고 secretRef(args)', () => {
    const { server, warnings, dump } = one({
      command: 'npx',
      args: ['-y', 'pkg', '--api-key', 'sk-live-SECRET1', '--token=SECRET2', '--secret=SECRET10', '--Bearer', 'SECRET11', '--port', '8080', '--auth-token', '${env:AUTH}'],
    });
    expect(server.args).toEqual(['-y', 'pkg', '--api-key', '', '--token=', '--secret=', '--Bearer', '', '--port', '8080', '--auth-token', '${env:AUTH}']);
    expect(server.secretRefs).toEqual([
      { field: 'args', name: '--api-key', placeholder: '', syntax: 'literal' },
      { field: 'args', name: '--token', placeholder: '', syntax: 'literal' },
      { field: 'args', name: '--secret', placeholder: '', syntax: 'literal' },
      { field: 'args', name: '--Bearer', placeholder: '', syntax: 'literal' },
      { field: 'args', name: '--auth-token', placeholder: 'AUTH', syntax: 'env' },
    ]);
    expect(warnings.filter((w) => w.includes('literal value'))).toHaveLength(4);
    for (const secret of ['SECRET1', 'SECRET2', 'SECRET10', 'SECRET11']) expect(dump).not.toContain(secret);
  });

  it('args 안 주소의 userinfo 도 뗀다', () => {
    const { server, dump } = one({ command: 'node', args: ['--db', 'postgres://admin:SECRET12@db.local/x'] });
    expect(server.args).toEqual(['--db', 'postgres://db.local/x']);
    expect(dump).not.toContain('SECRET12');
  });

  it('command 의 NAME=값 env 접두는 값 버리고 경고 · 이름은 envKeys 로', () => {
    const { server, warnings, dump } = one({ command: 'API_KEY=SECRET5 OTHER="a b SECRET13" node server.js' });
    // 3차 검수 차단 3 — 공백 든 command 는 첫 낱말만 command · 나머지는 args
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['server.js']);
    expect(server.envKeys).toEqual(['API_KEY', 'OTHER']);
    expect(server.secretRefs).toEqual([
      { field: 'command', name: 'API_KEY', placeholder: '', syntax: 'literal' },
      { field: 'command', name: 'OTHER', placeholder: '', syntax: 'literal' },
    ]);
    expect(warnings.some((w) => w.includes('env prefix "API_KEY=…"'))).toBe(true);
    expect(dump).not.toContain('SECRET5');
    expect(dump).not.toContain('SECRET13');
    expect(one({ command: 'env TOKEN=${env:T} node' }).server).toMatchObject({ command: 'node', envKeys: ['TOKEN'] });
  });

  it('오류 · 경고 문구에 원값이 없다(type 원값 포함 · typeof 만)', () => {
    const r = parseMcpConfig(JSON.stringify({
      mcpServers: {
        a: { type: { secret: 'SECRET8' }, command: 'node' },
        b: { type: 'SECRET14', url: 'https://a' },
        c: { command: 'node', env: { PORT: 8080, K: 'SECRET15' } },
        d: { url: 'ftp://u:SECRET16@h/x' },
      },
    }));
    const all = r.warnings.join('\n');
    for (const secret of ['SECRET8', 'SECRET14', 'SECRET15', 'SECRET16', '8080']) expect(all).not.toContain(secret);
    expect(all).toContain('unsupported "type" value (object)');
    expect(all).toContain('unsupported "type" value (string)');
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
});

describe('검수 차단 5 — 서버 키(code) 검사 · 권고(별칭 · scheme · env 64 · 미리 정의 변수)', () => {
  it.each([
    ['evil:x', 'colon'],
    ['__proto__', 'proto'],
    ['Foo', 'uppercase'],
    ['-lead', 'leading hyphen'],
    ['k'.repeat(65), 'too long'],
    ['has space', 'space'],
    ['', 'empty'],
  ])('키 %j(%s)는 그 서버만 건너뛰고 경고', (code) => {
    const text = `{"mcpServers":{${JSON.stringify(code)}:{"command":"node"},"ok":{"command":"node"}}}`;
    const r = parseMcpConfig(text);
    expect(r.servers.map((s) => s.code)).toEqual(['ok']);
    expect(r.warnings.some((w) => w.includes('is not a valid code'))).toBe(true);
  });

  it('대소문자 중복(Foo · foo)은 소문자 쪽만 · 64자 키는 받는다', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { Foo: { command: 'node' }, foo: { command: 'node' }, ['k'.repeat(64)]: { command: 'node' } } }));
    expect(r.servers.map((s) => s.code)).toEqual(['foo', 'k'.repeat(64)]);
  });

  it('streamable-http · streamableHttp 는 http 별칭', () => {
    expect(one({ type: 'streamable-http', url: 'https://x.example' }).server.type).toBe('http');
    expect(one({ type: 'streamableHttp', url: 'https://x.example' }).server.type).toBe('http');
  });

  it('url scheme 은 http: · https: 만(대문자 scheme 은 소문자로)', () => {
    expect(one({ url: 'HTTP://x.example/mcp' }).server.url).toBe('http://x.example/mcp');
    for (const url of ['file:///etc/passwd', 'wss://a.example', 'javascript://x', 'data://x']) {
      const r = parseMcpConfig(JSON.stringify({ mcpServers: { x: { url } } }));
      expect(r.servers, url).toEqual([]);
      expect(r.warnings.some((w) => w.includes('scheme must be http or https')), url).toBe(true);
    }
  });

  it('env 이름 64자 초과 · 틀린 이름은 그 env 만 거부하고 경고(cmh_ai_mcp_server_secret.env_name String(64))', () => {
    const { server, warnings } = one({ command: 'node', env: { ['A'.repeat(65)]: '${X}', ['B'.repeat(64)]: '${Y}', 'BAD-NAME': 'v' } });
    expect(server.envKeys).toEqual(['B'.repeat(64)]);
    expect(warnings.some((w) => w.includes('name longer than 64'))).toBe(true);
    expect(warnings.some((w) => w.includes('not a valid env name'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('A'.repeat(65));
  });

  it('VS Code 미리 정의 변수(${userHome} · ${workspaceFolder} …)는 비밀 자리표가 아니라 predefinedVars · args 안 자리표도 기록', () => {
    const r = parseMcpConfig(JSON.stringify({
      servers: {
        v: {
          type: 'stdio',
          command: 'node',
          args: ['${workspaceFolder}/s.js', '--root', '${userHome}${pathSeparator}x', '--key=${input:tok}', '${env:EXTRA}'],
          env: { HOME_DIR: '${userHome}', T: '${input:tok}', B: '${workspaceFolderBasename}' },
        },
      },
      inputs: [{ id: 'tok', type: 'promptString', password: true, default: 'SECRET6' }],
    }));
    const v = r.servers[0] as ImportedMcpServer;
    expect(v.args).toEqual(['${workspaceFolder}/s.js', '--root', '${userHome}${pathSeparator}x', '--key=${input:tok}', '${env:EXTRA}']);
    expect(v.secretRefs).toEqual([
      { field: 'args', name: '--key', placeholder: 'tok', syntax: 'input' },
      { field: 'args', name: 'args[4]', placeholder: 'EXTRA', syntax: 'env' },
      { field: 'env', name: 'T', placeholder: 'tok', syntax: 'input' },
    ]);
    expect(v.predefinedVars).toEqual([
      { field: 'args', name: 'args[0]', variable: 'workspaceFolder' },
      { field: 'args', name: 'args[2]', variable: 'userHome' },
      { field: 'args', name: 'args[2]', variable: 'pathSeparator' },
      { field: 'env', name: 'HOME_DIR', variable: 'userHome' },
      { field: 'env', name: 'B', variable: 'workspaceFolderBasename' },
    ]);
    // 미리 정의 변수만 있는 env 값은 literal 경고가 아니다
    expect(r.warnings.some((w) => w.includes('HOME_DIR') && w.includes('literal'))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET6');
    expect(classifyValue('${userHome}')).toEqual([]);
    expect(classifyValue('${config:editor.tabSize}')).toEqual([]);
  });
});

describe('3차 검수 차단 3 — 가져오기 비밀값 평문 7종', () => {
  it('mcp import: --header·-H 값, args 주소 쿼리, command 안 플래그 값, 토큰 꼴 위치 인자는 결과에 없다', () => {
    const ghToken = 'Zx9QwErTy7UiOp3AsDfGh5JkLm';
    const r = parseMcpConfig(JSON.stringify({
      mcpServers: {
        header: { command: 'npx', args: ['mcp-remote', 'https://h.example/mcp', '--header', 'Authorization: Bearer SECRET1', '--header=X-Team:SECRET8'] },
        dash: { command: 'npx', args: ['x', '-H', 'X-Api-Key: SECRET2', '-h'] },
        inline: { command: 'npx -y pkg --api-key SECRET3 "C:/My Tools/run.js"' },
        dbq: { command: 'npx', args: ['server-postgres', 'postgresql://h/db?password=SECRET4&sslmode=require#frag'] },
        path: { url: `https://mcp.zapier.com/api/mcp/s/${ghToken}/mcp` },
        pat: { command: 'gh-mcp', args: ['--pat', 'ghp_SECRET6', '--githubPat', 'SECRET16', '--cookie', 'SECRET17', '--credential', 'SECRET18', '--session', 'SECRET19'] },
        pos: { command: 'npx', args: ['slack-mcp', 'xoxb-SECRET7', 'AKIASECRET20', 'sk-SECRET21', ghToken] },
        keep: { command: 'npx', args: ['-H', 'X-Api-Key: ${env:API_KEY}', '--path', '/home/me/docs', 'GITHUB_PERSONAL_ACCESS_TOKEN'] },
      },
    }));
    const dump = JSON.stringify(r);
    for (let n = 1; n <= 21; n += 1) {
      if (n === 5 || n === 9 || (n >= 10 && n <= 15)) continue;
      expect(dump, `SECRET${n}`).not.toContain(`SECRET${n}`);
    }
    expect(dump).not.toContain(ghToken);
    const by = (code: string): ImportedMcpServer => {
      const s = r.servers.find((x) => x.code === code);
      if (!s) throw new Error(code);
      return s;
    };
    // 헤더 이름은 남고 값만 빠진다
    expect(by('header').args).toEqual(['mcp-remote', 'https://h.example/mcp', '--header', 'Authorization:', '--header=X-Team:']);
    expect(by('header').secretRefs).toEqual([
      { field: 'args', name: '--header Authorization', placeholder: '', syntax: 'literal' },
      { field: 'args', name: '--header X-Team', placeholder: '', syntax: 'literal' },
    ]);
    expect(by('dash').args).toEqual(['x', '-H', 'X-Api-Key:', '-h']);
    // command 는 첫 낱말만 · 나머지는 args 로 옮겨 같은 규칙(따옴표 낱말은 하나로)
    expect(by('inline')).toMatchObject({ command: 'npx', args: ['-y', 'pkg', '--api-key', '', 'C:/My Tools/run.js'] });
    // args 주소 — 쿼리 · fragment 를 떼고 키 이름만 secretRef
    expect(by('dbq').args).toEqual(['server-postgres', 'postgresql://h/db']);
    expect(by('dbq').secretRefs).toEqual([
      { field: 'args', name: 'args[1] query:password', placeholder: '', syntax: 'literal' },
      { field: 'args', name: 'args[1] query:sslmode', placeholder: '', syntax: 'literal' },
    ]);
    // url 경로 마디 토큰은 빈 마디로 · 검토 필요 경고
    expect(by('path').url).toBe('https://mcp.zapier.com/api/mcp/s//mcp');
    expect(by('path').secretRefs).toEqual([{ field: 'url', name: 'path[4]', placeholder: '', syntax: 'literal' }]);
    expect(r.warnings).toContain('Server "path": url path segment 4 looks like a token — removed, review needed');
    expect(by('pat').args).toEqual(['--pat', '', '--githubPat', '', '--cookie', '', '--credential', '', '--session', '']);
    expect(by('pos').args).toEqual(['slack-mcp', '', '', '', '']);
    expect(r.warnings.filter((w) => w.startsWith('Server "pos":') && w.includes('looks like a token — value dropped, review needed'))).toHaveLength(4);
    // 자리표만인 헤더 값 · `--path`(pat 낱말 아님) · 숫자 없는 대문자 env 이름은 남는다
    expect(by('keep').args).toEqual(['-H', 'X-Api-Key: ${env:API_KEY}', '--path', '/home/me/docs', 'GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(by('keep').secretRefs).toEqual([{ field: 'args', name: '-H X-Api-Key', placeholder: 'API_KEY', syntax: 'env' }]);
  });

  it('mcp import: --port=8080 같은 비밀 아닌 플래그 값은 남는다', () => {
    const { server, warnings } = one({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '--port=8080', '--root=/home/me/docs', '--transport=stdio', '--api-key=SECRET1', '--url=https://h.example/x?token=SECRET2'],
    });
    expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '--port=8080', '--root=/home/me/docs', '--transport=stdio', '--api-key=', '--url=https://h.example/x']);
    expect(warnings.some((w) => w.includes('--port') || w.includes('--root') || w.includes('--transport'))).toBe(false);
  });
});
