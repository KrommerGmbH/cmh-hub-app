// R4 — OpenAI chat 응답 JSON(stream 아님) → 조각. OpenAI 호환(stream 을 무시한 서버) · 서버 relay 가 같이 쓴다.
import type { ChatChunk, ChatUsage } from '../model-provider.js';

/** `usage` → ChatUsage(prompt/completion 이 숫자가 아니면 null) · `completion_tokens_details.reasoning_tokens` 가 있으면 생각 토큰 */
export function parseOpenAiUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return null;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

/** `choices[0].message` → reasoning? · delta? · tool_call* · done (message 가 없으면 error 하나) */
export function completionToChunks(data: unknown, label: string): ChatChunk[] {
  const choice = (data as { choices?: unknown[] } | null)?.choices?.[0] as
    | { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
    | undefined;
  if (!choice?.message) return [{ type: 'error', message: `${label} 답에 choices[0].message 가 없습니다` }];
  const out: ChatChunk[] = [];
  const m = choice.message;
  // 생각 글 칸 이름이 서버마다 다르다(DeepSeek·vLLM `reasoning_content` · OpenRouter `reasoning`)
  const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : typeof m.reasoning === 'string' ? m.reasoning : '';
  if (reasoning) out.push({ type: 'reasoning', text: reasoning });
  if (typeof m.content === 'string' && m.content) out.push({ type: 'delta', text: m.content });
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
      out.push({
        type: 'tool_call',
        id: typeof tc.id === 'string' ? tc.id : '',
        name: typeof tc.function?.name === 'string' ? tc.function.name : '',
        argumentsJson: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '',
      });
    }
  }
  const usage = parseOpenAiUsage((data as { usage?: unknown }).usage);
  out.push({ type: 'done', ...(usage ? { usage } : {}), finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop' });
  return out;
}
