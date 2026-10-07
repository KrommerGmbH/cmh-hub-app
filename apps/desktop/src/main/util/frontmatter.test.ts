import { describe, expect, it } from 'vitest';
import { FrontmatterError, normalizeText, parseFrontmatter, parseScalar, parseYamlSubset, splitFrontmatter } from './frontmatter.js';

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

  it('지원하지 않는 꼴은 예외 — 흐름 목록 · 흐름 맵 · 블록 글자 · 앵커 · 두 단계 · 탭 · 중복 키', () => {
    const bad = [
      'a: [x, y]',
      'a: {b: c}',
      'a: |\n  text',
      'a: >',
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
