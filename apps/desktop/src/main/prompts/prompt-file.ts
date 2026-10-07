// R3-a — 로컬 프롬프트 파일 `.prompt.md`(YAML 프런트매터 + 본문) 읽기 · 검사 · 채우기. electron 을 import 하지 않는 순수 모듈.
// 근거: PLAN R3 §4 【AI 임시 결정 · 사장님 확인 ④】 — 파일 단일 표준이 없어 VS Code 프롬프트 파일 꼴(`*.prompt.md` + 프런트매터)을 골랐다
//   (research/04 §3). 밖으로는 MCP prompts 꼴(`prompts/list` 의 name · description · arguments[{name, required}])로 낸다.
// 프런트매터: name(스킬과 같은 규칙 · 예약어 검사 없음) · description · 선택 locale(ko-KR|en-GB|de-DE) · arguments(목록)
// 본문 자리표 `{{arg}}` 는 arguments 에 다 있어야 한다. 1차는 arguments 가 전부 필수(required: true).
// `\{{` 는 이스케이프 — 자리표가 아니라 `{{` 글자 그대로(render 가 `\` 를 뗀다).
// errors 는 R8 스니펫 키 그대로(화면 글자).
import path from 'node:path';
import {
  FrontmatterError,
  FrontmatterTooLargeError,
  isListValue,
  isStringValue,
  parseYamlSubset,
  splitFrontmatter,
  type FrontmatterValue,
} from '../util/frontmatter.js';
import { charLength, DESCRIPTION_MAX, nameRuleViolations, type NameRule } from '../skills/skill-manifest.js';

export const PROMPT_FILE_SUFFIX = '.prompt.md';
export const PROMPT_LOCALES = ['ko-KR', 'en-GB', 'de-DE'] as const;
export type PromptLocale = (typeof PROMPT_LOCALES)[number];
export const ARGUMENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/**
 * `{{ name }}`(안쪽 공백은 trim) 또는 이스케이프 `\{{`. 안쪽은 `[^{}]*` 하나뿐 — 겹치는 수량자가 없어 되돌림이 선형이다
 * (예전 `\s*([^{}]*?)\s*` 는 닫히지 않은 `{{` + 공백 n 개에서 O(n²) · 검수 차단 3).
 */
const PLACEHOLDER = /\\\{\{|\{\{([^{}]*)\}\}/g;
const ESCAPED_OPEN = '\\{{';
const KNOWN_KEYS = new Set(['name', 'description', 'locale', 'arguments']);

export const PROMPT_ERROR = {
  frontmatterMissing: 'cmh-hub-app.prompt.frontmatterMissing',
  frontmatterInvalid: 'cmh-hub-app.prompt.frontmatterInvalid',
  fileTooLarge: 'cmh-hub-app.prompt.fileTooLarge',
  fileNameInvalid: 'cmh-hub-app.prompt.fileNameInvalid',
  nameMissing: 'cmh-hub-app.prompt.nameMissing',
  nameTooLong: 'cmh-hub-app.prompt.nameTooLong',
  nameInvalid: 'cmh-hub-app.prompt.nameInvalid',
  nameHyphen: 'cmh-hub-app.prompt.nameHyphen',
  nameFileMismatch: 'cmh-hub-app.prompt.nameFileMismatch',
  descriptionMissing: 'cmh-hub-app.prompt.descriptionMissing',
  descriptionTooLong: 'cmh-hub-app.prompt.descriptionTooLong',
  localeInvalid: 'cmh-hub-app.prompt.localeInvalid',
  argumentsInvalid: 'cmh-hub-app.prompt.argumentsInvalid',
  argumentNameInvalid: 'cmh-hub-app.prompt.argumentNameInvalid',
  argumentDuplicate: 'cmh-hub-app.prompt.argumentDuplicate',
  placeholderInvalid: 'cmh-hub-app.prompt.placeholderInvalid',
  placeholderUndeclared: 'cmh-hub-app.prompt.placeholderUndeclared',
} as const;
export type PromptErrorKey = (typeof PROMPT_ERROR)[keyof typeof PROMPT_ERROR];

const PROMPT_NAME_ERROR: Record<Exclude<NameRule, 'reserved'>, PromptErrorKey> = {
  missing: PROMPT_ERROR.nameMissing,
  tooLong: PROMPT_ERROR.nameTooLong,
  invalid: PROMPT_ERROR.nameInvalid,
  hyphen: PROMPT_ERROR.nameHyphen,
};

export interface PromptFile {
  name: string;
  description: string;
  locale: PromptLocale | null;
  arguments: string[];
  body: string;
}

export interface PromptValidation {
  ok: boolean;
  errors: PromptErrorKey[];
  /** 로그용 영문(모르는 키 · 안 쓰는 argument) */
  warnings: string[];
  prompt: PromptFile | null;
}

/** MCP `prompts/list` 한 줄과 같은 꼴 */
export interface McpPromptShape {
  name: string;
  description: string;
  arguments: Array<{ name: string; required: boolean }>;
}

export class PromptRenderError extends Error {
  readonly snippetKey: string;
  constructor(snippetKey: string, message: string) {
    super(message);
    this.name = 'PromptRenderError';
    this.snippetKey = snippetKey;
  }
}

export const PROMPT_RENDER_SNIPPET = {
  argumentMissing: 'cmh-hub-app.prompt.argumentMissing',
  argumentUnknown: 'cmh-hub-app.prompt.argumentUnknown',
} as const;

/** 본문의 자리표 이름(나온 차례 · 중복 없음) — 이름이 틀린 것도 그대로 돌려준다(검사는 parsePromptFile) */
export function placeholdersIn(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m[0] === ESCAPED_OPEN) continue;
    seen.add((m[1] ?? '').trim());
  }
  return [...seen];
}

/** 파일 글 → 검사 결과. fileName 을 주면 `<name>.prompt.md` 인지도 본다(저장 폴더 `userData/prompts/`) */
export function parsePromptFile(text: string, fileName?: string): PromptValidation {
  const errors: PromptErrorKey[] = [];
  const warnings: string[] = [];
  let data: Readonly<Record<string, FrontmatterValue>>;
  let body: string;
  try {
    const split = splitFrontmatter(text);
    if (!split) return { ok: false, errors: [PROMPT_ERROR.frontmatterMissing], warnings, prompt: null };
    data = parseYamlSubset(split.header, 2);
    body = split.body;
  } catch (e) {
    if (e instanceof FrontmatterTooLargeError) return { ok: false, errors: [PROMPT_ERROR.fileTooLarge], warnings: [e.message], prompt: null };
    if (!(e instanceof FrontmatterError)) throw e;
    return { ok: false, errors: [PROMPT_ERROR.frontmatterInvalid], warnings: [e.message], prompt: null };
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown frontmatter key "${key}" ignored`);
  }

  const rawName = data['name'];
  const name = isStringValue(rawName) ? rawName : '';
  if (rawName !== undefined && !isStringValue(rawName)) errors.push(PROMPT_ERROR.nameInvalid);
  else errors.push(...nameRuleViolations(name, { reserved: false }).map((r) => PROMPT_NAME_ERROR[r as Exclude<NameRule, 'reserved'>]));
  if (fileName !== undefined) {
    const base = path.basename(fileName);
    if (!base.endsWith(PROMPT_FILE_SUFFIX)) errors.push(PROMPT_ERROR.fileNameInvalid);
    else if (name !== '' && base.slice(0, -PROMPT_FILE_SUFFIX.length) !== name) errors.push(PROMPT_ERROR.nameFileMismatch);
  }

  const rawDescription = data['description'];
  const description = isStringValue(rawDescription) ? rawDescription.trim() : '';
  if (description === '') errors.push(PROMPT_ERROR.descriptionMissing);
  else if (charLength(description) > DESCRIPTION_MAX) errors.push(PROMPT_ERROR.descriptionTooLong);

  const rawLocale = data['locale'];
  let locale: PromptLocale | null = null;
  if (rawLocale !== undefined) {
    if (isStringValue(rawLocale) && (PROMPT_LOCALES as readonly string[]).includes(rawLocale)) locale = rawLocale as PromptLocale;
    else errors.push(PROMPT_ERROR.localeInvalid);
  }

  const rawArgs = data['arguments'];
  let args: string[] = [];
  if (rawArgs !== undefined && rawArgs !== '') {
    if (!isListValue(rawArgs)) errors.push(PROMPT_ERROR.argumentsInvalid);
    else {
      args = [...rawArgs];
      if (args.some((a) => !ARGUMENT_NAME.test(a))) errors.push(PROMPT_ERROR.argumentNameInvalid);
      if (new Set(args).size !== args.length) errors.push(PROMPT_ERROR.argumentDuplicate);
    }
  }

  const used = placeholdersIn(body);
  if (used.some((p) => !ARGUMENT_NAME.test(p))) errors.push(PROMPT_ERROR.placeholderInvalid);
  if (used.some((p) => ARGUMENT_NAME.test(p) && !args.includes(p))) errors.push(PROMPT_ERROR.placeholderUndeclared);
  for (const a of args) {
    if (!used.includes(a)) warnings.push(`Argument "${a}" is declared but not used in the body`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings, prompt: null };
  return { ok: true, errors, warnings, prompt: { name, description, locale, arguments: args, body } };
}

/**
 * 자리표를 값으로 바꾼다 — 한 번만 훑으므로 값 안의 `{{x}}` 는 다시 바뀌지 않는다. `\{{` 는 `{{` 글자로.
 * 빠진 argument · 모르는 argument 는 예외(조용히 비워 두지 않는다).
 */
export function render(prompt: PromptFile, args: Readonly<Record<string, string>>): string {
  for (const a of prompt.arguments) {
    if (!Object.prototype.hasOwnProperty.call(args, a)) {
      throw new PromptRenderError(PROMPT_RENDER_SNIPPET.argumentMissing, `Missing argument "${a}" for prompt "${prompt.name}"`);
    }
  }
  for (const k of Object.keys(args)) {
    if (!prompt.arguments.includes(k)) {
      throw new PromptRenderError(PROMPT_RENDER_SNIPPET.argumentUnknown, `Unknown argument "${k}" for prompt "${prompt.name}"`);
    }
  }
  return prompt.body.replace(PLACEHOLDER, (whole: string, inner: string | undefined) =>
    whole === ESCAPED_OPEN ? '{{' : (args[(inner ?? '').trim()] ?? ''),
  );
}

/** MCP prompts 와 같은 꼴 — 챗 `/` 목록에서 MCP 서버 프롬프트와 나란히 놓는다(PromptStore · R3-b) */
export function toMcpPromptShape(prompt: PromptFile): McpPromptShape {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map((name) => ({ name, required: true })),
  };
}
