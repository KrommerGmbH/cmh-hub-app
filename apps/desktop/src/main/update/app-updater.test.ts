import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@cmh-hub-app/contracts';

const listeners = new Map<string, (...args: unknown[]) => void>();

const fakeAutoUpdater = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    listeners.set(event, cb);
    return fakeAutoUpdater;
  }),
  checkForUpdates: vi.fn(() => Promise.resolve(null)),
  downloadUpdate: vi.fn(() => Promise.resolve([])),
  quitAndInstall: vi.fn(),
};

const mockApp = { isPackaged: true };
vi.mock('electron', () => ({ app: mockApp }));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: fakeAutoUpdater,
  },
}));

const { AppUpdater } = await import('./app-updater.js');

describe('AppUpdater (G04 필수 업데이트)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    mockApp.isPackaged = true;
  });

  it('markRequired() 두 번 호출 시 publish 의 required 는 한 번만 발생한다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.markRequired();
    updater.markRequired();
    const requiredEvents = published.filter((s) => s.state === 'required');
    expect(requiredEvents).toHaveLength(1);
    expect(requiredEvents[0]).toEqual({ state: 'required' });
  });

  it('required 설정 뒤 later() 호출 시 마지막 publish 가 required 로 남는다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.markRequired();
    updater.later();
    expect(published[published.length - 1]).toEqual({ state: 'required' });
    expect(published.filter((s) => s.state === 'none')).toHaveLength(0);
  });

  it('required 설정 뒤 update-available 수신 시 version 과 size 를 포함한 required 상태를 알린다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    updater.markRequired();
    const onAvailable = listeners.get('update-available');
    expect(onAvailable).toBeDefined();
    onAvailable?.({ version: '9.9.9', files: [{ size: 1000 }] });
    expect(published[published.length - 1]).toEqual({ state: 'required', version: '9.9.9', size: 1000 });
  });

  it('required 가 아닐 때 update-available 수신 시 available 상태를 알린다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    const onAvailable = listeners.get('update-available');
    expect(onAvailable).toBeDefined();
    onAvailable?.({ version: '1.2.3', files: [{ size: 2048 }] });
    expect(published[published.length - 1]).toEqual({ state: 'available', version: '1.2.3', size: 2048 });
  });

  it('update-downloaded 수신 뒤 markRequired() 호출 시 ready 상태를 알린다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    const onDownloaded = listeners.get('update-downloaded');
    expect(onDownloaded).toBeDefined();
    onDownloaded?.({ version: '9.9.9' });
    expect(published[published.length - 1]).toEqual({ state: 'ready', version: '9.9.9' });

    published.length = 0;
    updater.markRequired();
    expect(published).toEqual([{ state: 'ready', version: '9.9.9', mandatory: true }]);
  });

  it('required 상태에서 update-not-available 수신 시 아무 상태도 보내지 않는다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    updater.markRequired();
    published.length = 0;
    const onNotAvailable = listeners.get('update-not-available');
    expect(onNotAvailable).toBeDefined();
    onNotAvailable?.();
    expect(published).toHaveLength(0);
  });

  it('개발판에서 markRequired() 두 번 호출 시 publish 는 error 한 번 발생하고 later() 시 none 상태가 된다', () => {
    mockApp.isPackaged = false;
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.markRequired();
    updater.markRequired();
    const errorEvents = published.filter((s) => s.state === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.state).toBe('error');

    updater.later();
    expect(published[published.length - 1]).toEqual({ state: 'none' });
  });

  it('required 상태에서 다운로드 중 error 이벤트 수신 시 message 를 포함한 required 상태를 알린다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    updater.markRequired();
    updater.download();
    const onError = listeners.get('error');
    expect(onError).toBeDefined();
    onError?.(new Error('네트워크 끊김'));
    expect(published[published.length - 1]).toEqual({
      state: 'required',
      message: '네트워크 끊김',
    });
  });

  it('update-downloaded 뒤 markRequired() 후 later() 호출 시 마지막 publish 가 ready 로 남는다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    const onDownloaded = listeners.get('update-downloaded');
    expect(onDownloaded).toBeDefined();
    onDownloaded?.({ version: '9.9.9' });
    updater.markRequired();
    updater.later();
    expect(published[published.length - 1]).toEqual({ state: 'ready', version: '9.9.9', mandatory: true });
  });

  it('required 가 아닐 때 update-downloaded 수신 시 mandatory 가 없는 ready 상태를 알린다', () => {
    const published: UpdateState[] = [];
    const updater = new AppUpdater((s) => published.push(s));
    updater.start();
    const onDownloaded = listeners.get('update-downloaded');
    expect(onDownloaded).toBeDefined();
    onDownloaded?.({ version: '1.0.0' });
    expect(published[published.length - 1]).toEqual({ state: 'ready', version: '1.0.0' });
    expect(published[published.length - 1]?.mandatory).toBeUndefined();
  });
});
