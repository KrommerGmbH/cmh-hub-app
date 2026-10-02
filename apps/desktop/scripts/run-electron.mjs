// Electron 을 띄운다. ELECTRON_RUN_AS_NODE 가 켜진 셸(VS Code 확장 안 터미널)에서는 electron.exe 가 Node 로 돌아 죽으므로 지우고 띄운다.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // npm 래퍼 — 바이너리 경로 문자열
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
