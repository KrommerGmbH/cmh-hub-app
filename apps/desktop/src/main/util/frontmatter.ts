// R3-a — `---` 로 감싼 YAML 프런트매터 + 본문. 새 의존 0 이라 YAML 은 쓰는 만큼만 읽는다(SKILL.md · .prompt.md 공용).
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
//
// 읽는 꼴(이 밖은 전부 FrontmatterError — 조용히 다르게 읽는 것보다 거부가 낫다):
//   key: 글자              · key: "따옴표 \n 이스케이프" · key: '홑따옴표 '' 두 번'
//   key:                   · key:
//     - 목록 한 줄            ·   sub: 문자열→문자열 맵 한 단계
// 숫자 · true 도 글자 그대로(문자열)다. `[a, b]` · `{a: b}` · `|` · `>` · `&` · `*` · `!` 는 예외.

export type FrontmatterValue = string | readonly string[] | Readonly<Record<string, string>>;

export interface Frontmatter {
  /** 프로토타입 없는 객체 — 키가 `__proto__` 여도 안전 */
  data: Readonly<Record<string, FrontmatterValue>>;
  /** 닫는 `---` 다음 줄부터 · 줄바꿈은 LF 로 맞춘 것 */
  body: string;
}

export class FrontmatterError extends Error {
  /** 파일 기준 1부터 · 모르면 null */
  readonly line: number | null;
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `${message} (line ${line})`);
    this.name = 'FrontmatterError';
    this.line = line;
  }
}

const TOP_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/;
const MAP_ENTRY = /^([ ]+)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ ]+(.*))?$/;
const LIST_ITEM = /^([ ]*)-(?:[ ]+(.*))?$/;
/** 꾸밈 없는 글자의 첫 글자로 오면 YAML 이 다른 뜻으로 읽는 것 */
const PLAIN_FORBIDDEN_START = new Set(['[', '{', '|', '>', '&', '*', '!', '%', '@', '`']);

/** BOM 을 떼고 CRLF · CR 을 LF 로 */
export function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

/** 첫 줄이 `---` 가 아니면 null(프런트매터 없음) · 닫는 `---` 가 없으면 예외 */
export function splitFrontmatter(text: string): { header: string; body: string } | null {
  const lines = normalizeText(text).split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) throw new FrontmatterError('Frontmatter is not closed with ---', 1);
  return { header: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/** 프런트매터가 꼭 있어야 하는 파일용 — 없으면 예외 */
export function parseFrontmatter(text: string): Frontmatter {
  const split = splitFrontmatter(text);
  if (!split) throw new FrontmatterError('File does not start with a --- frontmatter block', 1);
  return { data: parseYamlSubset(split.header, 2), body: split.body };
}

const isSkippable = (line: string): boolean => line.trim() === '' || /^[ ]*#/.test(line);

/** firstLineNo = header 첫 줄의 파일 줄 번호(오류 위치용) */
export function parseYamlSubset(header: string, firstLineNo = 1): Readonly<Record<string, FrontmatterValue>> {
  const data: Record<string, FrontmatterValue> = Object.create(null) as Record<string, FrontmatterValue>;
  const lines = header.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const lineNo = firstLineNo + i;
    if (isSkippable(raw)) { i += 1; continue; }
    if (/^[ ]*\t/.test(raw)) throw new FrontmatterError('Tab indentation is not allowed', lineNo);
    if (/^\s/.test(raw)) throw new FrontmatterError('Unexpected indentation', lineNo);
    const m = TOP_KEY.exec(raw.trimEnd());
    if (!m) throw new FrontmatterError('Expected "key: value"', lineNo);
    const key = m[1] as string;
    if (Object.prototype.hasOwnProperty.call(data, key)) throw new FrontmatterError(`Duplicate key "${key}"`, lineNo);
    const rest = m[2] ?? '';
    if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
      data[key] = parseScalar(rest, lineNo);
      i += 1;
      continue;
    }
    // 값이 비었으면 다음 줄들(들여쓴 줄 · 첫 칸 `- `)이 목록이나 맵이다
    const children: Array<{ text: string; lineNo: number }> = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] ?? '';
      if (isSkippable(l)) { j += 1; continue; }
      if (/^[ ]+\S/.test(l) || LIST_ITEM.test(l)) { children.push({ text: l.trimEnd(), lineNo: firstLineNo + j }); j += 1; continue; }
      if (/^\t/.test(l)) throw new FrontmatterError('Tab indentation is not allowed', firstLineNo + j);
      break;
    }
    data[key] = children.length === 0 ? '' : parseBlock(children);
    i = j;
  }
  return data;
}

function parseBlock(children: ReadonlyArray<{ text: string; lineNo: number }>): FrontmatterValue {
  const first = children[0] as { text: string; lineNo: number };
  if (LIST_ITEM.test(first.text)) {
    const indent = (LIST_ITEM.exec(first.text)?.[1] ?? '').length;
    return children.map(({ text, lineNo }) => {
      const m = LIST_ITEM.exec(text);
      if (!m) throw new FrontmatterError('Mixed list and map entries', lineNo);
      if ((m[1] ?? '').length !== indent) throw new FrontmatterError('Inconsistent list indentation', lineNo);
      const item = m[2] ?? '';
      if (item.trim() === '' || item.trim().startsWith('#')) throw new FrontmatterError('Empty list item', lineNo);
      return parseScalar(item, lineNo);
    });
  }
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  const indent = (MAP_ENTRY.exec(first.text)?.[1] ?? '').length;
  for (const { text, lineNo } of children) {
    const m = MAP_ENTRY.exec(text);
    if (!m) throw new FrontmatterError('Expected "  key: value" (only one nesting level is supported)', lineNo);
    if ((m[1] ?? '').length !== indent) throw new FrontmatterError('Inconsistent map indentation', lineNo);
    const key = m[2] as string;
    if (Object.prototype.hasOwnProperty.call(map, key)) throw new FrontmatterError(`Duplicate key "${key}"`, lineNo);
    const value = m[3] ?? '';
    if (value.trim() === '' || value.trim().startsWith('#')) throw new FrontmatterError('Nested values must be strings', lineNo);
    map[key] = parseScalar(value, lineNo);
  }
  return map;
}

/** 한 줄 값 → 문자열. 따옴표 · 꾸밈 없는 글자 · 줄 끝 ` #주석` */
export function parseScalar(input: string, lineNo: number | null = null): string {
  const s = input.trim();
  if (s.startsWith('"')) return parseDoubleQuoted(s, lineNo);
  if (s.startsWith("'")) return parseSingleQuoted(s, lineNo);
  const hash = s.search(/[ ]#/);
  const plain = (hash >= 0 ? s.slice(0, hash) : s).trimEnd();
  if (plain === '') return '';
  if (PLAIN_FORBIDDEN_START.has(plain[0] as string)) throw new FrontmatterError(`Unsupported YAML syntax "${plain[0]}"`, lineNo);
  if (plain === '-' || plain.startsWith('- ')) throw new FrontmatterError('Nested lists are not supported', lineNo);
  if (plain.includes(': ') || plain.endsWith(':')) throw new FrontmatterError('Plain value contains ": " — quote it', lineNo);
  return plain;
}

/** 닫는 따옴표 뒤에는 공백 · 주석만 */
function assertTrailing(rest: string, lineNo: number | null): void {
  const t = rest.trim();
  if (t !== '' && !t.startsWith('#')) throw new FrontmatterError('Unexpected text after quoted value', lineNo);
}

function parseDoubleQuoted(s: string, lineNo: number | null): string {
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i] as string;
    if (c === '"') { assertTrailing(s.slice(i + 1), lineNo); return out; }
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    i += 1;
    switch (n) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new FrontmatterError('Invalid \\u escape', lineNo);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default: throw new FrontmatterError(`Unsupported escape "\\${n ?? ''}"`, lineNo);
    }
  }
  throw new FrontmatterError('Unterminated double-quoted value (multi-line values are not supported)', lineNo);
}

function parseSingleQuoted(s: string, lineNo: number | null): string {
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i] as string;
    if (c !== "'") { out += c; continue; }
    if (s[i + 1] === "'") { out += "'"; i += 1; continue; }
    assertTrailing(s.slice(i + 1), lineNo);
    return out;
  }
  throw new FrontmatterError('Unterminated single-quoted value (multi-line values are not supported)', lineNo);
}

/** 값 꼴 가르기 — 검증 코드가 쓴다 */
export const isStringValue = (v: FrontmatterValue | undefined): v is string => typeof v === 'string';
export const isListValue = (v: FrontmatterValue | undefined): v is readonly string[] => Array.isArray(v);
export const isMapValue = (v: FrontmatterValue | undefined): v is Readonly<Record<string, string>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
