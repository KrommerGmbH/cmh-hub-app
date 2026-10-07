// 시험 전용(빌드에서 빠짐 · tsconfig exclude) — 메모리 SQLite 에 1차 엔티티 고정 자료를 심는다
import { DataSourceFactory, type DataSource } from '../repository.js';

/** 고정 id — 32자 hex */
export const hid = (n: number): string => n.toString(16).padStart(32, '0');

export const IDS = {
  p1: hid(1),
  p2: hid(2),
  p3: hid(3),
  m1: hid(0x11),
  m2: hid(0x12),
  m3: hid(0x13),
  m4: hid(0x14),
  m5: hid(0x15),
  s1: hid(0x21),
  t1: hid(0x31),
  t2: hid(0x32),
  c1: hid(0x41),
  msg1: hid(0x51),
  msg2: hid(0x52),
  msg3: hid(0x53),
  agent: hid(0x61),
} as const;

export const CREATED_AT = '2026-10-07T09:00:00.000Z';

export async function seededLocal(): Promise<DataSource> {
  const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:' });
  await ds.repository('cmh_ai_provider').upsert([
    {
      id: IDS.p1,
      code: 'openai',
      name: 'OpenAI',
      kind: 'remote',
      active: true,
      freeTier: false,
      dailyLimit: 1000,
      usedTodayDate: '2026-10-07',
      usedMinuteAt: '2026-10-07T12:34:56+02:00',
      apiKeyEnc: 'ENC:v10:secret-blob',
      createdAt: CREATED_AT,
    },
    { id: IDS.p2, code: 'local-gguf', name: 'Local GGUF', kind: 'local', active: true, freeTier: true, createdAt: CREATED_AT },
    { id: IDS.p3, code: 'old_provider', name: 'Old_Provider 100%', kind: 'remote', active: false, createdAt: CREATED_AT },
  ]);
  await ds.repository('cmh_ai_model').upsert([
    { id: IDS.m1, providerId: IDS.p1, code: 'gpt-5', label: 'GPT 5', contextWindow: 400000, priceInPerMtok: 1.25, thinking: true, toolCalling: true, lastSeenAt: '2026-10-06T08:00:00.000Z', createdAt: CREATED_AT },
    { id: IDS.m2, providerId: IDS.p1, code: 'gpt-5-mini', label: 'GPT 5 mini', contextWindow: 400000, priceInPerMtok: 0.25, thinking: true, lastSeenAt: '2026-10-07T08:00:00.000Z', createdAt: CREATED_AT },
    { id: IDS.m3, providerId: IDS.p2, code: 'gemma-4-e2b', label: 'Gemma 4 E2B', contextWindow: 128000, thinking: false, createdAt: CREATED_AT },
    { id: IDS.m4, providerId: IDS.p2, code: 'qwen3.5-0.8b', label: 'Qwen 3.5 0.8B', contextWindow: 32000, priceInPerMtok: 0, active: false, createdAt: CREATED_AT },
    { id: IDS.m5, providerId: IDS.p3, code: 'legacy', label: null, contextWindow: 8000, priceInPerMtok: 2.5, active: false, createdAt: CREATED_AT },
  ]);
  await ds.repository('cmh_ai_mcp_server').upsert([
    { id: IDS.s1, code: 'cmh-crawler', name: 'CMH Crawler', type: 'stdio', command: 'node', args: ['dist/index.js', '--port', 3000], envKeys: { PROXY: true }, createdAt: CREATED_AT },
  ]);
  await ds.repository('cmh_ai_mcp_tool').upsert([
    { id: IDS.t1, serverId: IDS.s1, name: 'crawler_fetch_product', parameters: { type: 'object', properties: { url: { type: 'string' } } }, createdAt: CREATED_AT },
    { id: IDS.t2, serverId: IDS.s1, name: 'crawler_list_adapters', needsApproval: true, createdAt: CREATED_AT },
  ]);
  await ds.repository('cmh_ai_conversation').upsert([{ id: IDS.c1, agentId: IDS.agent, counterpartType: 'user', title: '첫 대화', createdAt: CREATED_AT }]);
  await ds.repository('cmh_ai_conversation_message').upsert([
    { id: IDS.msg2, conversationId: IDS.c1, seq: 2, role: 'assistant', content: '안녕하세요', tokens: 12, createdAt: CREATED_AT },
    { id: IDS.msg1, conversationId: IDS.c1, seq: 1, role: 'user', content: '안녕', attachments: [{ kind: 'tab', viewId: 'v1' }], createdAt: CREATED_AT },
    { id: IDS.msg3, conversationId: IDS.c1, seq: 3, role: 'user', content: '모델 목록', createdAt: CREATED_AT },
  ]);
  return ds;
}

export function codes(elements: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return elements.map((e) => e['code']);
}
