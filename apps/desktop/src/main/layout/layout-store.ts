// U05 — userData/layout.json 저장 · 복원. 500ms debounce · tmp 에 쓰고 rename(쓰다 죽어도 옛 파일은 산다).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LayoutTree } from '@cmh-hub-app/contracts';

export class LayoutStore {
  private timer: NodeJS.Timeout | null = null;
  private pending: LayoutTree | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = 500,
  ) {}

  /** 파일이 없거나 JSON 이 깨졌거나 version 이 1 이 아니면 null — 모양 검사는 LayoutEngine.loadTree 가 한다 */
  async load(): Promise<LayoutTree | null> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const json: unknown = JSON.parse(text);
      if (typeof json !== 'object' || json === null || (json as { version?: unknown }).version !== 1) return null;
      return json as LayoutTree;
    } catch {
      return null;
    }
  }

  save(tree: LayoutTree): void {
    this.pending = tree;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  /** 미룬 저장을 지금 쓴다(앱 종료 때) */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tree = this.pending;
    this.pending = null;
    if (tree) this.writing = this.writing.then(() => this.write(tree));
    await this.writing;
  }

  private async write(tree: LayoutTree): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(tree, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
