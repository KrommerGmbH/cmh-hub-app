// R3-a — 바깥 앱의 MCP 등록 JSON 을 읽어 하나의 내부 꼴로. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/research/04-mcp-skills-sqlite.md` §1 «앱별 등록 JSON».
//   ① 최상위 `mcpServers` — Claude Desktop `claude_desktop_config.json` · 이식용 `.mcp.json` · Cursor `mcp.json`
//      로컬 `{command, args, env}` · 원격 `{url, headers}`
//   ② 최상위 `servers` — VS Code `.vscode/mcp.json` · `{type: 'stdio'|'http', command, args, env, url, headers}` + 최상위 `inputs[]`
// 🔴 비밀값은 내부 꼴에 넣지 않는다 — env · header 는 이름과 자리표만 남기고 값은 버린다(PLAN R3 §6 «비밀값 평문 저장 0»).
//    자리표가 아닌 진짜 값(literal)은 경고를 남기고 사용자가 다시 입력한다(값은 safeStorage 로 — R3-b).
// 칸 이름은 서버 `cmh_ai_mcp_server`(code · name · type · command · args · url · env_keys)와 맞춘다(research/05).
import path from 'node:path';

export type McpServerType = 'stdio' | 'http';
export type McpConfigFormat = 'mcpServers' | 'vscode';
/** plain `${NAME}` · env `${env:NAME}`(Cursor) · input `${input:id}`(VS Code) · literal = 자리표 없는 진짜 값(버림) */
export type SecretSyntax = 'plain' | 'env' | 'input' | 'literal';

export interface SecretRef {
  field: 'env' | 'header';
  /** env 이름 · header 이름 */
  name: string;
  /** 자리표 안의 이름(`${env:TOKEN}` → `TOKEN` · `${input:api-key}` → `api-key`) · literal 은 '' */
  placeholder: string;
  syntax: SecretSyntax;
}

export interface ImportedMcpServer {
  /** 등록 JSON 의 키 = 서버 `cmh_ai_mcp_server.code`(String 64) */
  code: string;
  /** 등록 JSON 에 따로 이름 칸이 없어서 code 와 같다 · 사람이 나중에 고친다 */
  name: string;
  type: McpServerType;
  command: string | null;
  args: string[];
  url: string | null;
  /** = `env_keys` · 이름만 */
  envKeys: string[];
  headerKeys: string[];
  secretRefs: SecretRef[];
}

/** VS Code `inputs[]` 한 줄 — `default` 값은 비밀일 수 있어 버린다 */
export interface ImportedMcpInput {
  id: string;
  type: string;
  description: string | null;
  password: boolean;
}

export interface McpConfigImport {
  format: McpConfigFormat;
  servers: ImportedMcpServer[];
  inputs: ImportedMcpInput[];
  /** 로그용 영문 — 화면은 servers[].secretRefs(syntax 'literal') 와 이 목록의 스니펫 키 없는 내용을 따로 그린다 */
  warnings: string[];
}

/** 화면에 보일 글은 snippetKey 로(R8 스니펫) · message 는 로그용 영문 */
export class McpConfigImportError extends Error {
  readonly snippetKey: string;
  constructor(snippetKey: string, message: string) {
    super(message);
    this.name = 'McpConfigImportError';
    this.snippetKey = snippetKey;
  }
}

export const MCP_IMPORT_SNIPPET = {
  invalidJson: 'cmh-hub-app.mcp.importInvalidJson',
  invalid: 'cmh-hub-app.mcp.importInvalid',
} as const;

/** 서버 `cmh_ai_mcp_server.code` String(64) */
const CODE_MAX = 64;
/** 서버 `cmh_ai_mcp_server.url` String(500) · `command` String(255) */
const URL_MAX = 500;
const COMMAND_MAX = 255;

const SERVER_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);
const TOP_KEYS: Record<McpConfigFormat, ReadonlySet<string>> = {
  mcpServers: new Set(['mcpServers']),
  vscode: new Set(['servers', 'inputs']),
};
const PLACEHOLDER = /\$\{(?:(env|input):)?([^{}]*)\}/g;
const HAS_PLACEHOLDER = /\$\{[^{}]*\}/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INPUT_ID = /^[A-Za-z0-9_.-]+$/;

const invalid = (message: string): McpConfigImportError => new McpConfigImportError(MCP_IMPORT_SNIPPET.invalid, message);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON 글 → 내부 꼴. 깨진 JSON · 꼴이 틀린 것은 McpConfigImportError */
export function parseMcpConfig(text: string): McpConfigImport {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let root: unknown;
  try {
    root = JSON.parse(src);
  } catch {
    // JSON.parse 의 메시지는 원문 일부를 담는다(Node 20+) — 비밀값이 로그로 새지 않게 버린다
    throw new McpConfigImportError(MCP_IMPORT_SNIPPET.invalidJson, 'MCP config is not valid JSON');
  }
  if (!isPlainObject(root)) throw invalid('MCP config root must be an object');
  const hasMcpServers = Object.prototype.hasOwnProperty.call(root, 'mcpServers');
  const hasServers = Object.prototype.hasOwnProperty.call(root, 'servers');
  if (hasMcpServers && hasServers) throw invalid('MCP config has both "mcpServers" and "servers"');
  if (!hasMcpServers && !hasServers) throw invalid('MCP config has neither "mcpServers" nor "servers"');
  const format: McpConfigFormat = hasServers ? 'vscode' : 'mcpServers';

  const warnings: string[] = [];
  for (const key of Object.keys(root)) {
    if (!TOP_KEYS[format].has(key)) warnings.push(`Unknown top-level key "${key}" ignored`);
  }

  const inputs = format === 'vscode' ? readInputs(root['inputs']) : [];
  const serverMap = root[format === 'vscode' ? 'servers' : 'mcpServers'];
  if (!isPlainObject(serverMap)) throw invalid(`"${format === 'vscode' ? 'servers' : 'mcpServers'}" must be an object`);

  const servers = Object.entries(serverMap).map(([code, entry]) => readServer(code, entry, format, warnings));
  const inputIds = new Set(inputs.map((i) => i.id));
  for (const s of servers) {
    for (const ref of s.secretRefs) {
      if (ref.syntax === 'input' && !inputIds.has(ref.placeholder)) {
        warnings.push(`Server "${s.code}": ${ref.field} "${ref.name}" refers to unknown input "${ref.placeholder}"`);
      }
    }
  }
  return { format, servers, inputs, warnings };
}

function readInputs(raw: unknown): ImportedMcpInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid('"inputs" must be an array');
  const seen = new Set<string>();
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) throw invalid(`inputs[${idx}] must be an object`);
    const id = item['id'];
    if (typeof id !== 'string' || !INPUT_ID.test(id)) throw invalid(`inputs[${idx}].id must match ${INPUT_ID.source}`);
    if (seen.has(id)) throw invalid(`Duplicate input id "${id}"`);
    seen.add(id);
    const type = item['type'];
    const description = item['description'];
    return {
      id,
      type: typeof type === 'string' ? type : '',
      description: typeof description === 'string' ? description : null,
      password: item['password'] === true,
    };
  });
}

function readServer(code: string, entry: unknown, format: McpConfigFormat, warnings: string[]): ImportedMcpServer {
  if (code.trim() === '' || code.length > CODE_MAX) throw invalid(`Server key must be 1-${CODE_MAX} characters: "${code}"`);
  if (!isPlainObject(entry)) throw invalid(`Server "${code}" must be an object`);
  for (const key of Object.keys(entry)) {
    if (!SERVER_KEYS.has(key)) warnings.push(`Server "${code}": unknown key "${key}" ignored`);
  }

  const type = resolveType(code, entry, format, warnings);
  const rawCommand = entry['command'];
  const rawUrl = entry['url'];
  if (rawCommand !== undefined && typeof rawCommand !== 'string') throw invalid(`Server "${code}": "command" must be a string`);
  if (rawUrl !== undefined && typeof rawUrl !== 'string') throw invalid(`Server "${code}": "url" must be a string`);

  let command: string | null = null;
  let url: string | null = null;
  if (type === 'stdio') {
    if (rawUrl !== undefined) warnings.push(`Server "${code}": "url" ignored for stdio server`);
    const c = (rawCommand ?? '').trim();
    if (c === '') warnings.push(`Server "${code}": empty "command"`);
    else if (c.length > COMMAND_MAX) throw invalid(`Server "${code}": "command" longer than ${COMMAND_MAX}`);
    else command = c;
  } else {
    if (rawCommand !== undefined) warnings.push(`Server "${code}": "command" ignored for http server`);
    const u = (rawUrl ?? '').trim();
    if (u === '') warnings.push(`Server "${code}": empty "url"`);
    else if (u.length > URL_MAX) throw invalid(`Server "${code}": "url" longer than ${URL_MAX}`);
    else url = u;
    if (HAS_PLACEHOLDER.test(u)) warnings.push(`Server "${code}": "url" contains a placeholder — not resolved on import`);
  }

  const rawArgs = entry['args'];
  let args: string[] = [];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) throw invalid(`Server "${code}": "args" must be an array of strings`);
    if (type === 'stdio') args = [...(rawArgs as string[])];
    else if (rawArgs.length > 0) warnings.push(`Server "${code}": "args" ignored for http server`);
  }

  const secretRefs: SecretRef[] = [];
  const envKeys = readStringMap(code, 'env', entry['env'], 'env', secretRefs, warnings);
  const headerKeys = readStringMap(code, 'headers', entry['headers'], 'header', secretRefs, warnings);
  if (type === 'stdio' && headerKeys.length > 0) warnings.push(`Server "${code}": "headers" on a stdio server`);

  return { code, name: code, type, command, args, url, envKeys, headerKeys, secretRefs };
}

function resolveType(code: string, entry: Record<string, unknown>, format: McpConfigFormat, warnings: string[]): McpServerType {
  const raw = entry['type'];
  const hasCommand = entry['command'] !== undefined;
  const hasUrl = entry['url'] !== undefined;
  if (raw === undefined) {
    if (hasCommand && hasUrl) throw invalid(`Server "${code}" has both "command" and "url"`);
    if (!hasCommand && !hasUrl) throw invalid(`Server "${code}" has neither "command" nor "url"`);
    if (format === 'vscode') warnings.push(`Server "${code}": missing "type" — inferred from ${hasCommand ? '"command"' : '"url"'}`);
    return hasCommand ? 'stdio' : 'http';
  }
  if (raw === 'stdio' || raw === 'http') return raw;
  // 옛 HTTP+SSE 는 Deprecated — 연결은 Streamable HTTP 먼저 · 실패하면 SSE 로 되돌아간다(research/04 §1)
  if (raw === 'sse') {
    warnings.push(`Server "${code}": type "sse" imported as "http" (SSE is deprecated)`);
    return 'http';
  }
  throw invalid(`Server "${code}": unsupported type ${JSON.stringify(raw)}`);
}

/** env · headers 맵 → 이름 목록. 값은 자리표만 secretRefs 에 남기고 버린다 */
function readStringMap(
  code: string,
  key: 'env' | 'headers',
  raw: unknown,
  field: SecretRef['field'],
  secretRefs: SecretRef[],
  warnings: string[],
): string[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw invalid(`Server "${code}": "${key}" must be an object`);
  const names: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw invalid(`Server "${code}": ${key}.${name} must be a string`);
    if (field === 'env' && !ENV_NAME.test(name)) throw invalid(`Server "${code}": invalid env name "${name}"`);
    names.push(name);
    const refs = classifyValue(value);
    if (refs.length === 0) {
      secretRefs.push({ field, name, placeholder: '', syntax: 'literal' });
      warnings.push(`Server "${code}": ${field} "${name}" has a literal value — value dropped, re-enter it`);
      continue;
    }
    for (const r of refs) secretRefs.push({ field, name, placeholder: r.placeholder, syntax: r.syntax });
    // `Bearer ${TOKEN}` 의 `Bearer ` 처럼 자리표 밖 글자도 비밀일 수 있어 버린다 — 연결 때 다시 짓는다(R3-b)
    if (value.replace(PLACEHOLDER, '').trim() !== '') {
      warnings.push(`Server "${code}": ${field} "${name}" has text around its placeholder — only the placeholder is kept`);
    }
  }
  return names;
}

/** 값 안의 자리표 목록 · 자리표가 하나도 없거나 이름이 틀리면 [] (= literal 로 다룬다) */
export function classifyValue(value: string): Array<{ placeholder: string; syntax: Exclude<SecretSyntax, 'literal'> }> {
  const out: Array<{ placeholder: string; syntax: Exclude<SecretSyntax, 'literal'> }> = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    const prefix = m[1];
    const id = (m[2] ?? '').trim();
    if (prefix === 'input') {
      if (!INPUT_ID.test(id)) return [];
      out.push({ placeholder: id, syntax: 'input' });
    } else {
      if (!ENV_NAME.test(id)) return [];
      out.push({ placeholder: id, syntax: prefix === 'env' ? 'env' : 'plain' });
    }
  }
  return out;
}

export type McpConfigApp = 'claude-desktop' | 'cursor' | 'vscode' | 'portable';

export interface KnownConfigPath {
  app: McpConfigApp;
  /** global = 절대 경로 · workspace = 작업 폴더 기준 상대 경로(부르는 쪽이 붙인다) */
  scope: 'global' | 'workspace';
  path: string;
  format: McpConfigFormat;
}

/**
 * 가져오기 후보 경로(있는지는 안 본다). appDataDir = Electron `app.getPath('appData')`
 * (macOS `~/Library/Application Support` · Windows `%APPDATA%` · Linux `~/.config`).
 * 근거 research/04 §1: Claude Desktop macOS · Windows(MCP 문서) · Linux(VS Code 문서에만) · Cursor 전역 `~/.cursor/mcp.json`
 * · 작업 폴더 `.mcp.json`(이식용) · `.cursor/mcp.json` · `.vscode/mcp.json`.
 */
export function knownConfigPaths(platform: NodeJS.Platform, homeDir: string, appDataDir: string): KnownConfigPath[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const out: KnownConfigPath[] = [];
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    out.push({ app: 'claude-desktop', scope: 'global', path: p.join(appDataDir, 'Claude', 'claude_desktop_config.json'), format: 'mcpServers' });
  }
  out.push(
    { app: 'cursor', scope: 'global', path: p.join(homeDir, '.cursor', 'mcp.json'), format: 'mcpServers' },
    { app: 'portable', scope: 'workspace', path: '.mcp.json', format: 'mcpServers' },
    { app: 'cursor', scope: 'workspace', path: p.join('.cursor', 'mcp.json'), format: 'mcpServers' },
    { app: 'vscode', scope: 'workspace', path: p.join('.vscode', 'mcp.json'), format: 'vscode' },
  );
  return out;
}
