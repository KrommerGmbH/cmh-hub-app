// W04 — 업체 PC 의 로컬 모델 엔진. 서버가 만든 OpenAI chat 요청 JSON 을 받아 OpenAI 모양 응답을 돌려준다.
// 엔진 = node-llama-cpp(llama.cpp 바인딩 · MIT · Windows Vulkan/CUDA/CPU 바이너리를 npm 이 같이 깐다 · Electron main 에서만 쓴다 — 문서 guide/electron.md).
// 모델 = GGUF(예 hf:<org>/<repo>:Q4_K_M) — 앱 userData/models 에 내려받는다. 모델을 «부르는 논리»는 서버에만 있다(코드 한 곳).
import { getLlama, LlamaChatSession, resolveModelFile, type ChatHistoryItem, type Llama, type LlamaModel } from 'node-llama-cpp';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  /** GGUF 모델 URI — 예 `hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M` */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: 0; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface EngineInfo {
  gpu: string | false;
  models: string[];
}

export class LocalLlmEngine {
  private llama: Llama | null = null;
  private readonly loaded = new Map<string, LlamaModel>();

  constructor(private readonly modelsDir: string) {}

  /** 첫 호출 때 엔진을 올린다 — GPU 는 node-llama-cpp 가 고른다(CUDA → Vulkan → CPU) */
  async info(): Promise<EngineInfo> {
    const llama = await this.getLlama();
    return { gpu: llama.gpu, models: [...this.loaded.keys()] };
  }

  /** 모델을 미리 받아 둔다(W03 동의 뒤 · 진행률 콜백) */
  async ensureModel(uri: string, onProgress?: (downloaded: number, total: number) => void): Promise<string> {
    return resolveModelFile(uri, {
      directory: this.modelsDir,
      cli: false,
      ...(onProgress ? { onProgress: ({ downloadedSize, totalSize }: { downloadedSize: number; totalSize: number }) => onProgress(downloadedSize, totalSize) } : {}),
    });
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    validateRequest(req);
    const model = await this.loadModel(req.model);
    const context = await model.createContext();
    try {
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      const { history, lastUser } = toChatHistory(req.messages);
      session.setChatHistory(history);
      const answer = await session.prompt(lastUser, {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_tokens !== undefined ? { maxTokens: req.max_tokens } : {}),
      });
      const promptTokens = model.tokenize(req.messages.map((m) => m.content).join('\n')).length;
      const completionTokens = model.tokenize(answer).length;
      return {
        id: `local-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };
    } finally {
      await context.dispose();
    }
  }

  async dispose(): Promise<void> {
    for (const m of this.loaded.values()) await m.dispose();
    this.loaded.clear();
    await this.llama?.dispose();
    this.llama = null;
  }

  private async getLlama(): Promise<Llama> {
    this.llama ??= await getLlama();
    return this.llama;
  }

  private async loadModel(uri: string): Promise<LlamaModel> {
    const hit = this.loaded.get(uri);
    if (hit) return hit;
    const modelPath = await this.ensureModel(uri);
    const model = await (await this.getLlama()).loadModel({ modelPath });
    this.loaded.set(uri, model);
    return model;
  }
}

export function validateRequest(req: ChatCompletionRequest): void {
  if (typeof req.model !== 'string' || !req.model.startsWith('hf:')) throw new Error('model 은 hf: GGUF URI 여야 합니다');
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new Error('messages 가 비었습니다');
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user') throw new Error('마지막 메시지는 user 여야 합니다');
}

/** OpenAI messages → node-llama-cpp 대화 기록 + 마지막 user 질문 */
export function toChatHistory(messages: ChatMessage[]): { history: ChatHistoryItem[]; lastUser: string } {
  const history: ChatHistoryItem[] = [];
  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  if (systemText) history.push({ type: 'system', text: systemText });
  const rest = messages.filter((m) => m.role !== 'system');
  const last = rest[rest.length - 1];
  for (const m of rest.slice(0, -1)) {
    if (m.role === 'user') history.push({ type: 'user', text: m.content });
    else history.push({ type: 'model', response: [m.content] });
  }
  return { history, lastUser: last?.content ?? '' };
}
