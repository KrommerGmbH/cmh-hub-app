// U08 — 사람이 «이 계정 저장»으로 맡긴 아이디 · 비밀번호. userData/credentials.json 에 «통째로» 암호화(safeStorage = Windows DPAPI)해 둔다.
// 서버로는 보내지 않는다. 비밀번호는 getPassword 를 부른 함수 밖으로 안 나간다 — 로그(console)에 entry · 아이디 · 비밀번호를 넘기지 않는다
// (app-logger 가 console 을 파일에 쓰고 warn · error 는 서버로 보낸다).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TabKind } from '@cmh-hub-app/contracts';

/** safeStorage 중 쓰는 것 셋 — 시험에서 가짜로 바꾼다 */
export interface StringCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface CredentialEntry {
  kind: TabKind;
  username: string;
  password: string;
  lastUsedAt: string;
}

export interface SavedAccount {
  username: string;
  lastUsedAt: string;
}

/** kind 마다 이만큼까지 — 넘으면 가장 오래 안 쓴 것을 버린다 */
export const MAX_ACCOUNTS_PER_KIND = 10;

export class CredentialStore {
  private warnedUnavailable = false;

  constructor(
    private readonly filePath: string,
    private readonly cipher: StringCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 암호화를 못 쓰면 기능을 끈다(평문 저장은 하지 않는다) */
  available(): boolean {
    const ok = this.cipher.isEncryptionAvailable();
    if (!ok && !this.warnedUnavailable) {
      this.warnedUnavailable = true;
      console.warn('[credential] safeStorage 를 쓸 수 없어 계정 저장 · 자동입력을 끕니다');
    }
    return ok;
  }

  /** 최근 쓴 순 · 비밀번호는 안 준다 */
  list(kind: TabKind): SavedAccount[] {
    if (!this.available()) return [];
    return this.readAll()
      .filter((e) => e.kind === kind)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .map((e) => ({ username: e.username, lastUsedAt: e.lastUsedAt }));
  }

  /** 같은 kind · 아이디면 덮어쓴다. 빈 아이디 · 빈 비밀번호는 저장하지 않는다. 못 푸는 파일이 있으면 덮어쓰지 않고 거부한다 */
  save(kind: TabKind, username: string, password: string): boolean {
    if (!this.available() || username.trim() === '' || password === '') return false;
    const all = this.readAllForWrite();
    if (!all) return false;
    const others = all.filter((e) => !(e.kind === kind && e.username === username));
    const entry: CredentialEntry = { kind, username, password, lastUsedAt: this.now().toISOString() };
    const sameKind = [entry, ...others.filter((e) => e.kind === kind)]
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, MAX_ACCOUNTS_PER_KIND);
    this.writeAll([...others.filter((e) => e.kind !== kind), ...sameKind]);
    return true;
  }

  /** 자동 저장 전에 — 같은 kind · 아이디 · 비밀번호가 이미 있나(있으면 다시 쓰지 · 알리지 않는다) */
  hasSame(kind: TabKind, username: string, password: string): boolean {
    if (!this.available()) return false;
    return this.readAll().some((e) => e.kind === kind && e.username === username && e.password === password);
  }

  remove(kind: TabKind, username: string): boolean {
    if (!this.available()) return false;
    const all = this.readAllForWrite();
    if (!all) return false;
    this.writeAll(all.filter((e) => !(e.kind === kind && e.username === username)));
    return true;
  }

  /** 넣을 때만 부른다 — 쓴 시각을 갱신하고 비밀번호를 돌려준다(갱신을 못 써도 비밀번호는 준다) */
  takePasswordForFill(kind: TabKind, username: string): string | null {
    if (!this.available()) return null;
    const all = this.readAll();
    const entry = all.find((e) => e.kind === kind && e.username === username);
    if (!entry) return null;
    entry.lastUsedAt = this.now().toISOString();
    this.writeAll(all);
    return entry.password;
  }

  /** 읽기용 — 못 풀면 빈 목록 */
  private readAll(): CredentialEntry[] {
    return this.readAllForWrite() ?? [];
  }

  /**
   * 쓰기 전 읽기 — 파일이 없으면 빈 목록, 있는데 못 풀면 null(덮어쓰지 않는다 · 제미나이 검수 2026-10-05).
   * 다른 Windows 계정 · DPAPI 일시 오류 · 깨진 파일에서 저장을 누르면 남은 계정을 모두 잃기 때문이다. 파일은 사람이 지운다.
   */
  private readAllForWrite(): CredentialEntry[] | null {
    if (!existsSync(this.filePath)) return [];
    try {
      const file = JSON.parse(readFileSync(this.filePath, 'utf8')) as { version?: unknown; blob?: unknown };
      if (file.version !== 1 || typeof file.blob !== 'string') throw new Error('shape');
      const entries: unknown = JSON.parse(this.cipher.decryptString(Buffer.from(file.blob, 'base64')));
      if (!Array.isArray(entries)) throw new Error('shape');
      return entries as CredentialEntry[];
    } catch {
      // 오류 객체도 안 적는다 — 복호화 오류 글에 무엇이 섞일지 모른다
      console.warn('[credential] credentials.json 을 못 풀어 저장 · 지우기를 막습니다(다른 Windows 계정 · 깨진 파일)');
      return null;
    }
  }

  /** tmp 에 쓰고 rename — 쓰다 죽어도 옛 파일은 산다(layout-store 꼴) */
  private writeAll(entries: CredentialEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const blob = this.cipher.encryptString(JSON.stringify(entries)).toString('base64');
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, blob }), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
