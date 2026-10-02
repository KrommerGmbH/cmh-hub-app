import { describe, expect, it } from 'vitest';
import { ggufFileName } from './installed-models.js';

describe('ggufFileName', () => {
  it('node-llama-cpp 가 실제로 만든 파일 이름과 같다(2026-10-02 실측)', () => {
    expect(ggufFileName('hf:unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL')).toBe('hf_unsloth_gemma-4-E4B-it-qat.UD-Q4_K_XL.gguf');
    expect(ggufFileName('hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M')).toBe('hf_bartowski_SmolLM2-135M-Instruct.Q4_K_M.gguf');
    expect(ggufFileName('gemma3:4b')).toBeNull();
  });
});
