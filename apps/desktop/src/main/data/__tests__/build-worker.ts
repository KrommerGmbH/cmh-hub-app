// 시험 전용(빌드에서 빠짐 · tsconfig exclude `src/**/__tests__/**`) — data-worker.ts 와 그것이 import 하는 .ts 만 JS 로 내보낸다.
// Node fork 는 .ts 를 못 돌린다(NodeNext 의 './x.js' 지정자 · 매개변수 속성). 앱 빌드(tsc → dist)와 같은 설정으로 따로 낸다.
// 나오는 곳: apps/desktop/node_modules/.cache/… — 그 위로 올라가며 '@cmh-hub-app/data' 를 찾을 수 있어야 해서(OS 임시 폴더는 못 찾는다).
// node_modules 아래는 package.json "type" 을 위에서 물려받지 못하므로 {"type":"module"} 을 한 장 둔다.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DESKTOP_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC_DIR = join(DESKTOP_DIR, 'src');
const ENTRY = join(SRC_DIR, 'main', 'data', 'data-worker.ts');

export interface BuiltWorker {
  /** 내보낸 폴더(지울 때 · ps 로 남은 자식을 찾을 때) */
  readonly outDir: string;
  /** fork 할 진입 파일 */
  readonly workerPath: string;
  dispose(): void;
}

export function buildDataWorker(): BuiltWorker {
  const outDir = join(DESKTOP_DIR, 'node_modules', '.cache', `cmh-data-worker-test-${process.pid}-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'package.json'), '{"type":"module"}\n');
  const program = ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
    rootDir: SRC_DIR,
    outDir,
    noEmitOnError: true,
  });
  const result = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
  if (result.emitSkipped || diagnostics.length > 0) {
    const text = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => DESKTOP_DIR,
      getNewLine: () => '\n',
    });
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(`data-worker build failed:\n${text}`);
  }
  return {
    outDir,
    workerPath: join(outDir, 'main', 'data', 'data-worker.js'),
    dispose: () => rmSync(outDir, { recursive: true, force: true }),
  };
}
