import { describe, expect, it } from 'vitest';
import { toChatHistory, validateRequest } from './local-llm-engine.js';

describe('local-llm-engine 변환', () => {
  it('system 은 합쳐 맨 앞 · 마지막 user 는 prompt 로', () => {
    const { history, lastUser } = toChatHistory([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q2' },
    ]);
    expect(history).toEqual([
      { type: 'system', text: 'A\n\nB' },
      { type: 'user', text: 'q1' },
      { type: 'model', response: ['a1'] },
    ]);
    expect(lastUser).toBe('q2');
  });
  it('요청 검사 — hf: URI · 마지막은 user', () => {
    expect(() => validateRequest({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'x' }] })).toThrow(/hf:/);
    expect(() => validateRequest({ model: 'hf:a/b:Q4_K_M', messages: [] })).toThrow(/비었/);
    expect(() => validateRequest({ model: 'hf:a/b:Q4_K_M', messages: [{ role: 'assistant', content: 'x' }] })).toThrow(/user/);
    expect(() => validateRequest({ model: 'hf:a/b:Q4_K_M', messages: [{ role: 'user', content: 'x' }] })).not.toThrow();
  });
});
