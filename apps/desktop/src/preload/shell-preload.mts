// U01 — 셸 preload. contextBridge 로 노출하는 것은 hubShell 둘(send · onState)뿐.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { SHELL_IPC, type HubShellApi, type ShellCommand, type ShellState } from '@cmh-hub-app/contracts';

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
};

contextBridge.exposeInMainWorld('hubShell', api);
