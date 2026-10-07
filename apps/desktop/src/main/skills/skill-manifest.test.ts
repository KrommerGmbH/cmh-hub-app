import { chmodSync, mkdirSync, mkdtempSync as mkdtempRaw, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  readSkillFolder,
  scanSkillFolder,
  SKILL_ERROR,
  SKILL_SCAN_MAX_DEPTH,
  SKILL_SCAN_MAX_ENTRIES,
  SKILL_WARNING,
  summary,
  validateSkillManifest,
} from './skill-manifest.js';

const fixtureDir = (name: string): string => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
const skillMd = (front: string, body = '# 본문\n'): string => `---\n${front}\n---\n${body}`;
const errorsOf = (front: string, folder: string): string[] => validateSkillManifest(skillMd(front), folder).errors;

describe('SKILL.md 검증(R3-a · Agent Skills 규격 + Anthropic 문서)', () => {
  it('고정 폴더 pdf-tools — 선택 칸 · scripts/ → Guard 도구 이름', async () => {
    const r = await readSkillFolder(fixtureDir('pdf-tools'));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest).toMatchObject({
      name: 'pdf-tools',
      license: 'Apache-2.0',
      compatibility: 'Requires python3 on PATH',
      metadata: { author: 'cmh-test', version: '1.0' },
      allowedTools: ['Bash(python3:*)', 'Read'],
      hasScripts: true,
      scriptToolName: 'skill:pdf-tools:script',
    });
    expect(r.manifest?.body).toContain('# PDF tools');
  });

  it('고정 폴더 meeting-notes — CRLF · 따옴표 description · scripts/ 없음', async () => {
    const r = await readSkillFolder(fixtureDir('meeting-notes'));
    expect(r.ok).toBe(true);
    expect(r.manifest).toMatchObject({ name: 'meeting-notes', hasScripts: false, scriptToolName: null, license: null, metadata: {}, allowedTools: [] });
    expect(r.manifest?.description).toBe('Turn a meeting transcript into notes: decisions, owners, dates.');
  });

  it('summary() 는 name + description 만(토큰 절약)', async () => {
    const r = await readSkillFolder(fixtureDir('pdf-tools'));
    expect(Object.keys(summary(r.manifest!))).toEqual(['name', 'description']);
  });

  it('SKILL.md 가 없는 폴더 = fileMissing', async () => {
    const r = await readSkillFolder(fixtureDir('no-such-skill'));
    expect(r).toMatchObject({ ok: false, errors: [SKILL_ERROR.fileMissing], manifest: null });
  });

  it('name 규칙 위반을 하나씩 거부한다', () => {
    expect(errorsOf('name: Pdf-Tools\ndescription: x', 'Pdf-Tools')).toEqual([SKILL_ERROR.nameInvalid]);
    expect(errorsOf('name: pdf_tools\ndescription: x', 'pdf_tools')).toEqual([SKILL_ERROR.nameInvalid]);
    expect(errorsOf('name: pdf--tools\ndescription: x', 'pdf--tools')).toEqual([SKILL_ERROR.nameHyphen]);
    expect(errorsOf('name: -pdf\ndescription: x', '-pdf')).toEqual([SKILL_ERROR.nameHyphen]);
    expect(errorsOf('name: pdf-\ndescription: x', 'pdf-')).toEqual([SKILL_ERROR.nameHyphen]);
    expect(errorsOf('name: pdf-tools\ndescription: x', 'pdf-tool')).toEqual([SKILL_ERROR.nameFolderMismatch]);
    expect(errorsOf('name: claude-helper\ndescription: x', 'claude-helper')).toEqual([SKILL_ERROR.nameReserved]);
    expect(errorsOf('name: my-anthropic-kit\ndescription: x', 'my-anthropic-kit')).toEqual([SKILL_ERROR.nameReserved]);
    const long = 'a'.repeat(65);
    expect(errorsOf(`name: ${long}\ndescription: x`, long)).toEqual([SKILL_ERROR.nameTooLong]);
    expect(errorsOf('description: x', 'x')).toEqual([SKILL_ERROR.nameMissing]);
    expect(errorsOf('name: "<b>x</b>"\ndescription: x', '<b>x</b>')).toEqual([SKILL_ERROR.nameInvalid]);
    expect(errorsOf('name:\n  - a\ndescription: x', 'a')).toEqual([SKILL_ERROR.nameInvalid]);
  });

  it('64자 name · 1024자 description 은 통과(경계)', () => {
    const name = 'a'.repeat(64);
    expect(errorsOf(`name: ${name}\ndescription: ${'d'.repeat(1024)}`, name)).toEqual([]);
    expect(errorsOf(`name: ko\ndescription: ${'가'.repeat(1024)}`, 'ko')).toEqual([]);
  });

  it('description — 없음 · 1025자 · XML 태그 거부', () => {
    expect(errorsOf('name: a', 'a')).toEqual([SKILL_ERROR.descriptionMissing]);
    expect(errorsOf('name: a\ndescription: ""', 'a')).toEqual([SKILL_ERROR.descriptionMissing]);
    expect(errorsOf(`name: a\ndescription: ${'d'.repeat(1025)}`, 'a')).toEqual([SKILL_ERROR.descriptionTooLong]);
    expect(errorsOf('name: a\ndescription: Use <instructions> here', 'a')).toEqual([SKILL_ERROR.descriptionXml]);
    expect(errorsOf('name: a\ndescription: "Close </system> tag"', 'a')).toEqual([SKILL_ERROR.descriptionXml]);
    // 비교 기호는 태그가 아니다
    expect(errorsOf('name: a\ndescription: Use when size < 10 and > 2', 'a')).toEqual([]);
  });

  it('선택 칸 꼴 — compatibility 501자 · metadata 글자 · allowed-tools 맵', () => {
    expect(errorsOf(`name: a\ndescription: x\ncompatibility: ${'c'.repeat(501)}`, 'a')).toEqual([SKILL_ERROR.compatibilityInvalid]);
    expect(errorsOf('name: a\ndescription: x\nmetadata: flat', 'a')).toEqual([SKILL_ERROR.metadataInvalid]);
    expect(errorsOf('name: a\ndescription: x\nlicense:\n  - MIT', 'a')).toEqual([SKILL_ERROR.licenseInvalid]);
    expect(errorsOf('name: a\ndescription: x\nallowed-tools:\n  k: v', 'a')).toEqual([SKILL_ERROR.allowedToolsInvalid]);
    const listTools = validateSkillManifest(skillMd('name: a\ndescription: x\nallowed-tools:\n  - Read\n  - Grep'), 'a');
    expect(listTools.manifest?.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('프런트매터 없음 · 깨짐 · 모르는 키(경고만)', () => {
    expect(validateSkillManifest('# no frontmatter', 'a').errors).toEqual([SKILL_ERROR.frontmatterMissing]);
    expect(validateSkillManifest('---\nname: [a]\n---\n', 'a').errors).toEqual([SKILL_ERROR.frontmatterInvalid]);
    const r = validateSkillManifest(skillMd('name: a\ndescription: x\ndisable-model-invocation: true'), 'a');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['Unknown frontmatter key "disable-model-invocation" ignored']);
  });
});

const tempRoots: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const dir = mkdtempRaw(prefix);
  tempRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/** 임시 스킬 폴더 — files 의 키는 상대 경로 · 값은 글(SKILL.md 는 자동) */
const makeSkill = (name: string, files: Record<string, string> = {}): string => {
  const base = mkdtempSync(join(tmpdir(), 'cmh-skill-'));
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n# body\n`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};
const posix = process.platform !== 'win32';

describe('검수 차단 7 — description 1000 대 1024(서버 칸 String(1000))', () => {
  it('1001~1024자는 통과하되 warnings 에 descriptionTooLongForServer · 1000자는 경고 없음 · 1025자는 오류', () => {
    for (const n of [1001, 1024]) {
      const r = validateSkillManifest(skillMd(`name: a\ndescription: ${'d'.repeat(n)}`), 'a');
      expect(r.ok, String(n)).toBe(true);
      expect(r.warnings).toEqual([SKILL_WARNING.descriptionTooLongForServer]);
    }
    expect(validateSkillManifest(skillMd(`name: a\ndescription: ${'d'.repeat(1000)}`), 'a').warnings).toEqual([]);
    expect(errorsOf(`name: a\ndescription: ${'d'.repeat(1025)}`, 'a')).toEqual([SKILL_ERROR.descriptionTooLong]);
  });
});

describe('검수 차단 8 — scripts/ 판정 우회 · 심볼릭 링크', () => {
  it('대소문자 다른 Scripts/ · BIN/ 폴더 → hasScripts', async () => {
    for (const rel of ['Scripts/run.txt', 'SCRIPTS/a.txt', 'BIN/tool.txt', 'nested/deep/bin/x.txt']) {
      const r = await readSkillFolder(makeSkill('case-skill', { [rel]: 'x' }));
      expect(r.ok, rel).toBe(true);
      expect(r.manifest?.hasScripts, rel).toBe(true);
      expect(r.manifest?.scriptToolName).toBe('skill:case-skill:script');
    }
  });

  it('루트 · 하위 폴더의 실행 확장자(.sh .py .js .ps1 .bat .exe … 대문자 포함) → hasScripts', async () => {
    for (const rel of ['run.sh', 'tool.PY', 'lib/a.mjs', 'x.ps1', 'y.BAT', 'z.exe', 'w.vbs', 'v.php', 'docs/u.ts']) {
      expect((await readSkillFolder(makeSkill('ext-skill', { [rel]: 'x' }))).manifest?.hasScripts, rel).toBe(true);
    }
    expect((await readSkillFolder(makeSkill('plain-skill', { 'docs/readme.md': 'x', 'data.json': '{}' }))).manifest?.hasScripts).toBe(false);
  });

  it.runIf(posix)('실행 비트(POSIX)가 있는 확장자 없는 파일 → hasScripts', async () => {
    const dir = makeSkill('exec-skill', { 'tool': '#!/bin/sh\necho hi\n' });
    chmodSync(join(dir, 'tool'), 0o755);
    expect((await readSkillFolder(dir)).manifest?.hasScripts).toBe(true);
    expect((await scanSkillFolder(dir, 'win32')).hasScripts).toBe(false);
  });

  it.runIf(posix)('심볼릭 링크가 하나라도 있으면 거부 — SKILL.md · 하위 파일 · 폴더 · 루트', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cmh-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: link-md\ndescription: x\n---\n');

    const linkMd = join(mkdtempSync(join(tmpdir(), 'cmh-skill-')), 'link-md');
    mkdirSync(linkMd);
    symlinkSync(join(outside, 'SKILL.md'), join(linkMd, 'SKILL.md'));
    expect((await readSkillFolder(linkMd)).errors).toEqual([SKILL_ERROR.symlink]);

    const linkFile = makeSkill('link-file');
    symlinkSync(join(outside, 'secret.txt'), join(linkFile, 'notes.txt'));
    expect((await readSkillFolder(linkFile)).errors).toEqual([SKILL_ERROR.symlink]);

    const linkDir = makeSkill('link-scripts');
    symlinkSync(outside, join(linkDir, 'scripts'));
    expect((await readSkillFolder(linkDir)).errors).toEqual([SKILL_ERROR.symlink]);

    const real = makeSkill('link-root');
    const rootLink = join(mkdtempSync(join(tmpdir(), 'cmh-skill-')), 'link-root');
    symlinkSync(real, rootLink);
    expect((await readSkillFolder(rootLink)).errors).toEqual([SKILL_ERROR.symlink]);
  });

  it(`깊이 ${SKILL_SCAN_MAX_DEPTH} 초과 = tooDeep · 깊이 ${SKILL_SCAN_MAX_DEPTH} 까지는 통과`, async () => {
    const ok = Array(SKILL_SCAN_MAX_DEPTH - 1).fill('d').join('/') + '/f.txt';
    expect((await readSkillFolder(makeSkill('deep-ok', { [ok]: 'x' }))).ok).toBe(true);
    const deep = Array(SKILL_SCAN_MAX_DEPTH).fill('d').join('/') + '/f.txt';
    expect((await readSkillFolder(makeSkill('deep-bad', { [deep]: 'x' }))).errors).toEqual([SKILL_ERROR.tooDeep]);
  });

  it(`항목 ${SKILL_SCAN_MAX_ENTRIES} 개 초과 = tooManyFiles`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < SKILL_SCAN_MAX_ENTRIES; i += 1) files[`f${i}.txt`] = '';
    expect((await readSkillFolder(makeSkill('many-files', files))).errors).toEqual([SKILL_ERROR.tooManyFiles]);
  });

  it('SKILL.md 256KB 초과 = fileTooLarge(파일 크기 · 글 크기 둘 다)', async () => {
    const dir = makeSkill('big-md');
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: big-md\ndescription: x\n---\n${'x'.repeat(256 * 1024)}`);
    expect((await readSkillFolder(dir)).errors).toEqual([SKILL_ERROR.fileTooLarge]);
    expect(validateSkillManifest(`---\nname: a\ndescription: x\n---\n${'x'.repeat(256 * 1024)}`, 'a').errors).toEqual([SKILL_ERROR.fileTooLarge]);
  });

  it('description: > 블록 · 여러 줄 plain 도 읽는다', () => {
    expect(validateSkillManifest('---\nname: s\ndescription: >\n  folded\n  text\n---\n', 's').manifest?.description).toBe('folded text');
    expect(validateSkillManifest('---\nname: s\ndescription: first line\n  continues here\n---\n', 's').manifest?.description).toBe('first line continues here');
  });
});
