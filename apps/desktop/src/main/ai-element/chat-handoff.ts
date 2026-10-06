// U10 — 고른 작업을 «AI 채팅» 탭(admin · #/cmh/ai/chat-solo)에 넘긴다. 사용자는 타자를 치지 않는다(2026-10-06 사장님 안 «클릭만»).
// 챗봇 = 서버 어드민 부품 cmh-ai-chat-frame 의 iframe(/bundles/cmhaiagent/chat-app/index.html · 같은 origin) 안 Vue 앱.
// 입력칸 · 보내기는 그 앱 소스에서 확인(2026-10-06): PromptInputArea.vue:318 → PromptInputTextarea.vue:76 textarea[name="message"] · 하네스 없으면 disabled(App.vue:876)
// · Enter(Shift · 조합 중 아님) → form.requestSubmit()(PromptInputTextarea.vue:20-33) · 보내기 단추 button[type="submit"][aria-label="Submit"](PromptInputSubmit.vue:49,53).
// 글은 키보드와 같은 길(sendInputEvent 클릭 → insertText → Enter 키 · U07 8-4)로 넣는다. 읽기는 isolated world(값 쓰기 0).
import { Notification, type WebContents } from 'electron';
import type { TabKind } from '@cmh-hub-app/contracts';
import { APP_CONFIG } from '../../config.js';
import { APP_DISPLAY_NAME, APP_ICON_PNG } from '../app-identity.js';
import type { AiActionItem, AiActionProvider } from '../context-menu.js';
import { intentsFor, type ElementInfo, type ElementIntent, type ElementIntentKey } from './element-intents.js';
import type { ScreenRecord } from './element-lookup.js';
import { maskPersonalData } from './mask.js';
import { readElementAtPoint } from './read-element.js';

/** 메뉴 없는 챗봇 길(CmhAiAgent cmh.ai.chat.solo) — admin-view.ts isAdminChatUrl · config.ts newTabChoices 와 같은 해시 */
export const CHAT_SOLO_HASH = '#/cmh/ai/chat-solo';
/** «+» 메뉴의 «AI 채팅» 주소 — 없으면 서버 어드민 + 해시 */
export const CHAT_TAB_URL: string = APP_CONFIG.newTabChoices.find((c) => c.kind === 'admin' && c.url.includes(CHAT_SOLO_HASH))?.url ?? `${APP_CONFIG.serverOrigin}${APP_CONFIG.adminPath}${CHAT_SOLO_HASH}`;

export function isChatTabUrl(url: string): boolean {
  return url.startsWith(APP_CONFIG.serverOrigin + '/') && url.includes(CHAT_SOLO_HASH);
}

export interface HandoffRequest {
  intent: ElementIntent;
  kind: TabKind;
  pageUrl: string;
  pageTitle: string;
  /** 오른쪽 클릭한 요소 · 못 읽었으면(iframe 안 · 빈 자리) null */
  element: ElementInfo | null;
  /** 네이버 화면 → 담당 AI · 못 찾았으면 null */
  screen: ScreenRecord | null;
}

export type HandoffResult = 'sent' | 'no-chat-tab' | 'composer-timeout' | 'focus-failed' | 'busy';

/** 실패를 사람에게 Windows 알림 한 줄로 — 원인 하나만(검수 2026-10-06 «조용히 실패») · 알림 꼴은 credentials/credential-menu.ts notify 와 같다 */
export const HANDOFF_FAILURE_TEXT: Record<Exclude<HandoffResult, 'sent'>, string> = {
  'no-chat-tab': 'AI 채팅 탭을 열지 못했습니다',
  'composer-timeout': 'AI 채팅 입력칸이 15초 안에 준비되지 않았습니다',
  'focus-failed': 'AI 채팅 입력칸에 커서를 놓지 못했습니다',
  busy: '앞의 AI 작업을 아직 넘기는 중입니다',
};

function notifyHandoffFailure(result: HandoffResult): void {
  if (result === 'sent' || !Notification.isSupported()) return;
  new Notification({ title: APP_DISPLAY_NAME, body: HANDOFF_FAILURE_TEXT[result], silent: true, icon: APP_ICON_PNG }).show();
}

/** 예상 못 한 오류 — 진짜 오류 문장 첫 줄을 그대로(원인을 지어내지 않는다 · 검수 2026-10-06) */
function notifyHandoffError(error: unknown): void {
  const line = ((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '').slice(0, 160);
  console.warn('[ai-handoff] 오류', line);
  if (Notification.isSupported()) new Notification({ title: APP_DISPLAY_NAME, body: `AI 채팅으로 넘기다 오류: ${line}`, silent: true, icon: APP_ICON_PNG }).show();
}

/** ShellWindow 가 준다 — 챗봇 탭 찾기 · 소스 탭과 다른 pane 에 열기 */
export interface ChatHost {
  findChatTab(): WebContents | null;
  openChatTab(sourceTabId: string): WebContents | null;
}

/** 작업마다 챗봇에 부탁하는 문장 — 바꾸는 작업은 «제안만»(1차 · 네이버 저장은 승인 뒤에만 · PLAN U10 4번) */
const REQUEST_TEXT: Readonly<Record<ElementIntentKey, string>> = {
  suggest_value: '이 칸에 넣을 값을 제안해 주세요. 지금 값과 제안 값을 «전 → 후»로 보여 주고, 제가 승인하기 전에는 아무것도 저장하지 마세요.',
  check_rules: '이 칸의 지금 값이 네이버 스마트스토어 규칙에 맞는지 검사해 주세요. 어긋난 곳은 네이버 도움말 출처와 함께 알려 주세요.',
  explain_field: '이 칸이 무엇을 뜻하고 어떻게 채워야 하는지 설명해 주세요.',
  explain_button: '이 단추를 누르면 무슨 일이 일어나는지 설명해 주세요. 누르지는 마세요.',
  summarize_screen: '이 화면이 무엇을 하는 곳이고 지금 무엇을 할 수 있는지 요약해 주세요.',
};

function describeElement(element: ElementInfo): string {
  const parts = [element.type ? `${element.tag}[type=${element.type}]` : element.tag];
  if (element.label) parts.push(`라벨 「${element.label}」`);
  if (element.name) parts.push(`name ${element.name}`);
  if (element.id) parts.push(`id ${element.id}`);
  if (element.role) parts.push(`role ${element.role}`);
  if (element.text) parts.push(`글 「${element.text}」`);
  return parts.join(' · ');
}

/** 한국어 요청 글 — 작업 · 플랫폼 · 화면 · 주소 · 담당 AI · 요소 · 선택자 · 지금 값 · 부탁. 전화 · 메일 꼴은 가린다(U10 9번) */
export function buildHandoffMessage(request: HandoffRequest): string {
  const { intent, element, screen } = request;
  const lines = [`[AI 작업] ${intent.label}`];
  lines.push(`플랫폼: ${request.kind === 'naver' ? '네이버 스마트스토어센터' : 'Shopware 어드민'}`);
  lines.push(`화면: ${screen ? `${screen.menuPath ?? screen.screenKey} (${screen.screenKey})` : request.pageTitle || '(제목 없음)'}`);
  lines.push(`주소: ${request.pageUrl}`);
  if (screen?.agentRole) lines.push(`담당 AI: ${screen.agentRole}${screen.capabilityName ? ` (${screen.capabilityName})` : ''}`);
  if (element) {
    lines.push(`요소: ${describeElement(element)}`);
    lines.push(`선택자: ${element.selector}`);
    if (element.value !== null && element.value !== '') lines.push(`지금 값: ${element.value}`);
  }
  lines.push(`요청: ${REQUEST_TEXT[intent.key]}`);
  return maskPersonalData(lines.join('\n'));
}

/** 우리 읽기 전용 world — 1207 · 1208 · 1209 와 겹치지 않는 고정 번호 */
const COMPOSER_WORLD_ID = 1210;
/** iframe 의 입력칸이 준비될 때까지(로그인 · 하네스 목록 로딩) */
const COMPOSER_WAIT_MS = 15_000;
const COMPOSER_POLL_MS = 250;
/** 클릭 뒤 포커스가 옮겨 갈 때까지 — credential-filler.ts 와 같은 값 */
const FOCUS_SETTLE_MS = 60;
const FOCUS_WAIT_TRIES = 10;

interface ComposerState {
  state: 'ready' | 'no-frame' | 'cross-origin' | 'no-doc' | 'no-textarea' | 'disabled' | 'hidden';
  /** 입력칸 가운데(바깥 문서 CSS px = iframe 자리 + 칸 자리) · ready 때만 */
  x?: number;
  y?: number;
  focused?: boolean;
}

/** 바깥 문서에서 같은 origin iframe 안 textarea[name="message"] 를 읽기만 한다 — 값 쓰기 0 */
function buildComposerScript(): string {
  return `(() => {
  const frame = document.querySelector('iframe.cmh-ai-chat-frame__iframe') || document.querySelector('iframe[src*="/chat-app/"]');
  if (!frame) return { state: 'no-frame' };
  let doc = null;
  try { doc = frame.contentDocument; } catch (_) { return { state: 'cross-origin' }; }
  if (!doc) return { state: 'no-doc' };
  const ta = doc.querySelector('textarea[name="message"]');
  if (!ta) return { state: 'no-textarea' };
  if (ta.disabled) return { state: 'disabled' };
  const fr = frame.getBoundingClientRect(); const r = ta.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { state: 'hidden' };
  return { state: 'ready', x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2, focused: doc.activeElement === ta };
})()`;
}

async function readComposer(wc: WebContents): Promise<ComposerState | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result: unknown = await wc.executeJavaScriptInIsolatedWorld(COMPOSER_WORLD_ID, [{ code: buildComposerScript() }]);
    return result && typeof result === 'object' && typeof (result as ComposerState).state === 'string' ? (result as ComposerState) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 사람의 왼쪽 클릭과 같은 입력 — CSS px × 줌 = DIP(credential-filler.ts clickAt 과 같다 · 그쪽은 export 가 아니라 여기 둔다) */
async function clickAt(wc: WebContents, x: number, y: number): Promise<void> {
  const zoom = wc.getZoomFactor() || 1;
  const dx = Math.round(x * zoom);
  const dy = Math.round(y * zoom);
  wc.sendInputEvent({ type: 'mouseDown', x: dx, y: dy, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: dx, y: dy, button: 'left', clickCount: 1 });
  await sleep(FOCUS_SETTLE_MS);
}

async function waitForComposer(wc: WebContents): Promise<{ x: number; y: number } | null> {
  const deadline = Date.now() + COMPOSER_WAIT_MS;
  let last: ComposerState | null = null;
  while (Date.now() < deadline) {
    last = await readComposer(wc);
    if (last?.state === 'ready' && typeof last.x === 'number' && typeof last.y === 'number') return { x: last.x, y: last.y };
    if (wc.isDestroyed()) return null;
    await sleep(COMPOSER_POLL_MS);
  }
  console.warn(`[ai-handoff] 챗봇 입력칸이 ${COMPOSER_WAIT_MS / 1000}초 안에 준비되지 않았습니다 — 마지막 상태 ${last?.state ?? '못 읽음'}(로그인 전 · 하네스 없음 · 로딩 중)`);
  return null;
}

export class ChatHandoff {
  private busy = false;

  constructor(private readonly host: ChatHost) {}

  /** 챗봇 탭을 찾거나 열고 → 입력칸 준비를 기다리고 → 클릭 → 글 넣기 → Enter. 한 번에 하나만(겹치면 busy) */
  async send(sourceTabId: string, request: HandoffRequest): Promise<HandoffResult> {
    if (this.busy) return 'busy';
    this.busy = true;
    try {
      return await this.deliver(sourceTabId, request);
    } finally {
      this.busy = false;
    }
  }

  private async deliver(sourceTabId: string, request: HandoffRequest): Promise<HandoffResult> {
    const wc = this.host.findChatTab() ?? this.host.openChatTab(sourceTabId);
    if (!wc || wc.isDestroyed()) {
      console.warn('[ai-handoff] AI 채팅 탭을 못 열었습니다');
      return 'no-chat-tab';
    }
    const message = buildHandoffMessage(request);
    const point = await waitForComposer(wc);
    if (!point || wc.isDestroyed()) return 'composer-timeout';
    wc.focus();
    await clickAt(wc, point.x, point.y);
    let focused = false;
    for (let i = 0; i < FOCUS_WAIT_TRIES && !focused; i++) {
      const state = await readComposer(wc);
      focused = state?.state === 'ready' && state.focused === true;
      if (!focused) await sleep(FOCUS_SETTLE_MS);
    }
    if (!focused || wc.isDestroyed()) {
      console.warn('[ai-handoff] 챗봇 입력칸에 포커스가 가지 않았습니다 — 글을 넣지 않습니다');
      return 'focus-failed';
    }
    await wc.insertText(message);
    await sleep(FOCUS_SETTLE_MS);
    if (wc.isDestroyed()) return 'focus-failed';
    // Enter = 보내기(PromptInputTextarea.vue:20-33) · char 이벤트는 안 보낸다 — keydown 이 preventDefault 하므로 줄바꿈이 들어갈 일도 없다
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    console.info(`[ai-handoff] 보냄 — ${request.intent.key} · ${request.screen?.agentRole ?? '담당 없음'} · ${request.element?.selector ?? '요소 없음'}`);
    return 'sent';
  }
}

/** 메뉴 쪽이 쓰는 둘 — ShellWindow 의 ScreenLookup · ChatHandoff 로 이어진다(admin-view.ts TabViewEvents) */
export interface AiActionDeps {
  lookup(pageUrl: string): Promise<ScreenRecord | null>;
  send(sourceTabId: string, request: HandoffRequest): Promise<HandoffResult>;
}

/**
 * 오른쪽 클릭 → «AI 작업 ▸» 하위 항목. 요소 읽기(isolated world)와 담당 AI 찾기(네이버만 · 1.5초 상한)를 같이 기다린다.
 * iframe 안 클릭(params.frame ≠ mainFrame)은 1차에서 요소를 안 읽는다 → «이 화면 요약»만. 빈 탭(web)은 null(메뉴 없음).
 */
export function createAiActionProvider(wc: WebContents, tabId: string, kind: TabKind, deps: AiActionDeps): AiActionProvider | null {
  if (kind === 'web') return null;
  // 네이버 탭은 미리 한 번 받아 둔다(로그인 전이면 바로 null · 첫 오른쪽 클릭이 1.5초를 기다리지 않게)
  if (kind === 'naver') void deps.lookup(wc.getURL());
  return {
    async itemsAt(params): Promise<AiActionItem[]> {
      if (wc.isDestroyed()) return [];
      const main = wc.mainFrame;
      const inSubFrame = params.frame !== null && (params.frame.processId !== main.processId || params.frame.routingId !== main.routingId);
      const pageUrl = wc.getURL();
      const [element, screen] = await Promise.all([
        inSubFrame ? Promise.resolve(null) : readElementAtPoint(wc, params.x, params.y),
        kind === 'naver' ? deps.lookup(pageUrl) : Promise.resolve(null),
      ]);
      const pageTitle = wc.isDestroyed() ? '' : wc.getTitle();
      return intentsFor(kind, element).map((intent) => ({
        label: intent.label,
        run: () => void deps.send(tabId, { intent, kind, pageUrl, pageTitle, element, screen }).then(notifyHandoffFailure, notifyHandoffError),
      }));
    },
  };
}
