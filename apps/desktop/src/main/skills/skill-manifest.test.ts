import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSkillFolder, SKILL_ERROR, summary, validateSkillManifest } from './skill-manifest.js';

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
