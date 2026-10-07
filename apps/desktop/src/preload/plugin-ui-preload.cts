// R2-b — 플러그인 화면(WebContentsView · sandbox: true) preload. `window.cmhPlugin.call(method, params)` 하나만 연다.
// ⚠ .cts(CommonJS)인 까닭 — 실측(2026-10-07 · Electron 44.5.1 · xvfb): sandbox: true 인 화면에 ESM preload(.mjs)를 주면
//   «Cannot use import statement outside a module» 로 preload 가 돌지 않는다. CommonJS(.cjs)는 돈다. 그래서 tsc 가 .cjs 를 내는 .cts 로 둔다.
// sandbox preload 는 electron 밖의 우리 모듈을 require 할 수 없다 → 채널 이름을 plugin-ui-bridge.ts PLUGIN_UI_IPC_CHANNEL 과 같은 글자로 여기도 적는다
//   (plugin-ui-bridge.test.ts 가 두 글자가 같은지 본다).
// 권한 검사는 여기서 하지 않는다 — main 의 PluginUiBridge 가 보낸 webContents id · 프레임 · 매니페스트로 한다(이 파일은 믿지 않는 쪽).
// 답 꼴: { ok: true, result } | { ok: false, error: { code, message } } 를 그대로 돌려준다(던지면 contextBridge 너머로 code 가 사라진다).
import { contextBridge, ipcRenderer } from 'electron';

const PLUGIN_UI_IPC_CHANNEL = 'cmh-plugin-ui:call';

contextBridge.exposeInMainWorld('cmhPlugin', {
  call(method: string, params?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(PLUGIN_UI_IPC_CHANNEL, { method: String(method), params });
  },
});
