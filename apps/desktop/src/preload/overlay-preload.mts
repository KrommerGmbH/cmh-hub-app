// U07 ⑥ — 덮개 preload. hubOverlay 셋(onCursor · onBand · stop)뿐.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { OVERLAY_IPC, type AiTaskBand, type HubOverlayApi } from '@cmh-hub-app/contracts';

const api: HubOverlayApi = {
  onCursor(cb) {
    const listener = (_e: IpcRendererEvent, p: { x: number; y: number } | null): void => cb(p);
    ipcRenderer.on(OVERLAY_IPC.cursor, listener);
    return () => {
      ipcRenderer.off(OVERLAY_IPC.cursor, listener);
    };
  },
  onBand(cb) {
    const listener = (_e: IpcRendererEvent, band: AiTaskBand | null): void => cb(band);
    ipcRenderer.on(OVERLAY_IPC.band, listener);
    return () => {
      ipcRenderer.off(OVERLAY_IPC.band, listener);
    };
  },
  stop(paneId: string): void {
    ipcRenderer.send(OVERLAY_IPC.cmd, { cmd: 'aiTaskStop', paneId });
  },
};

contextBridge.exposeInMainWorld('hubOverlay', api);
