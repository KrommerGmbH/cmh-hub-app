import { describe, expect, it } from 'vitest';
import {
  FRONTMATTER_MAX_BYTES,
  FrontmatterError,
  FrontmatterTooLargeError,
  normalizeText,
  parseFrontmatter,
  parseScalar,
  parseYamlSubset,
  splitFrontmatter,
} from './frontmatter.js';

describe('프런트매터 나누기(R3-a · SKILL.md · .prompt.md 공용)', () => {
  it('BOM · CRLF 를 떼고 LF 로 맞춘다', () => {
    const text = '\uFEFF---\r\nname: a-b\r\ndescription: x\r\n---\r\n본문 1\r\n본문 2\r\n';
    const fm = parseFrontmatter(text);
    expect(fm.data['name']).toBe('a-b');
    expect(fm.data['description']).toBe('x');
    expect(fm.body).toBe('본문 1\n본문 2\n');
    expect(normalizeText('a\rb\r\nc')).toBe('a\nb\nc');
  });

  it('첫 줄이 --- 가 아니면 null · 닫는 --- 가 없으면 예외', () => {
    expect(splitFrontmatter('# 제목\n')).toBeNull();
    expect(() => parseFrontmatter('# 제목\n')).toThrow(FrontmatterError);
    expect(() => splitFrontmatter('---\nname: x\n')).toThrow(/not closed/);
  });

  it('본문의 --- 는 첫 닫는 줄 뒤라 본문에 남는다', () => {
    expect(parseFrontmatter('---\na: b\n---\nx\n---\ny').body).toBe('x\n---\ny');
  });
});

describe('작은 YAML 부분집합', () => {
  it('글자 · 따옴표 · 주석 · 목록 · 맵 한 단계', () => {
    const data = parseYamlSubset([
      '# 주석 줄',
      'plain: hello world # 줄 끝 주석',
      'dq: "a: b \\"q\\" \\n \\u00e4"',
      "sq: 'it''s # not comment'",
      'num: 1.0',
      'empty:',
      'list:',
      '  - one',
      '  - "two: 2"',
      'flat-list:',
      '- x',
      'map:',
      '  author: me',
      '  version: "1.0"',
    ].join('\n'));
    expect(data['plain']).toBe('hello world');
    expect(data['dq']).toBe('a: b "q" \n ä');
    expect(data['sq']).toBe("it's # not comment");
    expect(data['num']).toBe('1.0');
    expect(data['empty']).toBe('');
    expect(data['list']).toEqual(['one', 'two: 2']);
    expect(data['flat-list']).toEqual(['x']);
    expect(data['map']).toEqual({ author: 'me', version: '1.0' });
  });

  it('키가 __proto__ 여도 프로토타입을 바꾸지 않는다', () => {
    const data = parseYamlSubset('__proto__: x');
    expect(Object.getPrototypeOf(data)).toBeNull();
    expect(data['__proto__']).toBe('x');
  });

  it('지원하지 않는 꼴은 예외 — 흐름 목록 · 흐름 맵 · 들여쓰기 숫자 · 앵커 · 두 단계 · 탭 · 중복 키', () => {
    const bad = [
      'a: [x, y]',
      'a: {b: c}',
      'a: |2\n  text',
      'a: |x',
      'a: >\n\ttext',
      'a: x\n  # 주석 줄',
      'a: x # c\n  more',
      'a: x\n  b: y',
      'a:\n  b: c\n  - d',
      'a:\n  b:\n    - c',
      'a: &anchor x',
      'a: *ref',
      'a:\n  b:\n    c: d',
      'a:\n  - - x',
      'a:\n  - k: v',
      'a:\n\t- x',
      'a: b: c',
      'a: x\na: y',
      '  a: x',
      'just text',
      'a: "unterminated',
      'a: "x" trailing',
      'a:\n  - x\n  k: v',
      'a:\n  b: x\n   c: y',
    ];
    for (const src of bad) expect(() => parseYamlSubset(src), src).toThrow(FrontmatterError);
  });

  it('오류에 줄 번호가 붙는다(파일 기준)', () => {
    try {
      parseFrontmatter('---\nok: 1\nbad: [1]\n---\n');
      expect.unreachable();
    } catch (e) {
      expect((e as FrontmatterError).line).toBe(3);
    }
  });

  it('parseScalar — 빈 값 · 주석만 · 홑따옴표 뒤 주석', () => {
    expect(parseScalar('')).toBe('');
    expect(parseScalar("'x' # c")).toBe('x');
    expect(parseScalar('a#b')).toBe('a#b');
  });
});

describe('검수 권고 — plain 여러 줄 · 블록 글자(| >) · 256KB 상한', () => {
  it('plain 여러 줄 이어쓰기(들여쓴 다음 줄) — 공백 하나로 접는다 · 빈 줄은 줄바꿈', () => {
    const data = parseYamlSubset('description: first line\n  continues here\n    and here\nnext: x');
    expect(data['description']).toBe('first line continues here and here');
    expect(data['next']).toBe('x');
    expect(parseYamlSubset('a: one\n\n  two\nb: c')['a']).toBe('one\ntwo');
    expect(parseYamlSubset('a: one\n  two\n\nb: c')).toEqual({ a: 'one two', b: 'c' });
  });

  it('key: 다음 줄부터 시작하는 plain 여러 줄', () => {
    expect(parseYamlSubset('description:\n  long text\n  more text\nname: x')).toEqual({ description: 'long text more text', name: 'x' });
  });

  it('| 블록(그대로) — clip · strip(-) · keep(+)', () => {
    const src = (h: string): string => `a: ${h}\n  line 1\n    indented\n\n  line 3\n\nb: x`;
    expect(parseYamlSubset(src('|'))['a']).toBe('line 1\n  indented\n\nline 3\n');
    expect(parseYamlSubset(src('|-'))['a']).toBe('line 1\n  indented\n\nline 3');
    expect(parseYamlSubset(src('|+'))['a']).toBe('line 1\n  indented\n\nline 3\n\n');
    expect(parseYamlSubset(src('|'))['b']).toBe('x');
  });

  it('> 블록(접기) — 한 줄 바꿈은 공백 · 빈 줄은 줄바꿈 · 더 들여쓴 줄은 그대로', () => {
    expect(parseYamlSubset('a: >\n  folded\n  text\n\n  para two\nb: y')).toEqual({ a: 'folded text\npara two\n', b: 'y' });
    expect(parseYamlSubset('a: >-\n  one\n  two\n')['a']).toBe('one two');
    expect(parseYamlSubset('a: >\n  one\n    more\n  two\n')['a']).toBe('one\n  more\ntwo\n');
    expect(parseYamlSubset('a: > # 주석\n  x\n')['a']).toBe('x\n');
  });

  it('내용 없는 블록은 빈 글자 · 블록 안 # 은 글자', () => {
    expect(parseYamlSubset('a: >\nb: c')).toEqual({ a: '', b: 'c' });
    expect(parseYamlSubset('a: |\n  # not a comment\n  x: y\n')['a']).toBe('# not a comment\nx: y\n');
  });

  it('SKILL.md 꼴 — description: > 블록이 그대로 읽힌다', () => {
    const fm = parseFrontmatter('---\nname: s\ndescription: >\n  Extract text\n  from PDFs.\n---\n# body\n');
    expect(fm.data['description']).toBe('Extract text from PDFs.\n');
    expect(fm.body).toBe('# body\n');
  });

  it('256KB 를 넘는 파일은 FrontmatterTooLargeError(FrontmatterError 의 한 갈래)', () => {
    const big = `---\na: b\n---\n${'x'.repeat(FRONTMATTER_MAX_BYTES)}`;
    expect(() => splitFrontmatter(big)).toThrow(FrontmatterTooLargeError);
    expect(() => splitFrontmatter(big)).toThrow(FrontmatterError);
    // 한글은 3 바이트 — 글자 수가 아니라 바이트로 센다
    const ko = `---\na: b\n---\n${'가'.repeat(Math.ceil(FRONTMATTER_MAX_BYTES / 3) + 1)}`;
    expect(() => splitFrontmatter(ko)).toThrow(FrontmatterTooLargeError);
    const ok = `---\na: b\n---\n${'x'.repeat(FRONTMATTER_MAX_BYTES - 20)}`;
    expect(splitFrontmatter(ok)?.header).toBe('a: b');
  });
});
