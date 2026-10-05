// 앱 이름 · 아이콘 · Windows 앱 ID(AppUserModelID)를 한 곳에(2026-10-05 사장님 «여전히 어딘가에 electron icon · 로고를 한 번에 변경»).
// Windows 는 작업 표시줄 묶음 · 알림(토스트)의 이름과 아이콘을 «이 앱 ID 를 가진 바로가기»에서 가져온다. 못 찾으면 실행 파일(electron.exe)의
// 아이콘 = Electron 로고를 쓴다. 설치판은 electron-builder 가 appId 로 바로가기를 만들고 exe 아이콘도 바꾼다(electron-builder.yml win.icon).
// 개발판(node_modules 의 electron.exe)은 그것이 없어 여기서 바로가기 둘에 앱 ID 와 아이콘을 적는다(Electron shell.writeShortcutLink).
import { app, shell } from 'electron';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** electron-builder.yml 의 appId 와 같은 값 */
export const APP_USER_MODEL_ID = 'de.krommer.cmh-hub-app';
export const APP_DISPLAY_NAME = 'CMH Hub';

const here = dirname(fileURLToPath(import.meta.url)); // dist/main
const RESOURCES = join(here, '..', '..', 'resources'); // apps/desktop/resources(배포판은 electron-builder files 에 들어 있다)
export const APP_ICON_PNG = join(RESOURCES, 'icon.png');
export const APP_ICON_ICO = join(RESOURCES, 'icon.ico');

/** 개발판 바로가기 — 시작 메뉴(알림이 앱 이름 · 아이콘을 쓰려면 꼭 필요 · Electron 알림 문서) · 바탕화면(있을 때만 고친다) */
export function ensureDevShortcuts(): void {
  if (process.platform !== 'win32' || app.isPackaged) return;
  const appDir = app.getAppPath();
  const details = {
    target: process.execPath,
    args: `"${appDir}"`,
    cwd: appDir,
    icon: APP_ICON_ICO,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    description: `${APP_DISPLAY_NAME} (개발판)`,
  };
  const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_DISPLAY_NAME} (dev).lnk`);
  const desktop = join(app.getPath('desktop'), 'cmh-hub dev.lnk');
  // Electron 은 알림을 처음 띄울 때 이 앱 ID 의 바로가기가 없으면 시작 메뉴에 «Electron.lnk»(exe 아이콘 = Electron 로고)를 스스로 만든다
  // (2026-10-05 13:10 실측 — 사장님 «여전히 어딘가에 electron icon»). 우리 exe · 우리 앱 ID 를 가리키는 것만 지운다(남의 Electron 앱 것은 둔다).
  const strayElectron = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk');
  try {
    // writeShortcutLink 는 실패해도 throw 하지 않고 false 를 준다(electron.d.ts) — 그때 적는다
    if (!shell.writeShortcutLink(startMenu, existsSync(startMenu) ? 'replace' : 'create', details)) console.warn('[app-identity] 시작 메뉴 바로가기를 못 썼습니다');
    if (existsSync(desktop) && !shell.writeShortcutLink(desktop, 'replace', details)) console.warn('[app-identity] 바탕화면 바로가기를 못 고쳤습니다');
    if (existsSync(strayElectron)) {
      const stray = shell.readShortcutLink(strayElectron);
      if (stray.target.toLowerCase() === process.execPath.toLowerCase() && stray.appUserModelId === APP_USER_MODEL_ID) {
        unlinkSync(strayElectron);
        console.info('[app-identity] Electron 이 만든 시작 메뉴 바로가기(Electron.lnk)를 지웠습니다');
      }
    }
  } catch (error) {
    console.warn('[app-identity] 개발판 바로가기를 못 고쳤습니다', error instanceof Error ? error.message : 'unknown');
  }
}
