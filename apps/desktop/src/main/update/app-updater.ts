// G03 앱 업데이트 — 시작 → 확인 → 동의 모달 → 받기(progress) → 설치 · 재시작(2026-10-06 · Fable 판단 «G03 을 먼저 넣고 첫 exe»).
// 업데이트 파일은 깃허브 공개 저장소 Releases(G02 · electron-builder.yml publish). 모달은 셸이 그린다(shell.ts renderUpdate · shell:state.update).
// 개발판(app.isPackaged false)은 확인하지 않는다 — 개발판에는 app-update.yml 이 없다.
import { app } from 'electron';
import electronUpdater from 'electron-updater'; // CJS — autoUpdater 는 처음 읽을 때 만드는 getter 라 ESM 이름 import 로 못 꺼낸다
import type { UpdateState } from '@cmh-hub-app/contracts';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // PLAN G03 «그 뒤 6시간마다»

/** 오류 한 줄 — 원인 하나만(모달에 그대로 보인다) */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

export class AppUpdater {
  private version: string | undefined;
  private downloading = false;
  /** 서버가 이 판을 거절함(G04) · 한 번 켜지면 앱을 다시 켤 때까지 안 꺼진다 */
  private required = false;
  /** 다 받은 판 — 있으면 다시 확인하지 않는다(앱을 닫을 때 깔린다 · 6시간 타이머가 같은 판을 «있음»으로 다시 띄우던 결함 · 검수 2026-10-06) */
  private readyVersion: string | null = null;
  private devRejectedShown = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly publish: (state: UpdateState) => void) {}

  /** 판을 알 때만 version 칸을 넣는다(exactOptionalPropertyTypes — undefined 를 그대로 못 넣는다) */
  private known(): { version?: string } {
    return this.version === undefined ? {} : { version: this.version };
  }

  /** 서버가 이 판을 거절함(G04) — 필수 업데이트 모달 */
  markRequired(): void {
    if (!app.isPackaged) {
      if (!this.devRejectedShown) {
        this.devRejectedShown = true;
        console.warn('[update] 서버가 이 개발판을 거절 — app-too-old · package.json 판 번호를 올리십시오');
        this.publish({ state: 'error', message: '서버가 이 개발판을 거절합니다(app-too-old). 개발판은 자동 업데이트가 없습니다 — 판 번호를 올리십시오.' });
      }
      return;
    }
    if (this.required) return;
    this.required = true;
    if (this.readyVersion !== null) {
      this.publish({ state: 'ready', version: this.readyVersion, ...(this.required ? { mandatory: true } : {}) });
      return;
    }
    this.publish({ state: 'required', ...this.known() });
    console.warn('[update] 서버가 이 판을 거절 — 필수 업데이트(app-too-old)');
    this.check();
  }

  start(): void {
    if (!app.isPackaged) return;
    const { autoUpdater } = electronUpdater;
    // 자체 로그를 끈다 — 그 [error] 줄(«No published versions» 등)이 app-logger 를 타고 60초마다 서버 오류 보고로 간다(2026-10-06 첫 exe 실측)
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false; // 사람이 «업데이트» 를 눌러야 받는다(동의 모달)
    autoUpdater.autoInstallOnAppQuit = true; // 받은 뒤 «나중에» 면 다음에 앱을 닫을 때 깐다
    autoUpdater.on('update-available', (info) => {
      this.version = info.version;
      const size = info.files[0]?.size;
      this.publish({ state: this.required ? 'required' : 'available', version: info.version, ...(size === undefined ? {} : { size }) });
    });
    autoUpdater.on('update-not-available', () => {
      if (this.required) return;
      if (!this.downloading) this.publish({ state: 'none' });
    });
    autoUpdater.on('download-progress', (p) => this.publish({ state: 'downloading', ...this.known(), percent: p.percent }));
    autoUpdater.on('update-downloaded', (info) => {
      this.downloading = false;
      this.readyVersion = info.version;
      this.publish({ state: 'ready', version: info.version, ...(this.required ? { mandatory: true } : {}) });
    });
    autoUpdater.on('error', (error: unknown) => {
      // 확인 단계 오류(오프라인 · Releases 가 아직 없음 404)는 로그만 — 시작할 때마다 오류 모달을 띄우지 않는다.
      // 받기 중 오류만 모달에 원인 한 줄로 보이고 warn(서버 오류 보고)으로 남긴다. 확인 실패는 check() 가 info 로만 남긴다.
      if (this.downloading) {
        console.warn('[update] 받기 실패', oneLine(error));
        this.downloading = false;
        if (this.required) {
          this.publish({ state: 'required', ...this.known(), message: oneLine(error) });
        } else {
          this.publish({ state: 'error', ...this.known(), message: oneLine(error) });
        }
      }
    });
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  private check(): void {
    if (this.downloading || this.readyVersion !== null) return;
    void electronUpdater.autoUpdater.checkForUpdates().catch((error: unknown) => console.info('[update] 확인 실패', oneLine(error)));
  }

  /** 모달 «업데이트» · «다시 시도» */
  download(): void {
    if (!app.isPackaged || this.downloading) return;
    this.downloading = true;
    this.publish({ state: 'downloading', ...this.known(), percent: 0 });
    // 실패는 'error' 이벤트가 모달에 보인다 — 여기서는 삼키기만(같은 오류를 두 번 보이지 않게)
    void electronUpdater.autoUpdater.downloadUpdate().catch(() => undefined);
  }

  /** 모달 «지금 재시작» */
  install(): void {
    if (!app.isPackaged) return;
    electronUpdater.autoUpdater.quitAndInstall();
  }

  /** 모달 «나중에» — 모달만 닫는다. 받아 둔 판은 autoInstallOnAppQuit 로 다음에 닫을 때 깔린다 */
  later(): void {
    if (this.required) {
      if (this.readyVersion !== null) {
        this.publish({ state: 'ready', version: this.readyVersion, ...(this.required ? { mandatory: true } : {}) });
        return;
      }
      this.publish({ state: 'required', ...this.known() });
      return;
    }
    this.publish({ state: 'none' });
  }
}
