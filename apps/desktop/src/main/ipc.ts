// U01 · U03 — IPC 는 셸(shell:cmd) · 덮개(overlay:cmd) 둘뿐. 보낸 쪽이 셸 view 인지 확인한다.
import { ipcMain } from 'electron';
import { OVERLAY_IPC, SHELL_IPC, type ShellCommand } from '@cmh-hub-app/contracts';
import { getShellWindow } from './window/shell-window.js';

function isShellCommand(v: unknown): v is ShellCommand {
  return typeof v === 'object' && v !== null && typeof (v as { cmd?: unknown }).cmd === 'string';
}

export function registerIpc(): void {
  ipcMain.on(SHELL_IPC.cmd, (event, raw: unknown) => {
    const w = getShellWindow();
    if (!w) return;
    if (!w.isShellSender(event.sender)) {
      console.warn('[ipc] 셸이 아닌 webContents 가 shell:cmd 를 보냈다 — 무시', event.sender.id);
      return;
    }
    if (!isShellCommand(raw)) return;
    w.handleCommand(raw);
  });

  ipcMain.on(OVERLAY_IPC.cmd, (_event, raw: unknown) => {
    // 1차: 덮개 view 가 아직 없다 — 로그만(U07 ⑥ · W02 뒤)
    console.info('[overlay] cmd', raw);
  });
}
