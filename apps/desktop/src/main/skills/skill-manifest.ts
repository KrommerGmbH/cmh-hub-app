// R3-a — Agent Skills `SKILL.md` 검증(설치 전에). electron 을 import 하지 않는다 · 폴더 읽기만 node:fs.
// 근거(research/04 §2): 열린 규격 agentskills `docs/specification.mdx` — `name` 1–64 · a-z 0-9 하이픈 · 시작·끝 하이픈 금지 · `--` 금지
//   · 부모 폴더명과 같음 · `description` ≤1024 · 선택 `license` · `compatibility`(≤500) · `metadata` · `allowed-tools`(실험)
//   + Anthropic 문서 — `name` XML 금지 · 예약어 "anthropic" · "claude" 금지 · `description` XML 태그 금지.
// 합의안 권고: 실행할 수 있는 것이 있으면(hasScripts) 설치 때 사람 확인 · 실행은 Guard 도구 `skill:<name>:script` · 토큰 절약으로 먼저 싣는 것은 name+description 만.
// 검수 차단 8: hasScripts 는 `scripts/` 하나만 보지 않는다 — 폴더 전체를 lstat 으로 훑어 대소문자 무시 `scripts`·`bin` 폴더 · 실행 비트(POSIX)
//   · 실행 확장자 중 하나라도 있으면 true. 심볼릭 링크(SKILL.md 포함)가 하나라도 있으면 설치 거부(폴더 밖 파일을 끌어들이지 못하게).
// errors 는 R8 스니펫 키 그대로(화면 글자) — 규칙 하나에 키 하나.
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  FRONTMATTER_MAX_BYTES,
  FrontmatterError,
  FrontmatterTooLargeError,
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
/** 서버 `cmh_ai_skill_translation.description` String(1000) — 넘으면 경고만(규격 1024 까지는 받는다) */
export const SERVER_DESCRIPTION_MAX = 1000;
/** SKILL.md 크기 상한(프런트매터 공용 상한과 같다) */
export const SKILL_FILE_MAX_BYTES = FRONTMATTER_MAX_BYTES;
/** 폴더 훑기 상한 — 넘으면 오류(설치 거부) */
export const SKILL_SCAN_MAX_DEPTH = 8;
export const SKILL_SCAN_MAX_ENTRIES = 2000;
/** 실행할 수 있는 것으로 보는 폴더 이름(대소문자 무시) · 확장자(소문자) */
export const SCRIPT_DIR_NAMES: ReadonlySet<string> = new Set(['scripts', 'bin']);
export const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.ps1', '.psm1',
  '.bat', '.cmd', '.exe', '.com', '.vbs', '.rb', '.pl', '.php',
]);
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
  fileTooLarge: 'cmh-hub-app.skill.fileTooLarge',
  symlink: 'cmh-hub-app.skill.symlink',
  specialFile: 'cmh-hub-app.skill.specialFile',
  tooDeep: 'cmh-hub-app.skill.tooDeep',
  tooManyFiles: 'cmh-hub-app.skill.tooManyFiles',
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

/** warnings 에 그대로 들어가는 스니펫 키(설치는 막지 않는다) */
export const SKILL_WARNING = {
  // ⏸ 사장님 결정: 경고 대 오류 — 지금은 경고(규격 1024 는 받고 서버 칸 1000 을 넘으면 알린다 · 서버 저장 때 잘림/거부는 R3-b 몫)
  descriptionTooLongForServer: 'cmh-hub-app.skill.descriptionTooLongForServer',
} as const;

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
  /** 로그용 영문(모르는 키 등) 또는 SKILL_WARNING 스니펫 키 — 설치는 막지 않는다 */
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
    if (e instanceof FrontmatterTooLargeError) return { ok: false, errors: [SKILL_ERROR.fileTooLarge], warnings: [e.message], manifest: null };
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
    const length = charLength(description);
    if (length > DESCRIPTION_MAX) errors.push(SKILL_ERROR.descriptionTooLong);
    else if (length > SERVER_DESCRIPTION_MAX) warnings.push(SKILL_WARNING.descriptionTooLongForServer);
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

export interface SkillFolderScan {
  /** 훑기를 막은 오류(심볼릭 링크 · 특수 파일 · 깊이 · 개수) · 없으면 null */
  error: SkillErrorKey | null;
  hasScripts: boolean;
  /** 훑은 항목 수(폴더 + 파일 · 루트 제외) */
  entries: number;
}

const isExecutableName = (name: string): boolean => SCRIPT_EXTENSIONS.has(path.extname(name).toLowerCase());

/**
 * 스킬 폴더를 끝까지 lstat 으로 훑는다(링크를 따라가지 않는다). 루트 자체가 링크여도 거부.
 * 깊이 = 루트 0 · 바로 아래 항목 1. 깊이 SKILL_SCAN_MAX_DEPTH 를 넘는 항목 · 항목 SKILL_SCAN_MAX_ENTRIES 개 초과는 오류.
 * hasScripts: 대소문자 무시 scripts/bin 폴더 · (win32 가 아니면) 실행 비트 있는 파일 · SCRIPT_EXTENSIONS 확장자.
 */
export async function scanSkillFolder(dir: string, platform: NodeJS.Platform = process.platform): Promise<SkillFolderScan> {
  const root = await lstat(dir);
  if (root.isSymbolicLink()) return { error: SKILL_ERROR.symlink, hasScripts: false, entries: 0 };
  if (!root.isDirectory()) return { error: SKILL_ERROR.fileMissing, hasScripts: false, entries: 0 };
  let hasScripts = false;
  let entries = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop() as { dir: string; depth: number };
    const names = await readdir(current.dir);
    for (const name of names) {
      entries += 1;
      if (entries > SKILL_SCAN_MAX_ENTRIES) return { error: SKILL_ERROR.tooManyFiles, hasScripts, entries };
      const depth = current.depth + 1;
      if (depth > SKILL_SCAN_MAX_DEPTH) return { error: SKILL_ERROR.tooDeep, hasScripts, entries };
      const full = path.join(current.dir, name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) return { error: SKILL_ERROR.symlink, hasScripts, entries };
      if (st.isDirectory()) {
        if (SCRIPT_DIR_NAMES.has(name.toLowerCase())) hasScripts = true;
        stack.push({ dir: full, depth });
      } else if (st.isFile()) {
        if (isExecutableName(name)) hasScripts = true;
        if (platform !== 'win32' && (st.mode & 0o111) !== 0) hasScripts = true;
      } else {
        // FIFO · 소켓 · 장치 — 읽다가 멈추거나 이상하게 읽힌다
        return { error: SKILL_ERROR.specialFile, hasScripts, entries };
      }
    }
  }
  return { error: null, hasScripts, entries };
}

/** SKILL.md 를 링크를 따라가지 않고(O_NOFOLLOW · 열고 나서 크기 확인) 읽는다 */
async function readSkillFile(file: string): Promise<{ text: string } | { error: SkillErrorKey }> {
  let st;
  try {
    st = await lstat(file);
  } catch {
    return { error: SKILL_ERROR.fileMissing };
  }
  if (st.isSymbolicLink()) return { error: SKILL_ERROR.symlink };
  if (!st.isFile()) return { error: SKILL_ERROR.fileMissing };
  if (st.size > SKILL_FILE_MAX_BYTES) return { error: SKILL_ERROR.fileTooLarge };
  // lstat 과 open 사이에 링크로 바뀌는 것(TOCTOU)까지 막는다 — Windows 에는 O_NOFOLLOW 가 없어 0
  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    return { error: SKILL_ERROR.symlink };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { error: SKILL_ERROR.fileMissing };
    if (opened.size > SKILL_FILE_MAX_BYTES) return { error: SKILL_ERROR.fileTooLarge };
    return { text: await handle.readFile({ encoding: 'utf8' }) };
  } finally {
    await handle.close();
  }
}

/** 스킬 폴더 하나를 훑고(scanSkillFolder) `<dir>/SKILL.md` 를 읽어 검증. 폴더 이름 = 마지막 경로 조각 */
export async function readSkillFolder(dir: string): Promise<SkillValidation> {
  const folderName = path.basename(path.resolve(dir));
  const fail = (error: SkillErrorKey): SkillValidation => ({ ok: false, errors: [error], warnings: [], manifest: null });
  const file = await readSkillFile(path.join(dir, SKILL_FILE));
  if ('error' in file) return fail(file.error);
  let scan: SkillFolderScan;
  try {
    scan = await scanSkillFolder(dir);
  } catch {
    return fail(SKILL_ERROR.fileMissing);
  }
  if (scan.error !== null) return fail(scan.error);
  return validateSkillManifest(file.text, folderName, { hasScripts: scan.hasScripts });
}

/** 에이전트에 먼저 싣는 것 — name + description 만(본문은 고른 뒤) */
export function summary(manifest: SkillManifest): SkillSummary {
  return { name: manifest.name, description: manifest.description };
}
