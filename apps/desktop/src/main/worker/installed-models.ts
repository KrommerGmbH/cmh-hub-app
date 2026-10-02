// W04 — 내려받아 둔 GGUF 를 서버 모델 이름(hf: URI)으로 되돌린다. node-llama-cpp 파일 이름 규칙:
// hf:<org>/<repo>:<quant>  →  hf_<org>_<repo에서 -GGUF 뺀 것>.<quant>.gguf (실측 2026-10-02: hf_unsloth_gemma-4-E4B-it-qat.UD-Q4_K_XL.gguf)
import { existsSync, readdirSync } from 'node:fs';
import { APP_CONFIG } from '../../config.js';

export function ggufFileName(uri: string): string | null {
  const m = /^hf:([^/]+)\/(.+?):([^:]+)$/.exec(uri);
  if (!m) return null;
  const [, org, repo, quant] = m;
  return `hf_${org}_${repo!.replace(/-GGUF$/i, '')}.${quant}.gguf`;
}

export function installedLocalModels(modelsDir: string): string[] {
  if (!existsSync(modelsDir)) return [];
  const files = new Set(readdirSync(modelsDir));
  return Object.values(APP_CONFIG.localModels).filter((uri) => {
    const f = ggufFileName(uri);
    return f !== null && files.has(f);
  });
}
