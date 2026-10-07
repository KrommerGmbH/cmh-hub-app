import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanFolderNoFollow } from './folder-scan.js';

let base = '';
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'cmh-folder-scan-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('scanFolderNoFollow', () => {
  it('보통 폴더 — 문제 없음 · 항목 수', async () => {
    const dir = join(base, 'p');
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'f.txt'), 'x');
    expect(await scanFolderNoFollow(dir)).toEqual({ problem: null, hardLinks: [], entries: 3 });
  });

  it('깊은 곳의 심볼릭 링크(폴더 · 파일) · 루트 자체가 링크', async () => {
    const dir = join(base, 'p');
    await mkdir(join(dir, 'a'), { recursive: true });
    await symlink(base, join(dir, 'a', 'up'));
    expect((await scanFolderNoFollow(dir)).problem).toEqual({ kind: 'symlink', path: join('a', 'up') });
    await symlink(dir, join(base, 'root-link'));
    expect((await scanFolderNoFollow(join(base, 'root-link'))).problem).toEqual({ kind: 'symlink', path: '' });
  });

  it('하드링크는 문제 아님 · 목록에만', async () => {
    const dir = join(base, 'p');
    await mkdir(dir);
    await writeFile(join(base, 'outside.txt'), 's');
    await link(join(base, 'outside.txt'), join(dir, 'in.txt'));
    expect(await scanFolderNoFollow(dir)).toEqual({ problem: null, hardLinks: ['in.txt'], entries: 1 });
  });

  it('깊이 · 항목 상한', async () => {
    const dir = join(base, 'p');
    await mkdir(join(dir, '1', '2', '3'), { recursive: true });
    expect((await scanFolderNoFollow(dir, { maxDepth: 2 })).problem?.kind).toBe('tooDeep');
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}`), '');
    expect((await scanFolderNoFollow(dir, { maxEntries: 4 })).problem?.kind).toBe('tooMany');
  });
});
