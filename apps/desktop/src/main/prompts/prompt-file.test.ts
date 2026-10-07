import { describe, expect, it } from 'vitest';
import { parsePromptFile, placeholdersIn, PROMPT_ERROR, PromptRenderError, render, toMcpPromptShape, type PromptFile } from './prompt-file.js';

const file = (front: string, body: string): string => `---\n${front}\n---\n${body}`;
const GOOD = file(
  'name: product-title\ndescription: Write a product title\nlocale: de-DE\narguments:\n  - product\n  - max_len',
  'Titel für {{product}} in höchstens {{ max_len }} Zeichen. Nochmal {{product}}.',
);

describe('.prompt.md 읽기(R3-a · VS Code 프롬프트 파일 꼴)', () => {
  it('올바른 파일 — 프런트매터 · 본문 · 자리표', () => {
    const r = parsePromptFile(GOOD, 'C:/x/prompts/product-title.prompt.md');
    expect(r.errors).toEqual([]);
    expect(r.prompt).toMatchObject({ name: 'product-title', description: 'Write a product title', locale: 'de-DE', arguments: ['product', 'max_len'] });
    expect(placeholdersIn(r.prompt!.body)).toEqual(['product', 'max_len']);
  });

  it('render — 모든 자리표를 한 번에 · 값 안의 {{x}} 는 다시 안 바뀐다', () => {
    const p = parsePromptFile(GOOD).prompt as PromptFile;
    expect(render(p, { product: 'Tee', max_len: '60' })).toBe('Titel für Tee in höchstens 60 Zeichen. Nochmal Tee.');
    expect(render(p, { product: '{{max_len}}', max_len: '5' })).toBe('Titel für {{max_len}} in höchstens 5 Zeichen. Nochmal {{max_len}}.');
  });

  it('render — 빠진 argument · 모르는 argument 는 예외(스니펫 키)', () => {
    const p = parsePromptFile(GOOD).prompt as PromptFile;
    const keyOf = (args: Record<string, string>): string => {
      try {
        render(p, args);
      } catch (e) {
        expect(e).toBeInstanceOf(PromptRenderError);
        return (e as PromptRenderError).snippetKey;
      }
      return 'no-throw';
    };
    expect(keyOf({ product: 'Tee' })).toBe('cmh-hub-app.prompt.argumentMissing');
    expect(keyOf({ product: 'a', max_len: '1', extra: 'x' })).toBe('cmh-hub-app.prompt.argumentUnknown');
  });

  it('toMcpPromptShape — MCP prompts/list 꼴', () => {
    const p = parsePromptFile(GOOD).prompt as PromptFile;
    expect(toMcpPromptShape(p)).toEqual({
      name: 'product-title',
      description: 'Write a product title',
      arguments: [{ name: 'product', required: true }, { name: 'max_len', required: true }],
    });
  });

  it('arguments 없는 프롬프트 · 예약어 검사 없음(claude 허용)', () => {
    const r = parsePromptFile(file('name: claude-review\ndescription: Review', '그냥 글'));
    expect(r.ok).toBe(true);
    expect(toMcpPromptShape(r.prompt!).arguments).toEqual([]);
  });

  it('자리표 검사 — 선언 안 된 자리표 · 틀린 자리표 이름 거부 · 안 쓰는 argument 는 경고', () => {
    expect(parsePromptFile(file('name: a\ndescription: x\narguments:\n  - one', '{{one}} {{two}}')).errors).toEqual([PROMPT_ERROR.placeholderUndeclared]);
    expect(parsePromptFile(file('name: a\ndescription: x', '{{ 1bad }}')).errors).toEqual([PROMPT_ERROR.placeholderInvalid]);
    expect(parsePromptFile(file('name: a\ndescription: x', '{{}}')).errors).toEqual([PROMPT_ERROR.placeholderInvalid]);
    const unused = parsePromptFile(file('name: a\ndescription: x\narguments:\n  - spare', '본문'));
    expect(unused.ok).toBe(true);
    expect(unused.warnings).toEqual(['Argument "spare" is declared but not used in the body']);
  });

  it('프런트매터 규칙 위반', () => {
    const errs = (front: string, name?: string): string[] => parsePromptFile(file(front, 'x'), name).errors;
    expect(errs('description: x')).toEqual([PROMPT_ERROR.nameMissing]);
    expect(errs('name: Bad\ndescription: x')).toEqual([PROMPT_ERROR.nameInvalid]);
    expect(errs('name: a--b\ndescription: x')).toEqual([PROMPT_ERROR.nameHyphen]);
    expect(errs(`name: ${'a'.repeat(65)}\ndescription: x`)).toEqual([PROMPT_ERROR.nameTooLong]);
    expect(errs('name: a')).toEqual([PROMPT_ERROR.descriptionMissing]);
    expect(errs(`name: a\ndescription: ${'d'.repeat(1025)}`)).toEqual([PROMPT_ERROR.descriptionTooLong]);
    expect(errs('name: a\ndescription: x\nlocale: ko')).toEqual([PROMPT_ERROR.localeInvalid]);
    expect(errs('name: a\ndescription: x\narguments: one')).toEqual([PROMPT_ERROR.argumentsInvalid]);
    expect(errs('name: a\ndescription: x\narguments:\n  - 1x')).toEqual([PROMPT_ERROR.argumentNameInvalid]);
    expect(errs('name: a\ndescription: x\narguments:\n  - k\n  - k')).toEqual([PROMPT_ERROR.argumentDuplicate]);
    expect(errs('name: a\ndescription: x', 'b.prompt.md')).toEqual([PROMPT_ERROR.nameFileMismatch]);
    expect(errs('name: a\ndescription: x', 'a.md')).toEqual([PROMPT_ERROR.fileNameInvalid]);
    expect(parsePromptFile('본문만').errors).toEqual([PROMPT_ERROR.frontmatterMissing]);
    expect(parsePromptFile('---\nname: {a}\n---\n').errors).toEqual([PROMPT_ERROR.frontmatterInvalid]);
  });

  it('BOM · CRLF 파일', () => {
    const r = parsePromptFile('\uFEFF---\r\nname: crlf\r\ndescription: x\r\narguments:\r\n  - who\r\n---\r\nHallo {{who}}\r\n');
    expect(r.ok).toBe(true);
    expect(render(r.prompt!, { who: 'Welt' })).toBe('Hallo Welt\n');
  });
});

describe('검수 차단 3 — 자리표 ReDoS · 권고 \\{{ 이스케이프', () => {
  it("닫히지 않은 '{{' + 공백 10000 개가 50ms 안에", () => {
    const body = '{{' + ' '.repeat(10000);
    const t0 = performance.now();
    expect(placeholdersIn(body)).toEqual([]);
    expect(parsePromptFile(file('name: a\ndescription: x', body)).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("'{{' + 공백 50 개를 200 번 되풀이해도 50ms 안에", () => {
    const body = ('{{' + ' '.repeat(50)).repeat(200);
    const t0 = performance.now();
    expect(placeholdersIn(body)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('안쪽 공백은 trim — {{ a }} · {{a}} 는 같은 자리표', () => {
    expect(placeholdersIn('{{a}} {{  a  }} {{\tb\t}}')).toEqual(['a', 'b']);
  });

  it('\\{{ 는 이스케이프 — 자리표가 아니고 render 가 {{ 글자로 남긴다', () => {
    const r = parsePromptFile(file('name: a\ndescription: x\narguments:\n  - who', 'Vue: \\{{ item.name }} · Hallo {{who}}'));
    expect(r.errors).toEqual([]);
    expect(placeholdersIn(r.prompt!.body)).toEqual(['who']);
    expect(render(r.prompt!, { who: 'Welt' })).toBe('Vue: {{ item.name }} · Hallo Welt');
  });

  it('값 안의 $& · $1 은 그대로(replace 함수꼴)', () => {
    const p = parsePromptFile(file('name: a\ndescription: x\narguments:\n  - v', '[{{v}}]')).prompt as PromptFile;
    expect(render(p, { v: '$& $1 {{v}}' })).toBe('[$& $1 {{v}}]');
  });

  it('256KB 를 넘는 파일 = fileTooLarge', () => {
    const r = parsePromptFile(file('name: a\ndescription: x', 'x'.repeat(256 * 1024)));
    expect(r.errors).toEqual([PROMPT_ERROR.fileTooLarge]);
  });
});
