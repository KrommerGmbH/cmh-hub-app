// 폴더를 끝까지 lstat 으로 훑는다(링크를 따라가지 않는다) — 플러그인 샌드박스 검사(검수 3 차단 7)가 쓴다.
// skills/skill-manifest.ts 의 scanSkillFolder 와 같은 방식(깊이 · 항목 상한 · 심볼릭 링크 · 특수 파일 거부)이지만,
// 그 파일은 다른 담당 몫이라 고치지 않고 여기 공용으로 따로 둔다(스킬 쪽을 이것으로 바꾸는 것은 다음 차례).
// 왜 링크를 거부하나: Node 권한 모델(--allow-fs-read=<폴더>)은 심볼릭 링크를 따라간다 — 폴더 안 `data -> /바깥` 링크로 밖을 읽는다(rv3 실측).
// 하드링크(nlink > 1 인 파일)는 경로로는 구별할 수 없어(같은 파일) 거부하지 않고 경고만 낸다 — 폴더 밖 어딘가와 같은 내용을 공유한다는 뜻.

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const FOLDER_SCAN_MAX_DEPTH = 16;
export const FOLDER_SCAN_MAX_ENTRIES = 5_000;

export type FolderScanProblemKind = 'symlink' | 'special' | 'tooDeep' | 'tooMany' | 'notDirectory';

export interface FolderScanProblem {
  readonly kind: FolderScanProblemKind;
  /** 루트 기준 상대경로('' = 루트 자신) */
  readonly path: string;
}

export interface FolderScanResult {
  /** 첫 문제 — 있으면 거부할 것 */
  readonly problem: FolderScanProblem | null;
  /** nlink > 1 인 파일(루트 기준 상대경로) */
  readonly hardLinks: readonly string[];
  /** 훑은 항목 수(폴더 + 파일 · 루트 제외) */
  readonly entries: number;
}

export interface FolderScanLimits {
  /** 깊이 = 루트 0 · 바로 아래 항목 1 · 기본 16 */
  readonly maxDepth?: number;
  /** 기본 5000 */
  readonly maxEntries?: number;
}

/** 루트 자체가 링크여도 거부한다(부르는 쪽이 realpath 로 푼 폴더를 넘길 것) */
export async function scanFolderNoFollow(dir: string, limits: FolderScanLimits = {}): Promise<FolderScanResult> {
  const maxDepth = limits.maxDepth ?? FOLDER_SCAN_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? FOLDER_SCAN_MAX_ENTRIES;
  const hardLinks: string[] = [];
  const root = await lstat(dir);
  if (root.isSymbolicLink()) return { problem: { kind: 'symlink', path: '' }, hardLinks, entries: 0 };
  if (!root.isDirectory()) return { problem: { kind: 'notDirectory', path: '' }, hardLinks, entries: 0 };
  let entries = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const names = await readdir(current.dir);
    for (const name of names) {
      entries += 1;
      const full = path.join(current.dir, name);
      const rel = path.relative(dir, full);
      if (entries > maxEntries) return { problem: { kind: 'tooMany', path: rel }, hardLinks, entries };
      const depth = current.depth + 1;
      if (depth > maxDepth) return { problem: { kind: 'tooDeep', path: rel }, hardLinks, entries };
      const st = await lstat(full);
      if (st.isSymbolicLink()) return { problem: { kind: 'symlink', path: rel }, hardLinks, entries };
      if (st.isDirectory()) {
        stack.push({ dir: full, depth });
      } else if (st.isFile()) {
        if (st.nlink > 1) hardLinks.push(rel);
      } else {
        // FIFO · 소켓 · 장치 — 읽다가 멈추거나 이상하게 읽힌다
        return { problem: { kind: 'special', path: rel }, hardLinks, entries };
      }
    }
  }
  return { problem: null, hardLinks, entries };
}
