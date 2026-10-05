import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore, MAX_ACCOUNTS_PER_KIND, type StringCipher } from './credential-store.js';

/** 가짜 암호화 — 글자를 뒤집고 표시를 붙인다(평문이 파일에 그대로 안 남는지 보려고) */
function fakeCipher(available = true): StringCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`ENC:${[...text].reverse().join('')}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad');
      return [...s.slice(4)].reverse().join('');
    },
  };
}

const dirs: string[] = [];
function newStore(available = true, clock = { t: Date.parse('2026-10-05T10:00:00Z') }) {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  dirs.push(dir);
  const file = join(dir, 'credentials.json');
  const store = new CredentialStore(file, fakeCipher(available), () => new Date((clock.t += 1000)));
  return { store, file };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('저장된 계정(U08)', () => {
  it('저장 → 목록에는 아이디만 · 파일에는 아이디도 비밀번호도 평문으로 없다', () => {
    const { store, file } = newStore();
    expect(store.save('admin', 'kang@x.de', 'Geheim!123')).toBe(true);
    expect(store.list('admin')).toEqual([{ username: 'kang@x.de', lastUsedAt: expect.any(String) }]);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('kang@x.de');
    expect(raw).not.toContain('Geheim!123');
  });

  it('같은 아이디로 다시 저장하면 덮어쓴다 · 종류(kind)끼리 안 섞인다', () => {
    const { store } = newStore();
    store.save('admin', 'a', 'old');
    store.save('admin', 'a', 'new');
    store.save('naver', 'a', 'naverpw');
    expect(store.list('admin')).toHaveLength(1);
    expect(store.takePasswordForFill('admin', 'a')).toBe('new');
    expect(store.takePasswordForFill('naver', 'a')).toBe('naverpw');
  });

  it('최근 쓴 순 · 넣으면 맨 앞으로 · 지우기', () => {
    const { store } = newStore();
    store.save('naver', 'first', 'p1');
    store.save('naver', 'second', 'p2');
    expect(store.list('naver').map((a) => a.username)).toEqual(['second', 'first']);
    store.takePasswordForFill('naver', 'first');
    expect(store.list('naver').map((a) => a.username)).toEqual(['first', 'second']);
    store.remove('naver', 'first');
    expect(store.list('naver').map((a) => a.username)).toEqual(['second']);
  });

  it(`종류마다 ${MAX_ACCOUNTS_PER_KIND}개까지 — 넘으면 가장 오래 안 쓴 것을 버린다`, () => {
    const { store } = newStore();
    for (let i = 0; i < MAX_ACCOUNTS_PER_KIND + 2; i++) store.save('admin', `u${i}`, 'p');
    const names = store.list('admin').map((a) => a.username);
    expect(names).toHaveLength(MAX_ACCOUNTS_PER_KIND);
    expect(names).not.toContain('u0');
    expect(names).not.toContain('u1');
  });

  it('빈 아이디 · 빈 비밀번호는 저장하지 않는다 · 없는 계정은 null', () => {
    const { store } = newStore();
    expect(store.save('admin', '  ', 'p')).toBe(false);
    expect(store.save('admin', 'a', '')).toBe(false);
    expect(store.takePasswordForFill('admin', 'nobody')).toBeNull();
  });

  it('못 푸는 파일(다른 Windows 계정 · 깨짐)이면 저장 · 지우기가 거부되고 파일을 덮어쓰지 않는다', () => {
    const { store, file } = newStore();
    store.save('admin', 'keep', 'p');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.replace(/"blob":"/, '"blob":"QUJD'), 'utf8'); // 복호화가 실패하게
    const broken = readFileSync(file, 'utf8');
    expect(store.list('admin')).toEqual([]);
    expect(store.save('admin', 'new', 'p2')).toBe(false);
    expect(store.remove('admin', 'keep')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('암호화를 못 쓰면 저장 · 목록 · 넣기가 전부 꺼진다(평문 저장 0)', () => {
    const { store } = newStore(false);
    expect(store.save('admin', 'a', 'p')).toBe(false);
    expect(store.list('admin')).toEqual([]);
    expect(store.takePasswordForFill('admin', 'a')).toBeNull();
  });
});
