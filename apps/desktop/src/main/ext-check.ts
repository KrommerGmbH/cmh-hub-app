import { app, BrowserWindow, session } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG } from '../config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runExtCheckIfRequested(): void {
  if (!process.env['CMH_HUB_EXT_CHECK'] || app.isPackaged) return;

  void (async () => {
    let win: BrowserWindow | null = null;
    let extId: string | null = null;
    let ses: Electron.Session | null = null;

    try {
      // 개발판 app.getAppPath() = apps/desktop 디렉터리 경로를 가리킨다.
      // 따라서 상대 경로 '..', 'chrome-extension', 'dist'는 apps/chrome-extension/dist를 가리킨다.
      const extDir = join(app.getAppPath(), '..', 'chrome-extension', 'dist');
      const manifestPath = join(extDir, 'manifest.json');

      if (!existsSync(extDir) || !existsSync(manifestPath)) {
        console.warn(
          '[ext-check] 확장 dist 없음 — apps/chrome-extension 에서 CMH_EXT_DEV_ORIGIN=<서버> pnpm run build',
        );
        return;
      }

      const rawManifest = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(rawManifest);
      const matches = manifest?.content_scripts?.[0]?.matches;
      const expectedMatch = APP_CONFIG.serverOrigin + '/*';

      if (!Array.isArray(matches) || !matches.includes(expectedMatch)) {
        console.warn(
          '[ext-check] 확장 dist 없음 — apps/chrome-extension 에서 CMH_EXT_DEV_ORIGIN=<서버> pnpm run build',
        );
        return;
      }

      // 메모리 세션은 확장을 올릴 수 없으므로 영속 세션(persist:)을 사용한다 (electron.d.ts Extensions.loadExtension 주석 참조).
      ses = session.fromPartition('persist:ext-check');
      const ext = await ses.extensions.loadExtension(extDir);
      extId = ext.id;

      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
        },
      });

      await win.loadURL(APP_CONFIG.serverOrigin + '/#cmh-ext-check');

      let resultValue: string | null = null;
      const startTime = Date.now();

      while (Date.now() - startTime < 20000) {
        await sleep(500);
        if (win.isDestroyed() || win.webContents.isDestroyed()) {
          break;
        }

        const val = await win.webContents.executeJavaScript(
          'document.documentElement.dataset.cmhExtCheck || null',
        );
        if (val) {
          resultValue = String(val);
          break;
        }
      }

      if (resultValue) {
        console.info('[ext-check] ' + resultValue);
      } else {
        console.info('[ext-check] 시간 초과 — content script 가 안 돌았다');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const firstLine = msg.split('\n')[0] ?? '';
      console.warn('[ext-check] 실패', firstLine);
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      if (ses && extId) {
        try {
          ses.extensions.removeExtension(extId);
        } catch {
          // ignore cleanup error
        }
      }
      if (ses) {
        try {
          await ses.clearStorageData();
        } catch (error) {
          console.warn(
            '[ext-check] clearStorageData 실패',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  })();
}
