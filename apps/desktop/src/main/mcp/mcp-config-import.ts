// R3-a — 바깥 앱의 MCP 등록 JSON 을 읽어 하나의 내부 꼴로. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// 근거: cmhcore `.plan/CmhHub/cmh-hub-app/research/04-mcp-skills-sqlite.md` §1 «앱별 등록 JSON».
//   ① 최상위 `mcpServers` — Claude Desktop `claude_desktop_config.json` · 이식용 `.mcp.json` · Cursor `mcp.json`
//      로컬 `{command, args, env}` · 원격 `{url, headers}`
//   ② 최상위 `servers` — VS Code `.vscode/mcp.json` · `{type: 'stdio'|'http', command, args, env, url, headers}` + 최상위 `inputs[]`
// 🔴 비밀값은 내부 꼴에 넣지 않는다 — env · header 는 이름과 자리표만 남기고 값은 버린다(PLAN R3 §6 «비밀값 평문 저장 0»).
//    자리표가 아닌 진짜 값(literal)은 경고를 남기고 사용자가 다시 입력한다(값은 safeStorage 로 — R3-b).
//    검수 차단 4: url 의 userinfo(`user:pass@`) · 쿼리 값 · fragment, args 의 비밀 이름 플래그 다음 값 · `--x=값` 의 값,
//    command 앞 `NAME=값` env 접두의 값도 같은 규칙으로 버리고 secretRefs(field url · args · command) + 경고로 남긴다.
//    오류 · 경고 글에는 원값을 절대 넣지 않는다(이름 · 칸 · typeof 만).
// 검수 차단 5: 서버 키(code)는 `^[a-z0-9][a-z0-9_.-]{0,63}$` — 아니면 그 서버만 건너뛰고 경고. 서버 하나가 틀려도 나머지는 가져온다.
// 칸 이름은 서버 `cmh_ai_mcp_server`(code · name · type · command · args · url · env_keys)와 맞춘다(research/05).
import path from 'node:path';

export type McpServerType = 'stdio' | 'http';
export type McpConfigFormat = 'mcpServers' | 'vscode';
/** plain `${NAME}` · env `${env:NAME}`(Cursor) · input `${input:id}`(VS Code) · literal = 자리표 없는 진짜 값(버림) */
export type SecretSyntax = 'plain' | 'env' | 'input' | 'literal';

export interface SecretRef {
  /** env · header 값 · url(userinfo · 쿼리 값) · args(플래그 값) · command(앞 env 접두) */
  field: 'env' | 'header' | 'url' | 'args' | 'command';
  /**
   * env 이름 · header 이름 · url 은 'userinfo' 또는 `query:<키>` · args 는 플래그(`--api-key`) 또는 `args[<번호>]`
   * · command 는 접두 env 이름
   */
  name: string;
  /** 자리표 안의 이름(`${env:TOKEN}` → `TOKEN` · `${input:api-key}` → `api-key`) · literal 은 '' */
  placeholder: string;
  syntax: SecretSyntax;
}

/** VS Code 미리 정의 변수(`${workspaceFolder}` · `${userHome}` · `${config:x}` …) — 비밀이 아니라 따로 둔다 */
export interface PredefinedVarRef {
  field: SecretRef['field'];
  name: string;
  /** `${…}` 안 글자 그대로(예 'workspaceFolder' · 'config:editor.tabSize') */
  variable: string;
}

export interface ImportedMcpServer {
  /** 등록 JSON 의 키 = 서버 `cmh_ai_mcp_server.code`(String 64 · `^[a-z0-9][a-z0-9_.-]{0,63}$`) */
  code: string;
  /** 등록 JSON 에 따로 이름 칸이 없어서 code 와 같다 · 사람이 나중에 고친다 */
  name: string;
  type: McpServerType;
  command: string | null;
  /** 비밀 값을 버린 자리는 빈 글자('') 또는 `--x=` 로 남는다(자리 번호 유지 · R3-b 가 다시 채운다) */
  args: string[];
  /** userinfo · 쿼리 · fragment 를 뗀 주소 */
  url: string | null;
  /** = `env_keys` · 이름만(command 앞 env 접두 이름도 여기에) */
  envKeys: string[];
  headerKeys: string[];
  secretRefs: SecretRef[];
  predefinedVars: PredefinedVarRef[];
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

/** 서버 `cmh_ai_mcp_server.code` String(64) — 대문자 · `:` · `__proto__` 는 여기서 걸린다 */
export const SERVER_CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** 서버 `cmh_ai_mcp_server.url` String(500) · `command` String(255) · `cmh_ai_mcp_server_secret.env_name` String(64) */
const URL_MAX = 500;
const COMMAND_MAX = 255;
export const ENV_NAME_MAX = 64;

const SERVER_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);
const TOP_KEYS: Record<McpConfigFormat, ReadonlySet<string>> = {
  mcpServers: new Set(['mcpServers']),
  vscode: new Set(['servers', 'inputs']),
};
const PLACEHOLDER = /\$\{([^{}]*)\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INPUT_ID = /^[A-Za-z0-9_.-]+$/;
/** RFC 7230 token */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** 이 글자가 이름에 들어간 플래그의 다음 값은 비밀로 본다 */
const SECRET_FLAG = /key|token|secret|password|passwd|auth|bearer/i;
/** `--x=값` · `-x=값` */
const FLAG_WITH_VALUE = /^(--?[^=\s]+)=([\s\S]*)$/;
/** 주소처럼 생긴 args 의 userinfo */
const URL_LIKE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/;
/** command 앞 `NAME=값 ` 접두(값은 따옴표 가능) */
const ENV_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)\s+/;

/**
 * VS Code 미리 정의 변수(https://code.visualstudio.com/docs/reference/variables-reference).
 * `${env:…}` · `${input:…}` 는 비밀 자리표 쪽이고 `${config:…}` · `${command:…}` · `${workspaceFolder:…}` 는 이름 붙은 미리 정의 변수다.
 */
export const VSCODE_PREDEFINED_VARS: ReadonlySet<string> = new Set([
  'userHome',
  'workspaceFolder',
  'workspaceFolderBasename',
  'file',
  'fileWorkspaceFolder',
  'relativeFile',
  'relativeFileDirname',
  'fileBasename',
  'fileBasenameNoExtension',
  'fileExtname',
  'fileDirname',
  'fileDirnameBasename',
  'cwd',
  'lineNumber',
  'columnNumber',
  'selectedText',
  'execPath',
  'pathSeparator',
  '/',
  'defaultBuildTask',
  'extensionInstallFolder',
]);
const PREDEFINED_PREFIXES = ['config:', 'command:', 'workspaceFolder:', 'workspaceFolderBasename:', 'extensionInstallFolder:'];

const invalid = (message: string): McpConfigImportError => new McpConfigImportError(MCP_IMPORT_SNIPPET.invalid, message);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** 키 · 이름을 로그에 쓸 때 — 인쇄 가능한 ASCII 말고는 '?' · 64자까지(값에는 쓰지 않는다) */
function safeLabel(text: string): string {
  const cut = text.length > 64 ? `${text.slice(0, 64)}…` : text;
  return cut.replace(/[^\x20-\x7e…]/g, '?');
}

/** JSON 글 → 내부 꼴. 깨진 JSON · 맨 위 꼴이 틀린 것은 McpConfigImportError · 서버 하나의 문제는 그 서버만 건너뛰고 경고 */
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
  const hasMcpServers = own(root, 'mcpServers');
  const hasServers = own(root, 'servers');
  if (hasMcpServers && hasServers) throw invalid('MCP config has both "mcpServers" and "servers"');
  if (!hasMcpServers && !hasServers) throw invalid('MCP config has neither "mcpServers" nor "servers"');
  const format: McpConfigFormat = hasServers ? 'vscode' : 'mcpServers';

  const warnings: string[] = [];
  for (const key of Object.keys(root)) {
    if (!TOP_KEYS[format].has(key)) warnings.push(`Unknown top-level key "${safeLabel(key)}" ignored`);
  }

  const inputs = format === 'vscode' ? readInputs(root['inputs']) : [];
  const mapKey = format === 'vscode' ? 'servers' : 'mcpServers';
  const serverMap = root[mapKey];
  if (!isPlainObject(serverMap)) throw invalid(`"${mapKey}" must be an object`);

  const servers: ImportedMcpServer[] = [];
  Object.entries(serverMap).forEach(([code, entry], idx) => {
    if (!SERVER_CODE.test(code)) {
      warnings.push(`Server #${idx + 1} key "${safeLabel(code)}" is not a valid code (${SERVER_CODE.source}) — skipped`);
      return;
    }
    // 서버 하나의 경고는 성공했을 때만 붙인다 — 건너뛴 서버는 이유 한 줄
    const local: string[] = [];
    try {
      servers.push(readServer(code, entry, format, local));
      warnings.push(...local);
    } catch (e) {
      if (!(e instanceof McpConfigImportError)) throw e;
      warnings.push(`${e.message} — server skipped`);
    }
  });

  const inputIds = new Set(inputs.map((i) => i.id));
  for (const s of servers) {
    for (const ref of s.secretRefs) {
      if (ref.syntax === 'input' && !inputIds.has(ref.placeholder)) {
        warnings.push(`Server "${s.code}": ${ref.field} "${safeLabel(ref.name)}" refers to unknown input "${ref.placeholder}"`);
      }
    }
  }
  return { format, servers, inputs, warnings };
}

function readInputs(raw: unknown): ImportedMcpInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid('"inputs" must be an array');
  const seen = new Set<string>();
  return raw.map((item: unknown, idx) => {
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

/** 한 서버를 읽는 동안 쌓는 것 */
interface ServerCollector {
  readonly code: string;
  readonly warnings: string[];
  readonly secretRefs: SecretRef[];
  readonly predefinedVars: PredefinedVarRef[];
}

function readServer(code: string, entry: unknown, format: McpConfigFormat, warnings: string[]): ImportedMcpServer {
  if (!isPlainObject(entry)) throw invalid(`Server "${code}" must be an object (got ${Array.isArray(entry) ? 'array' : typeof entry})`);
  for (const key of Object.keys(entry)) {
    if (!SERVER_KEYS.has(key)) warnings.push(`Server "${code}": unknown key "${safeLabel(key)}" ignored`);
  }
  const c: ServerCollector = { code, warnings, secretRefs: [], predefinedVars: [] };

  const type = resolveType(code, entry, format, warnings);
  const rawCommand = entry['command'];
  const rawUrl = entry['url'];
  if (rawCommand !== undefined && typeof rawCommand !== 'string') throw invalid(`Server "${code}": "command" must be a string (got ${typeof rawCommand})`);
  if (rawUrl !== undefined && typeof rawUrl !== 'string') throw invalid(`Server "${code}": "url" must be a string (got ${typeof rawUrl})`);

  const envKeys: string[] = [];
  let command: string | null = null;
  let url: string | null = null;
  if (type === 'stdio') {
    if (rawUrl !== undefined) warnings.push(`Server "${code}": "url" ignored for stdio server`);
    const cmd = stripEnvPrefix(c, (rawCommand ?? '').trim(), envKeys);
    if (cmd === '') warnings.push(`Server "${code}": empty "command"`);
    else if (cmd.length > COMMAND_MAX) throw invalid(`Server "${code}": "command" longer than ${COMMAND_MAX}`);
    else command = cmd;
    if (command !== null) recordPlaceholders(c, 'command', 'command', command);
  } else {
    if (rawCommand !== undefined) warnings.push(`Server "${code}": "command" ignored for http server`);
    const u = (rawUrl ?? '').trim();
    if (u === '') warnings.push(`Server "${code}": empty "url"`);
    else url = sanitizeServerUrl(c, u);
  }

  const rawArgs = entry['args'];
  let args: string[] = [];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) throw invalid(`Server "${code}": "args" must be an array of strings`);
    if (type === 'stdio') args = sanitizeArgs(c, rawArgs as string[]);
    else if (rawArgs.length > 0) warnings.push(`Server "${code}": "args" ignored for http server`);
  }

  for (const name of readStringMap(c, 'env', entry['env'], 'env')) if (!envKeys.includes(name)) envKeys.push(name);
  const headerKeys = readStringMap(c, 'headers', entry['headers'], 'header');
  if (type === 'stdio' && headerKeys.length > 0) warnings.push(`Server "${code}": "headers" on a stdio server`);

  return { code, name: code, type, command, args, url, envKeys, headerKeys, secretRefs: c.secretRefs, predefinedVars: c.predefinedVars };
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
  // Streamable HTTP 의 다른 표기(Claude Code · Cursor 등) — 같은 것이다
  if (raw === 'streamable-http' || raw === 'streamableHttp') return 'http';
  // 옛 HTTP+SSE 는 Deprecated — 연결은 Streamable HTTP 먼저 · 실패하면 SSE 로 되돌아간다(research/04 §1)
  if (raw === 'sse') {
    warnings.push(`Server "${code}": type "sse" imported as "http" (SSE is deprecated)`);
    return 'http';
  }
  // 원값은 찍지 않는다(비밀이 잘못 들어 있을 수 있다) — typeof 만
  throw invalid(`Server "${code}": unsupported "type" value (${typeof raw})`);
}

/** 값 안 자리표를 secretRefs · predefinedVars 로. 값이 자리표만으로 되어 있지 않으면 'text' · 자리표가 없으면 'none' */
type PlaceholderScan = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; secrets: Array<{ placeholder: string; syntax: Exclude<SecretSyntax, 'literal'> }>; predefined: string[]; outside: string };

function scanPlaceholders(value: string): PlaceholderScan {
  const secrets: Array<{ placeholder: string; syntax: Exclude<SecretSyntax, 'literal'> }> = [];
  const predefined: string[] = [];
  let found = false;
  for (const m of value.matchAll(PLACEHOLDER)) {
    found = true;
    const inner = (m[1] ?? '').trim();
    if (VSCODE_PREDEFINED_VARS.has(inner) || PREDEFINED_PREFIXES.some((p) => inner.startsWith(p) && inner.length > p.length)) {
      predefined.push(inner);
    } else if (inner.startsWith('input:')) {
      const id = inner.slice('input:'.length).trim();
      if (!INPUT_ID.test(id)) return { kind: 'invalid' };
      secrets.push({ placeholder: id, syntax: 'input' });
    } else if (inner.startsWith('env:')) {
      const id = inner.slice('env:'.length).trim();
      if (!ENV_NAME.test(id)) return { kind: 'invalid' };
      secrets.push({ placeholder: id, syntax: 'env' });
    } else {
      if (!ENV_NAME.test(inner)) return { kind: 'invalid' };
      secrets.push({ placeholder: inner, syntax: 'plain' });
    }
  }
  if (!found) return { kind: 'none' };
  return { kind: 'ok', secrets, predefined, outside: value.replace(PLACEHOLDER, '').trim() };
}

/** 값 안 자리표 목록 · 자리표가 하나도 없거나 이름이 틀리면 [] (= literal 로 다룬다) · 미리 정의 변수는 빠진다 */
export function classifyValue(value: string): Array<{ placeholder: string; syntax: Exclude<SecretSyntax, 'literal'> }> {
  const scan = scanPlaceholders(value);
  return scan.kind === 'ok' ? scan.secrets : [];
}

/**
 * 비밀일 수 있는 값 하나를 다룬다. 자리표만이면(앞뒤 글자 없음) 'keep'(자리표 기록 · 값 유지 가능) ·
 * 자리표 + 글자면 'drop'(자리표 기록 + «글자 버림» 경고) · 자리표 없음/틀림이면 'drop'(literal 기록 + 경고).
 */
function classifySecretValue(c: ServerCollector, field: SecretRef['field'], name: string, value: string): 'keep' | 'drop' {
  const scan = scanPlaceholders(value);
  if (scan.kind !== 'ok' || (scan.secrets.length === 0 && scan.predefined.length === 0)) {
    c.secretRefs.push({ field, name, placeholder: '', syntax: 'literal' });
    c.warnings.push(`Server "${c.code}": ${field} "${safeLabel(name)}" has a literal value — value dropped, re-enter it`);
    return 'drop';
  }
  for (const r of scan.secrets) c.secretRefs.push({ field, name, placeholder: r.placeholder, syntax: r.syntax });
  for (const v of scan.predefined) c.predefinedVars.push({ field, name, variable: v });
  if (scan.outside !== '') {
    // `Bearer ${TOKEN}` 의 `Bearer ` 처럼 자리표 밖 글자도 비밀일 수 있어 버린다 — 연결 때 다시 짓는다(R3-b)
    c.warnings.push(`Server "${c.code}": ${field} "${safeLabel(name)}" has text around its placeholder — only the placeholder is kept`);
    return 'drop';
  }
  return 'keep';
}

/** 비밀이 아닌 칸(args 위치 값 · command)의 자리표만 기록 — 값은 그대로 둔다 */
function recordPlaceholders(c: ServerCollector, field: SecretRef['field'], name: string, value: string): void {
  const scan = scanPlaceholders(value);
  if (scan.kind === 'invalid') {
    c.warnings.push(`Server "${c.code}": ${field} "${safeLabel(name)}" has a placeholder with an invalid name — left as text`);
    return;
  }
  if (scan.kind !== 'ok') return;
  for (const r of scan.secrets) c.secretRefs.push({ field, name, placeholder: r.placeholder, syntax: r.syntax });
  for (const v of scan.predefined) c.predefinedVars.push({ field, name, variable: v });
}

/** command 앞 `NAME=값 ` 접두(그리고 `env NAME=값 cmd`)를 떼고 이름은 envKeys 로 · 값은 버린다 */
function stripEnvPrefix(c: ServerCollector, command: string, envKeys: string[]): string {
  let rest = command;
  if (/^env\s+[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) rest = rest.replace(/^env\s+/, '');
  for (let m = ENV_PREFIX.exec(rest); m !== null; m = ENV_PREFIX.exec(rest)) {
    const name = m[1] as string;
    let value = m[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (name.length > ENV_NAME_MAX) {
      c.warnings.push(`Server "${c.code}": command env prefix name longer than ${ENV_NAME_MAX} — dropped`);
    } else {
      classifySecretValue(c, 'command', name, value);
      if (!envKeys.includes(name)) envKeys.push(name);
      c.warnings.push(`Server "${c.code}": command had an env prefix "${name}=…" — moved to env, value dropped`);
    }
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/**
 * 원격 주소 정리 — scheme 은 http: · https: 만(아니면 그 서버 건너뜀). userinfo · 쿼리 값 · fragment 는 떼어 버리고
 * secretRefs(field url) + 경고. 쿼리 키 이름은 secretRef 이름(`query:<키>`)으로 남는다.
 */
function sanitizeServerUrl(c: ServerCollector, raw: string): string {
  const m = URL_LIKE.exec(raw);
  if (!m) throw invalid(`Server "${c.code}": "url" is not an absolute URL`);
  const scheme = (m[1] as string).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw invalid(`Server "${c.code}": "url" scheme must be http or https`);
  let authority = m[2] ?? '';
  let rest = m[3] ?? '';

  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    classifySecretValue(c, 'url', 'userinfo', authority.slice(0, at));
    c.warnings.push(`Server "${c.code}": url userinfo removed`);
    authority = authority.slice(at + 1);
  }
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    c.warnings.push(`Server "${c.code}": url fragment removed`);
    rest = rest.slice(0, hash);
  }
  const q = rest.indexOf('?');
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      const value = eq >= 0 ? pair.slice(eq + 1) : '';
      if (value === '') continue;
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        /* 깨진 %-인코딩 — 원래 글자로 판정 */
      }
      classifySecretValue(c, 'url', `query:${safeLabel(key)}`, decoded);
    }
    c.warnings.push(`Server "${c.code}": url query values removed (keys kept in secretRefs)`);
    rest = rest.slice(0, q);
  }
  const cleaned = `${scheme}://${authority}${rest}`;
  if (cleaned.length > URL_MAX) throw invalid(`Server "${c.code}": "url" longer than ${URL_MAX}`);
  if (/\$\{[^{}]*\}/.test(cleaned)) {
    recordPlaceholders(c, 'url', 'url', cleaned);
    c.warnings.push(`Server "${c.code}": "url" contains a placeholder — not resolved on import`);
  } else {
    try {
      new URL(cleaned);
    } catch {
      throw invalid(`Server "${c.code}": "url" is not a valid URL`);
    }
  }
  return cleaned;
}

/** args 정리 — 비밀 이름 플래그 다음 값 · `--x=값` 의 값 · 주소 userinfo 는 버리고 자리표는 기록 */
function sanitizeArgs(c: ServerCollector, raw: readonly string[]): string[] {
  const out = [...raw];
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i] as string;
    const withValue = FLAG_WITH_VALUE.exec(arg);
    if (withValue) {
      const flag = withValue[1] as string;
      const value = withValue[2] ?? '';
      if (value !== '' && classifySecretValue(c, 'args', flag, value) === 'drop') out[i] = `${flag}=`;
      continue;
    }
    if (/^--?[^-\s]/.test(arg) && SECRET_FLAG.test(arg)) {
      const next = out[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (classifySecretValue(c, 'args', arg, next) === 'drop') out[i + 1] = '';
        i += 1;
      }
      continue;
    }
    const url = URL_LIKE.exec(arg);
    if (url && (url[2] ?? '').includes('@')) {
      const authority = url[2] as string;
      const at = authority.lastIndexOf('@');
      classifySecretValue(c, 'args', `args[${i}]`, authority.slice(0, at));
      c.warnings.push(`Server "${c.code}": args[${i}] url userinfo removed`);
      out[i] = `${url[1]}://${authority.slice(at + 1)}${url[3] ?? ''}`;
    }
    recordPlaceholders(c, 'args', `args[${i}]`, out[i] as string);
  }
  return out;
}

/** env · headers 맵 → 이름 목록. 값은 자리표만 secretRefs 에 남기고 버린다 · 틀린 이름은 그 항목만 버리고 경고 */
function readStringMap(c: ServerCollector, key: 'env' | 'headers', raw: unknown, field: 'env' | 'header'): string[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw invalid(`Server "${c.code}": "${key}" must be an object`);
  const names: string[] = [];
  Object.entries(raw).forEach(([name, value], idx) => {
    if (typeof value !== 'string') {
      c.warnings.push(`Server "${c.code}": ${key} #${idx + 1} value must be a string (got ${typeof value}) — dropped`);
      return;
    }
    if (field === 'env' && name.length > ENV_NAME_MAX) {
      c.warnings.push(`Server "${c.code}": env #${idx + 1} name longer than ${ENV_NAME_MAX} — dropped`);
      return;
    }
    if (field === 'env' && !ENV_NAME.test(name)) {
      c.warnings.push(`Server "${c.code}": env #${idx + 1} name is not a valid env name — dropped`);
      return;
    }
    if (field === 'header' && !HEADER_NAME.test(name)) {
      c.warnings.push(`Server "${c.code}": header #${idx + 1} name is not a valid header name — dropped`);
      return;
    }
    names.push(name);
    classifySecretValue(c, field, name, value);
  });
  return names;
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
