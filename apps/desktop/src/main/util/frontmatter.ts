// R3-a — `---` 로 감싼 YAML 프런트매터 + 본문. 새 의존 0 이라 YAML 은 쓰는 만큼만 읽는다(SKILL.md · .prompt.md 공용).
// electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
//
// 읽는 꼴(이 밖은 전부 FrontmatterError — 조용히 다르게 읽는 것보다 거부가 낫다):
//   key: 글자              · key: "따옴표 \n 이스케이프" · key: '홑따옴표 '' 두 번'
//   key:                   · key:                     · key: 첫 줄            · key: |  (또는 |- |+ > >- >+)
//     - 목록 한 줄            ·   sub: 문자열→문자열 맵    ·   들여쓴 다음 줄         ·   블록 글자(그대로 · 접기)
//                                 한 단계                    (plain 여러 줄 이어쓰기 · 공백 하나로 접는다)
// 숫자 · true 도 글자 그대로(문자열)다. `[a, b]` · `{a: b}` · `&` · `*` · `!` · 들여쓰기 숫자(`|2`)는 예외.
// 블록 글자 · 여러 줄 plain 은 맨 위 키에서만(맵 · 목록 안은 한 줄). 파일 크기 상한 FRONTMATTER_MAX_BYTES(256KB).

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

/** 파일(프런트매터 + 본문) 크기 상한 — SKILL.md · .prompt.md 공용(검수 권고) */
export const FRONTMATTER_MAX_BYTES = 256 * 1024;

/** 크기 상한을 넘었을 때 — 부르는 쪽이 «파일이 너무 큼» 스니펫 키로 바꾼다 */
export class FrontmatterTooLargeError extends FrontmatterError {
  constructor(bytes: number) {
    super(`File is ${bytes} bytes — larger than ${FRONTMATTER_MAX_BYTES}`);
    this.name = 'FrontmatterTooLargeError';
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
  // UTF-8 한 글자는 4 바이트 이하 — 글자 수로 먼저 거르고 경계 근처만 바이트를 센다
  if (text.length * 4 > FRONTMATTER_MAX_BYTES) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > FRONTMATTER_MAX_BYTES) throw new FrontmatterTooLargeError(bytes);
  }
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
    const block = BLOCK_HEADER.exec(rest.trim());
    if (block) {
      const read = readBlockScalar(lines, i + 1, block[1] === '>', block[2] ?? '', firstLineNo);
      data[key] = read.value;
      i = read.next;
      continue;
    }
    if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
      const first = parseScalar(rest, lineNo);
      // 따옴표 값은 한 줄만 · plain 은 들여쓴 다음 줄들을 이어 읽는다
      const quoted = rest.trim().startsWith('"') || rest.trim().startsWith("'");
      const cont = quoted ? { parts: [] as string[], next: i + 1 } : readPlainContinuation(lines, i + 1, firstLineNo);
      if (cont.parts.length > 0 && /[ ]#/.test(rest.trim())) {
        throw new FrontmatterError('Comments inside a multi-line value are not supported', lineNo);
      }
      data[key] = cont.parts.length === 0 ? first : foldPlainLines([first, ...cont.parts]);
      i = cont.next;
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

/** `|` · `>` 다음 선택 chomping(`-` · `+`) · 줄 끝 주석. 들여쓰기 숫자(`|2`)는 받지 않는다 */
const BLOCK_HEADER = /^([|>])([+-]?)(?:[ ]+#.*)?$/;

/**
 * 블록 글자 읽기(YAML 1.2 §8.1 — js-yaml readBlockScalar 와 같은 차례).
 * 들여쓰기 = 첫 내용 줄의 들여쓰기(0 이면 빈 값). 그보다 덜 들여쓴 내용 줄에서 끝난다.
 * literal(`|`)은 줄바꿈을 그대로 · folded(`>`)는 한 줄 바꿈을 공백으로(더 들여쓴 줄 · 빈 줄 앞뒤는 그대로).
 * chomping: 기본 clip(끝 줄바꿈 하나) · `-` strip(없음) · `+` keep(전부).
 */
function readBlockScalar(
  lines: readonly string[],
  start: number,
  folding: boolean,
  chomping: string,
  firstLineNo: number,
): { value: string; next: number } {
  let indent = 0;
  for (let k = start; k < lines.length; k += 1) {
    const l = lines[k] ?? '';
    if (l.trim() === '') continue;
    if (/^[ ]*\t/.test(l)) throw new FrontmatterError('Tab indentation is not allowed', firstLineNo + k);
    indent = (/^[ ]*/.exec(l)?.[0] ?? '').length;
    break;
  }
  let result = '';
  let emptyLines = 0;
  let didReadContent = false;
  let atMoreIndented = false;
  let j = start;
  if (indent > 0) {
    for (; j < lines.length; j += 1) {
      const l = lines[j] ?? '';
      if (l.trim() === '') { emptyLines += 1; continue; }
      const lead = (/^[ ]*/.exec(l)?.[0] ?? '').length;
      if (lead < indent) break;
      const line = l.slice(indent);
      if (folding) {
        if (line.startsWith(' ') || line.startsWith('\t')) {
          atMoreIndented = true;
          result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          result += '\n'.repeat(emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) result += ' ';
        } else {
          result += '\n'.repeat(emptyLines);
        }
      } else {
        result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
      }
      result += line;
      didReadContent = true;
      emptyLines = 0;
    }
  } else {
    // 내용 줄이 없다 — 빈 줄만 지나간다(다음 키는 0 칸에서 시작)
    while (j < lines.length && (lines[j] ?? '').trim() === '') { emptyLines += 1; j += 1; }
  }
  if (chomping === '+') result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
  else if (chomping === '' && didReadContent) result += '\n';
  // 블록 끝의 빈 줄은 다음 키 앞 빈 줄이기도 하다 — j 는 이미 그 뒤
  return { value: result, next: j };
}

/**
 * plain 값의 이어지는 줄(들여쓴 줄 · 사이 빈 줄). 각 줄은 한 줄 plain 규칙을 그대로 지킨다(`: ` · 시작 `- ` · 주석 줄 거부).
 * 다음 0 칸 줄에서 끝난다. 끝의 빈 줄은 이어쓰기에 넣지 않는다.
 */
function readPlainContinuation(lines: readonly string[], start: number, firstLineNo: number): { parts: string[]; next: number } {
  const parts: string[] = [];
  let pendingEmpty = 0;
  let j = start;
  for (; j < lines.length; j += 1) {
    const l = lines[j] ?? '';
    if (l.trim() === '') { pendingEmpty += 1; continue; }
    if (/^\t/.test(l) || /^[ ]+\t/.test(l)) throw new FrontmatterError('Tab indentation is not allowed', firstLineNo + j);
    if (!/^[ ]+\S/.test(l)) break;
    const t = l.trim();
    if (t.startsWith('#')) throw new FrontmatterError('Comment lines inside a multi-line value are not supported', firstLineNo + j);
    if (/[ ]#/.test(t)) throw new FrontmatterError('Comments inside a multi-line value are not supported', firstLineNo + j);
    for (let e = 0; e < pendingEmpty; e += 1) parts.push('');
    pendingEmpty = 0;
    parts.push(parseScalar(t, firstLineNo + j));
  }
  // 끝의 빈 줄들은 값이 아니다 — 다음 키 줄(j)부터 다시 읽는다
  return { parts, next: j };
}

/** plain 여러 줄 접기 — 줄 사이는 공백 하나 · 빈 줄 하나는 줄바꿈 하나 */
function foldPlainLines(parts: readonly string[]): string {
  let out = '';
  let empties = 0;
  let started = false;
  for (const p of parts) {
    if (p === '') { empties += 1; continue; }
    if (started) out += empties === 0 ? ' ' : '\n'.repeat(empties);
    out += p;
    started = true;
    empties = 0;
  }
  return out;
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
  if (!MAP_ENTRY.test(first.text)) {
    // `key:` 다음 줄부터 시작하는 plain 여러 줄 값 — 들여쓴 줄마다 한 줄 plain 규칙
    return foldPlainLines(children.map(({ text, lineNo }) => {
      if (LIST_ITEM.test(text)) throw new FrontmatterError('Mixed text and list entries', lineNo);
      const t = text.trim();
      if (/(^|[ ])#/.test(t)) throw new FrontmatterError('Comments inside a multi-line value are not supported', lineNo);
      return parseScalar(t, lineNo);
    }));
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
