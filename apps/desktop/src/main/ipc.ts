// U01 · U03 — IPC 는 셸(shell:cmd) · 덮개(overlay:cmd) 둘뿐. 보낸 쪽이 셸 view 인지 확인한다.
import { ipcMain } from 'electron';
import { OVERLAY_IPC, SHELL_IPC, type ShellCommand } from '@cmh-hub-app/contracts';
import { getShellWindow } from './window/shell-window.js';
import { stopParallelCheck } from './parallel-check.js';

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
    // 덮개는 지금 병렬 시험(CMH_HUB_PARALLEL · 개발판)에서만 뜬다 — «멈추기» = 시험 끝(U07 ⑥ · W02 뒤에 작업 큐 released 로)
    console.info('[overlay] cmd', raw);
    if (typeof raw === 'object' && raw !== null && (raw as { cmd?: unknown }).cmd === 'aiTaskStop') stopParallelCheck();
  });
}
