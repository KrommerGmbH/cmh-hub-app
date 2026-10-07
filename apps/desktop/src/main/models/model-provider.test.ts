import { describe, expect, it } from 'vitest';
import { collectChat, isLocalKind, type ChatChunk } from './model-provider.js';

async function* chunks(list: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of list) yield c;
}

describe('collectChat', () => {
  it('글 · 생각 · 도구 · usage · 끝 이유 · 오류를 모은다(던지지 않음)', async () => {
    const r = await collectChat(
      chunks([
        { type: 'reasoning', text: '음' },
        { type: 'delta', text: '가' },
        { type: 'delta', text: '나' },
        { type: 'tool_call', id: 'c', name: 'f', argumentsJson: '{}' },
        { type: 'error', message: 'e1' },
        { type: 'error', message: 'e2' },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 2 }, finishReason: 'stop' },
      ]),
    );
    expect(r).toEqual({
      text: '가나',
      reasoning: '음',
      toolCalls: [{ id: 'c', name: 'f', argumentsJson: '{}' }],
      usage: { promptTokens: 1, completionTokens: 2 },
      finishReason: 'stop',
      error: 'e1\ne2',
    });
  });
  it('로컬 kind 는 gguf · onnx · laya', () => {
    expect(['gguf', 'onnx', 'laya', 'openai-compat', 'anthropic', 'server-relay'].map((k) => isLocalKind(k as never))).toEqual([true, true, true, false, false, false]);
  });
});
