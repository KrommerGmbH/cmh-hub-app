// R2-a — 플러그인 레지스트리: 폴더 스캔 · 생명주기(Shopware 꼴) · 게으른 활성화(VS Code activationEvents 꼴).
// electron 을 import 하지 않는다(프로세스는 PluginRuntimeFactory 로 주입 — 앱은 createProcessRuntimeFactory + ElectronProcessLauncher).
//
// 상태 두 축:
//   state   = 생명주기(Shopware plugin:install / activate / deactivate / update / uninstall)
//             discovered(폴더는 있으나 설치 전) → installed → active ⇄ inactive · 어디서든 문제가 나면 error
//   running = 프로세스가 떠 있나(VS Code «activation»). active 여도 activationEvents 가 올 때까지 안 띄운다(원칙 1·3).
// 순서 위반은 PluginLifecycleError(프로그래머 · 화면 문제 = 예외) · 플러그인 쪽 실패(매니페스트 · 프로세스 죽음)는 state=error(자료 문제 = 결과).
// 1차는 상태를 메모리에만 둔다 — 앱을 다시 켜면 scan 뒤 전부 discovered(저장은 다음 차례 · 보고서 참고).

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareSemver, parseManifestText, type PluginManifest } from './plugin-manifest.js';
import type { EventBus } from './event-bus.js';
import type { ServiceContainer } from './service-container.js';

export const PLUGIN_STATES = ['discovered', 'installed', 'active', 'inactive', 'error'] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
export type LifecycleAction = 'install' | 'activate' | 'deactivate' | 'update' | 'uninstall';

export interface PluginExitInfo {
  readonly code: number | null;
  /** stop() 으로 내린 것이면 true · 스스로 죽었거나 죽임을 당했으면 false */
  readonly expected: boolean;
}

/** 떠 있는 플러그인 하나(PluginProcess 가 이 꼴을 따른다 · 시험은 가짜) */
export interface PluginRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  onExit(listener: (info: PluginExitInfo) => void): void;
}
export type PluginRuntimeFactory = (plugin: { readonly manifest: PluginManifest; readonly pluginDir: string }) => PluginRuntime;

export interface PluginLifecycleContext {
  readonly manifest: PluginManifest;
  readonly pluginDir: string;
}

/** Shopware `Plugin::install()` … `uninstall(UninstallContext)` 자리. 1차는 앱이 꽂는다(R1 마이그레이션 · 사용자 자료 지우기). */
export interface PluginLifecycleHooks {
  install?(context: PluginLifecycleContext): void | Promise<void>;
  activate?(context: PluginLifecycleContext): void | Promise<void>;
  deactivate?(context: PluginLifecycleContext): void | Promise<void>;
  update?(context: PluginLifecycleContext, info: { readonly fromVersion: string; readonly toVersion: string }): void | Promise<void>;
  /** keepUserData=true 면 플러그인 테이블 · 설정을 남긴다(Shopware UninstallContext::keepUserData) */
  uninstall?(context: PluginLifecycleContext, options: { readonly keepUserData: boolean }): void | Promise<void>;
}

export interface PluginRegistryOptions {
  /** 플러그인 폴더들의 부모(앱은 userData/plugins) */
  readonly root: string;
  readonly appVersion: string;
  readonly runtimeFactory: PluginRuntimeFactory;
  readonly hooks?: PluginLifecycleHooks;
  /** 주면 플러그인을 내릴 때(정상 · 죽음 모두) 그 플러그인 구독을 푼다 */
  readonly bus?: EventBus;
  /** 주면 플러그인을 내릴 때 그 플러그인이 등록한 서비스 · decorator 를 걷는다 */
  readonly services?: ServiceContainer;
  /** state 가 error 로 바뀔 때(H05 보고 자리) */
  readonly onError?: (name: string, message: string) => void;
}

export interface PluginSummary {
  readonly name: string;
  readonly version: string | null;
  readonly state: PluginState;
  readonly running: boolean;
  readonly errorMessage: string | null;
  readonly warnings: readonly string[];
}

export class PluginLifecycleError extends Error {
  constructor(readonly plugin: string, readonly action: LifecycleAction, readonly state: PluginState, detail?: string) {
    super(`cannot ${action} plugin "${plugin}" in state ${state}${detail ? ` (${detail})` : ''}`);
    this.name = 'PluginLifecycleError';
  }
}

interface PluginRecord {
  readonly name: string;
  readonly dir: string;
  manifest: PluginManifest | null;
  state: PluginState;
  errorMessage: string | null;
  warnings: readonly string[];
  runtime: PluginRuntime | null;
  starting: Promise<void> | null;
  queue: Promise<unknown>;
}

const ALLOWED_FROM: Readonly<Record<LifecycleAction, readonly PluginState[]>> = {
  install: ['discovered'],
  activate: ['installed', 'inactive'],
  // error 에서 나오는 길은 deactivate 하나(살핀 뒤 다시 activate)
  deactivate: ['active', 'error'],
  update: ['installed', 'inactive', 'active'],
  // Shopware 처럼 켜진 채로는 못 지운다 — 먼저 deactivate
  uninstall: ['installed', 'inactive'],
};

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();
  private startedUp = false;

  constructor(private readonly options: PluginRegistryOptions) {}

  /** `<root>/*\/plugin.json` 을 읽는다. 이미 아는 플러그인의 생명주기 상태는 그대로 둔다(새 판은 update() 로만 반영). */
  async scan(): Promise<PluginSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.options.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
      else throw error;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.options.root, entry.name);
      const read = await this.readManifest(dir, entry.name);
      if (read === null) continue; // plugin.json 없는 폴더는 플러그인이 아니다
      seen.add(entry.name);
      const existing = this.records.get(entry.name);
      if (existing && existing.manifest && existing.state !== 'discovered') continue;
      if (existing && existing.runtime) continue;
      this.records.set(entry.name, {
        name: entry.name,
        dir,
        manifest: read.manifest,
        state: read.manifest ? 'discovered' : 'error',
        errorMessage: read.error,
        warnings: read.warnings,
        runtime: null,
        starting: null,
        queue: existing?.queue ?? Promise.resolve(),
      });
    }
    for (const record of this.records.values()) {
      if (seen.has(record.name)) continue;
      if (record.state === 'discovered' || !record.manifest) this.records.delete(record.name);
      else this.fail(record, 'plugin folder is missing');
    }
    return this.list();
  }

  list(): PluginSummary[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name)).map((record) => this.summary(record));
  }

  get(name: string): PluginSummary | null {
    const record = this.records.get(name);
    return record ? this.summary(record) : null;
  }

  install(name: string): Promise<void> {
    return this.lifecycle(name, 'install', async (record, manifest) => {
      await this.options.hooks?.install?.({ manifest, pluginDir: record.dir });
      record.state = 'installed';
    });
  }

  activate(name: string): Promise<void> {
    return this.lifecycle(name, 'activate', async (record, manifest) => {
      await this.options.hooks?.activate?.({ manifest, pluginDir: record.dir });
      record.state = 'active';
      record.errorMessage = null;
      if (this.startedUp && manifest.activationEvents.some((e) => e.kind === 'onStartup')) await this.startRuntime(record);
    });
  }

  deactivate(name: string): Promise<void> {
    return this.lifecycle(name, 'deactivate', async (record, manifest) => {
      await this.stopRuntime(record);
      await this.options.hooks?.deactivate?.({ manifest, pluginDir: record.dir });
      record.state = 'inactive';
      record.errorMessage = null;
    });
  }

  /** 폴더의 plugin.json 을 다시 읽어 판이 올랐을 때만 반영한다(Shopware plugin:update) */
  update(name: string): Promise<void> {
    return this.lifecycle(name, 'update', async (record, manifest) => {
      const read = await this.readManifest(record.dir, record.name);
      if (!read?.manifest) throw new PluginLifecycleError(name, 'update', record.state, read?.error ?? 'plugin.json missing');
      const next = read.manifest;
      if (compareSemver(next.version, manifest.version) <= 0) {
        throw new PluginLifecycleError(name, 'update', record.state, `version ${next.version} is not newer than ${manifest.version}`);
      }
      const wasRunning = record.runtime !== null;
      await this.stopRuntime(record);
      await this.options.hooks?.update?.({ manifest: next, pluginDir: record.dir }, { fromVersion: manifest.version, toVersion: next.version });
      record.manifest = next;
      record.warnings = read.warnings;
      if (wasRunning && record.state === 'active' && next.activationEvents.some((e) => e.kind === 'onStartup')) await this.startRuntime(record);
    });
  }

  uninstall(name: string, options: { readonly keepUserData: boolean }): Promise<void> {
    return this.lifecycle(name, 'uninstall', async (record, manifest) => {
      await this.options.hooks?.uninstall?.({ manifest, pluginDir: record.dir }, { keepUserData: options.keepUserData });
      record.state = 'discovered';
    });
  }

  /** 앱 시작 — onStartup 플러그인을 띄운다 */
  async startup(): Promise<string[]> {
    this.startedUp = true;
    return this.fire('onStartup');
  }

  /**
   * activation event 를 알린다(예 'onView:hello.view' · 'onCommand:hello.say' · 'onEntity:cmh_ai_task').
   * active 이고 아직 안 떠 있으며 그 이벤트를 선언한 플러그인만 띄운다. 새로 띄운(또는 이미 뜨는 중이던) 이름을 돌려준다.
   */
  async fire(event: string): Promise<string[]> {
    const targets = [...this.records.values()].filter((record) => record.state === 'active' && record.runtime === null
      && record.manifest?.activationEvents.some((e) => e.raw === event));
    await Promise.all(targets.map((record) => this.startRuntime(record).catch(() => undefined)));
    return targets.filter((record) => record.runtime !== null).map((record) => record.name);
  }

  isRunning(name: string): boolean {
    return this.records.get(name)?.runtime != null;
  }

  /** 앱 끝 — 떠 있는 것 전부 내린다(생명주기 상태는 그대로) */
  async dispose(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => this.stopRuntime(record)));
  }

  // ───────────── 안쪽 ─────────────

  private summary(record: PluginRecord): PluginSummary {
    return {
      name: record.name,
      version: record.manifest?.version ?? null,
      state: record.state,
      running: record.runtime !== null,
      errorMessage: record.errorMessage,
      warnings: record.warnings,
    };
  }

  private async readManifest(dir: string, folderName: string): Promise<{ manifest: PluginManifest | null; error: string | null; warnings: readonly string[] } | null> {
    let text: string;
    try {
      text = await readFile(join(dir, 'plugin.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return { manifest: null, error: `cannot read plugin.json: ${(error as Error).message}`, warnings: [] };
    }
    const result = parseManifestText(text, { appVersion: this.options.appVersion });
    if (!result.ok) return { manifest: null, error: result.errors.join('; '), warnings: result.warnings };
    if (result.manifest.name !== folderName) {
      return { manifest: null, error: `plugin.json name "${result.manifest.name}" must equal the folder name "${folderName}"`, warnings: result.warnings };
    }
    return { manifest: result.manifest, error: null, warnings: result.warnings };
  }

  /** 같은 플러그인의 생명주기 호출은 한 줄로 세운다(동시에 activate · uninstall 이 겹치지 않게) */
  private lifecycle(name: string, action: LifecycleAction, run: (record: PluginRecord, manifest: PluginManifest) => Promise<void>): Promise<void> {
    const record = this.records.get(name);
    if (!record) return Promise.reject(new Error(`unknown plugin "${name}" (scan first)`));
    const next = record.queue.then(async () => {
      const manifest = record.manifest;
      if (!manifest) throw new PluginLifecycleError(name, action, record.state, record.errorMessage ?? 'invalid manifest');
      if (!ALLOWED_FROM[action].includes(record.state)) throw new PluginLifecycleError(name, action, record.state);
      await run(record, manifest);
    });
    record.queue = next.catch(() => undefined);
    return next;
  }

  private startRuntime(record: PluginRecord): Promise<void> {
    if (record.starting) return record.starting;
    if (record.runtime || !record.manifest) return Promise.resolve();
    const runtime = this.options.runtimeFactory({ manifest: record.manifest, pluginDir: record.dir });
    record.runtime = runtime;
    runtime.onExit(({ code, expected }) => {
      if (record.runtime !== runtime) return;
      record.runtime = null;
      this.release(record.name);
      if (!expected) this.fail(record, `plugin process exited unexpectedly (code ${code ?? 'unknown'})`);
    });
    const starting = runtime.start().then(
      () => {
        record.starting = null;
      },
      (error: unknown) => {
        record.starting = null;
        if (record.runtime === runtime) {
          record.runtime = null;
          this.release(record.name);
        }
        this.fail(record, `activation failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    );
    record.starting = starting;
    return starting;
  }

  private async stopRuntime(record: PluginRecord): Promise<void> {
    if (record.starting) await record.starting.catch(() => undefined);
    const runtime = record.runtime;
    if (!runtime) return;
    record.runtime = null;
    try {
      await runtime.stop();
    } finally {
      this.release(record.name);
    }
  }

  private release(name: string): void {
    this.options.bus?.removeOwner(name);
    this.options.services?.removeOwner(name);
  }

  private fail(record: PluginRecord, message: string): void {
    record.state = 'error';
    record.errorMessage = message;
    this.options.onError?.(record.name, message);
  }
}
