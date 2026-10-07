// U01 — 셸 preload. contextBridge 로 노출하는 것은 hubShell 하나(send · onState · setSidebar · t · locale).
// R8 — 스니펫은 여기서(Node 쪽) 읽어 t() 로만 넘긴다. 렌더러(shell.ts)는 fs 를 쓰지 않는다.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { SHELL_IPC, type HubShellApi, type ShellCommand, type ShellState, type SidebarState } from '@cmh-hub-app/contracts';
import { loadSnippets, type SnippetParams, type Snippets } from '../main/i18n/snippet.js';

/**
 * locale 은 navigator.language — main.ts 가 `--lang ko-KR` 을 켜므로(U07 8-13b · 네이버 지문 맞춤) 지금은 늘 ko-KR 이다.
 * 스니펫 파일이 깨졌으면(JSON 오류 · 키 없음) 셸이 죽지 않게 키 그대로 돌려준다.
 */
function openSnippets(): Snippets | null {
  try {
    return loadSnippets(navigator.language, {
      onMissing: (m) => console.warn('[snippet] 없는 키', m.key, m.locale, m.fellBackTo ?? '키 그대로'),
    });
  } catch (error) {
    console.error('[snippet] 스니펫을 못 읽었다 — 키 그대로 보인다', error instanceof Error ? error.message : String(error));
    return null;
  }
}

const snippets = openSnippets();

const api: HubShellApi = {
  send(cmd: ShellCommand): void {
    ipcRenderer.send(SHELL_IPC.cmd, cmd);
  },
  onState(cb: (state: ShellState) => void): () => void {
    const listener = (_event: IpcRendererEvent, state: ShellState): void => cb(state);
    ipcRenderer.on(SHELL_IPC.state, listener);
    return () => {
      ipcRenderer.off(SHELL_IPC.state, listener);
    };
  },
  setSidebar(next: SidebarState): void {
    ipcRenderer.send(SHELL_IPC.sidebar, { collapsed: next.collapsed, width: next.width });
  },
  t(key: string, params?: SnippetParams): string {
    return snippets ? snippets.t(key, params) : key;
  },
  locale: snippets?.locale ?? 'en-GB',
};

contextBridge.exposeInMainWorld('hubShell', api);
