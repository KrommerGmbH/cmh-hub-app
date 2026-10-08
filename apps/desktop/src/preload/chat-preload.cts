// R6-a — 챗 pane(WebContentsView · sandbox: true) preload. `window.cmhChat` 에 판 번호 · ping 하나만 연다(에이전트 IPC 는 R6-b).
// ⚠ .cts(CommonJS)인 까닭은 plugin-ui-preload.cts 머리 주석과 같다 — sandbox 화면에 ESM preload 는 돌지 않았다(2026-10-07 실측 · Electron 44.5.1).
// sandbox preload 는 electron 밖의 우리 모듈을 require 할 수 없다 → 채널 이름을 chat-pane-host.ts CHAT_PING_CHANNEL 과 같은 글자로 여기도 적는다
//   (chat-policy.test.ts 가 두 글자가 같은지 본다). 검사는 main(ChatPaneHost.ping)이 보낸 webContents id · 프레임 주소로 한다.
import { contextBridge, ipcRenderer } from 'electron';

const CHAT_PING_CHANNEL = 'cmh-chat:ping';

contextBridge.exposeInMainWorld('cmhChat', {
  /** preload API 판(R6-b 가 올린다) */
  bridge: 1,
  /** main 이 살아 있나 · 앱 판 — { ok: true, version, bridge } | { ok: false, error } */
  ping(): Promise<unknown> {
    return ipcRenderer.invoke(CHAT_PING_CHANNEL);
  },
});
