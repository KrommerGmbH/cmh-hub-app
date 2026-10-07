// R3-a — Agent Skills `SKILL.md` 검증(설치 전에). electron 을 import 하지 않는다 · 폴더 읽기만 node:fs.
// 근거(research/04 §2): 열린 규격 agentskills `docs/specification.mdx` — `name` 1–64 · a-z 0-9 하이픈 · 시작·끝 하이픈 금지 · `--` 금지
//   · 부모 폴더명과 같음 · `description` ≤1024 · 선택 `license` · `compatibility`(≤500) · `metadata` · `allowed-tools`(실험)
//   + Anthropic 문서 — `name` XML 금지 · 예약어 "anthropic" · "claude" 금지 · `description` XML 태그 금지.
// 합의안 권고: `scripts/` 가 있으면 설치 때 사람 확인 · 실행은 Guard 도구 `skill:<name>:script` · 토큰 절약으로 먼저 싣는 것은 name+description 만.
// errors 는 R8 스니펫 키 그대로(화면 글자) — 규칙 하나에 키 하나.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  FrontmatterError,
  isListValue,
  isMapValue,
  isStringValue,
  parseYamlSubset,
  splitFrontmatter,
  type FrontmatterValue,
} from '../util/frontmatter.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILL_SCRIPTS_DIR = 'scripts';
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
export const RESERVED_WORDS = ['anthropic', 'claude'] as const;

/** 소문자 · 숫자 묶음을 하이픈 하나로 잇는다 = 시작·끝 하이픈 · `--` 금지까지 */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `<tag>` · `</tag>` · `<tag attr="x"/>` 꼴 */
const XML_TAG = /<\/?[A-Za-z][\w:.-]*(\s[^<>]*)?\/?>/;
const KNOWN_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

export const SKILL_ERROR = {
  fileMissing: 'cmh-hub-app.skill.fileMissing',
  frontmatterMissing: 'cmh-hub-app.skill.frontmatterMissing',
  frontmatterInvalid: 'cmh-hub-app.skill.frontmatterInvalid',
  nameMissing: 'cmh-hub-app.skill.nameMissing',
  nameTooLong: 'cmh-hub-app.skill.nameTooLong',
  nameInvalid: 'cmh-hub-app.skill.nameInvalid',
  nameHyphen: 'cmh-hub-app.skill.nameHyphen',
  nameFolderMismatch: 'cmh-hub-app.skill.nameFolderMismatch',
  nameReserved: 'cmh-hub-app.skill.nameReserved',
  descriptionMissing: 'cmh-hub-app.skill.descriptionMissing',
  descriptionTooLong: 'cmh-hub-app.skill.descriptionTooLong',
  descriptionXml: 'cmh-hub-app.skill.descriptionXml',
  licenseInvalid: 'cmh-hub-app.skill.licenseInvalid',
  compatibilityInvalid: 'cmh-hub-app.skill.compatibilityInvalid',
  metadataInvalid: 'cmh-hub-app.skill.metadataInvalid',
  allowedToolsInvalid: 'cmh-hub-app.skill.allowedToolsInvalid',
} as const;
export type SkillErrorKey = (typeof SKILL_ERROR)[keyof typeof SKILL_ERROR];

export interface SkillManifest {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  /** 실험 칸 — 받아만 둔다(권한은 Guard 가 정한다 · 이 목록으로 허용하지 않는다) */
  allowedTools: string[];
  /** 프런트매터 다음 마크다운 · 에이전트가 스킬을 고른 뒤에만 싣는다 */
  body: string;
  hasScripts: boolean;
  /** hasScripts 일 때 Guard 도구 이름 `skill:<name>:script` · 아니면 null */
  scriptToolName: string | null;
}

export interface SkillValidation {
  ok: boolean;
  errors: SkillErrorKey[];
  /** 로그용 영문(모르는 키 등) — 설치는 막지 않는다 */
  warnings: string[];
  /** ok 일 때만 */
  manifest: SkillManifest | null;
}

export interface SkillSummary {
  name: string;
  description: string;
}

/** 글자 수 = 코드 포인트 수(한글 · 이모지 한 글자 = 1) */
export const charLength = (s: string): number => Array.from(s).length;

export const skillScriptToolName = (name: string): string => `skill:${name}:script`;

export type NameRule = 'missing' | 'tooLong' | 'invalid' | 'hyphen' | 'reserved';

/** name 규칙 — 프롬프트 파일(.prompt.md)도 같은 규칙을 쓴다(reserved=false) · 키는 부르는 쪽이 자기 것으로 바꾼다 */
export function nameRuleViolations(name: string, opts: { reserved: boolean }): NameRule[] {
  if (name === '') return ['missing'];
  const out: NameRule[] = [];
  if (charLength(name) > NAME_MAX) out.push('tooLong');
  if (!NAME_PATTERN.test(name)) {
    // 하이픈 자리만 틀린 것과 글자가 틀린 것을 가른다(사람이 고칠 곳이 다르다)
    out.push(/^[a-z0-9-]+$/.test(name) ? 'hyphen' : 'invalid');
  }
  if (opts.reserved && RESERVED_WORDS.some((w) => name.toLowerCase().includes(w))) out.push('reserved');
  return out;
}

const SKILL_NAME_ERROR: Record<NameRule, SkillErrorKey> = {
  missing: SKILL_ERROR.nameMissing,
  tooLong: SKILL_ERROR.nameTooLong,
  invalid: SKILL_ERROR.nameInvalid,
  hyphen: SKILL_ERROR.nameHyphen,
  reserved: SKILL_ERROR.nameReserved,
};

/** SKILL.md 글 + 폴더 이름 → 검증 결과. 파일을 읽지 않는 순수 함수 */
export function validateSkillManifest(skillMd: string, folderName: string, opts: { hasScripts: boolean } = { hasScripts: false }): SkillValidation {
  const errors: SkillErrorKey[] = [];
  const warnings: string[] = [];
  let data: Readonly<Record<string, FrontmatterValue>>;
  let body: string;
  try {
    const split = splitFrontmatter(skillMd);
    if (!split) return { ok: false, errors: [SKILL_ERROR.frontmatterMissing], warnings: [], manifest: null };
    data = parseYamlSubset(split.header, 2);
    body = split.body;
  } catch (e) {
    if (!(e instanceof FrontmatterError)) throw e;
    return { ok: false, errors: [SKILL_ERROR.frontmatterInvalid], warnings: [e.message], manifest: null };
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown frontmatter key "${key}" ignored`);
  }

  const rawName = data['name'];
  const name = isStringValue(rawName) ? rawName : '';
  if (rawName !== undefined && !isStringValue(rawName)) errors.push(SKILL_ERROR.nameInvalid);
  else {
    errors.push(...nameRuleViolations(name, { reserved: true }).map((r) => SKILL_NAME_ERROR[r]));
    if (name !== '' && name !== folderName) errors.push(SKILL_ERROR.nameFolderMismatch);
  }

  const rawDescription = data['description'];
  const description = isStringValue(rawDescription) ? rawDescription.trim() : '';
  if (description === '') errors.push(SKILL_ERROR.descriptionMissing);
  else {
    if (charLength(description) > DESCRIPTION_MAX) errors.push(SKILL_ERROR.descriptionTooLong);
    if (XML_TAG.test(description)) errors.push(SKILL_ERROR.descriptionXml);
  }

  const license = optionalString(data['license'], () => errors.push(SKILL_ERROR.licenseInvalid));
  const compatibility = optionalString(data['compatibility'], () => errors.push(SKILL_ERROR.compatibilityInvalid));
  if (compatibility !== null && (compatibility === '' || charLength(compatibility) > COMPATIBILITY_MAX)) {
    errors.push(SKILL_ERROR.compatibilityInvalid);
  }

  const rawMetadata = data['metadata'];
  let metadata: Record<string, string> = {};
  if (rawMetadata !== undefined) {
    if (isMapValue(rawMetadata)) metadata = { ...rawMetadata };
    else errors.push(SKILL_ERROR.metadataInvalid);
  }

  // 규격은 공백으로 나눈 글자 · Claude Code 문서 꼴은 목록 — 둘 다 받는다
  const rawTools = data['allowed-tools'];
  let allowedTools: string[] = [];
  if (isStringValue(rawTools)) allowedTools = rawTools.split(/\s+/).filter((t) => t !== '');
  else if (isListValue(rawTools)) allowedTools = [...rawTools];
  else if (rawTools !== undefined) errors.push(SKILL_ERROR.allowedToolsInvalid);

  if (errors.length > 0) return { ok: false, errors, warnings, manifest: null };
  return {
    ok: true,
    errors,
    warnings,
    manifest: {
      name,
      description,
      license,
      compatibility,
      metadata,
      allowedTools,
      body,
      hasScripts: opts.hasScripts,
      scriptToolName: opts.hasScripts ? skillScriptToolName(name) : null,
    },
  };
}

function optionalString(v: FrontmatterValue | undefined, onWrongType: () => void): string | null {
  if (v === undefined) return null;
  if (isStringValue(v)) return v.trim();
  onWrongType();
  return null;
}

/** 스킬 폴더 하나(`<dir>/SKILL.md` · `<dir>/scripts/`)를 읽어 검증. 폴더 이름 = 마지막 경로 조각 */
export async function readSkillFolder(dir: string): Promise<SkillValidation> {
  const folderName = path.basename(path.resolve(dir));
  let skillMd: string;
  try {
    skillMd = await readFile(path.join(dir, SKILL_FILE), 'utf8');
  } catch {
    return { ok: false, errors: [SKILL_ERROR.fileMissing], warnings: [], manifest: null };
  }
  const hasScripts = await stat(path.join(dir, SKILL_SCRIPTS_DIR)).then((s) => s.isDirectory(), () => false);
  return validateSkillManifest(skillMd, folderName, { hasScripts });
}

/** 에이전트에 먼저 싣는 것 — name + description 만(본문은 고른 뒤) */
export function summary(manifest: SkillManifest): SkillSummary {
  return { name: manifest.name, description: manifest.description };
}
