// R4 — 서버 relay 공급자(유료 · 사장님 · 직원: 앱 → 서버 PHP → OpenRouter 등). 서버 키는 서버에만 있다 — 앱은 어드민 로그인 토큰 + 설치 서명으로 부른다.
// 부르는 수단 = 주입받은 transport — 앱에서는 `AppSession.call`(identity/app-session.ts · Bearer 어드민 토큰 + 서명 헤더 · POST JSON)을 넘긴다.
// 🔴 경로 확인 못 함(2026-10-07): 서버에 «앱이 어드민 토큰으로 모델 한 번 부르기» 경로를 찾지 못했다.
//   - `CmhAiAppModelRelay`(CmhAiAgent/src/Service/Chat/CmhAiAppModelRelay.php)는 반대 방향(서버 → 앱 작업 큐 · task-worker.ts)이다.
//   - `/api/cmh-ai/gateway/v1/chat/completions`(CmhAiGatewayController.php:56)는 OpenAI 호환이지만 인증이 «cmh 공급자 행의 키» Bearer
//     (`CmhAiGatewayService::isAuthorized`)라 AppSession.call 의 어드민 토큰으로는 401 일 것이다.
//   - `/api/_action/cmh-ai/chat`(CmhAiChatController.php:98)는 에이전트 대화(agent · message)라 모델 직접 호출이 아니다.
//   그래서 경로를 생성자 인자로 받는다. 서버 쪽 경로를 만들거나 고르는 일은 서버 PLAN 일감.
// 답 꼴은 OpenAI chat 응답(`choices[0].message.content` · `usage`)이라고 가정한다(서버 relay 가 검사하는 꼴과 같음 · CmhAiAppModelRelay::validateResponse).
// 스트림 없음 → reasoning? + delta + tool_call* + done.
import { errorText, FINISH_ABORTED, type ChatChunk, type ChatRequest, type ModelProvider } from '../model-provider.js';
import { completionToChunks } from './openai-response.js';

/** `AppSession.call` 꼴 — 로그인 전이면 null */
export type RelayTransport = (path: string, body: unknown) => Promise<{ status: number; data: unknown; appError: string | null } | null>;

export interface ServerRelayProviderOptions {
  id: string;
  transport: RelayTransport;
  /** 서버 경로(예 `/api/_action/…`) — 위 머리 주석 «경로 확인 못 함» */
  path: string;
}

export class ServerRelayProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'server-relay' as const;
  private readonly transport: RelayTransport;
  private readonly path: string;

  constructor(opts: ServerRelayProviderOptions) {
    this.id = opts.id;
    this.transport = opts.transport;
    this.path = opts.path;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: false };
    if (req.tools && req.tools.length > 0) body['tools'] = req.tools;
    if (req.max_tokens !== undefined) body['max_tokens'] = req.max_tokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.reasoning !== undefined) body['reasoning'] = req.reasoning;

    let res: Awaited<ReturnType<RelayTransport>>;
    try {
      res = await this.transport(this.path, body);
    } catch (e) {
      yield { type: 'error', message: `서버 relay 실패: ${errorText(e)}` };
      return;
    }
    // transport 는 중간에 멈출 수 없다 — 기다리는 동안 중단됐으면 답을 버린다
    if (signal?.aborted) {
      yield { type: 'done', finishReason: FINISH_ABORTED };
      return;
    }
    if (res === null) {
      yield { type: 'error', message: '서버 relay: 로그인 전입니다(어드민 토큰 없음)' };
      return;
    }
    if (res.status >= 400) {
      const msg = (res.data as { message?: unknown } | null)?.message;
      const detail = typeof msg === 'string' ? `: ${msg.slice(0, 300)}` : '';
      yield { type: 'error', message: `서버 relay HTTP ${res.status}${res.appError ? ` (${res.appError})` : ''}${detail}` };
      return;
    }
    yield* completionToChunks(res.data, '서버 relay');
  }
}
