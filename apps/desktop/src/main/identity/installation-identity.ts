// H01 — 설치 ID + Ed25519 키. 첫 실행 때 만들고 userData/installation.json 에 둔다. 개인키는 safeStorage 로 암호화.
// 하드웨어 일련번호 · MAC · 컴퓨터 이름은 모으지 않는다(GDPR 최소 수집).
import { app, safeStorage } from 'electron';
import { randomUUID, createPrivateKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentityKeys } from './signature.js';

interface StoredIdentity {
  installationId: string;
  publicKeyPem: string;
  encryptedPrivateKey: string;
  createdAt: string;
}

export interface InstallationIdentity {
  installationId: string;
  publicKeyPem: string;
  privateKey: KeyObject;
}

export function ensureInstallationIdentity(): InstallationIdentity {
  const file = join(app.getPath('userData'), 'installation.json');
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as StoredIdentity;
      const pem = safeStorage.decryptString(Buffer.from(s.encryptedPrivateKey, 'base64'));
      return { installationId: s.installationId, publicKeyPem: s.publicKeyPem, privateKey: createPrivateKey(pem) };
    } catch (e) {
      console.warn('[identity] installation.json 을 못 읽어 새로 만듭니다', e);
    }
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage 를 쓸 수 없어 설치 키를 안전하게 둘 수 없습니다');
  const keys = generateIdentityKeys();
  const stored: StoredIdentity = {
    installationId: randomUUID(),
    publicKeyPem: keys.publicKeyPem,
    encryptedPrivateKey: safeStorage.encryptString(keys.privateKeyPem).toString('base64'),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
  return { installationId: stored.installationId, publicKeyPem: stored.publicKeyPem, privateKey: createPrivateKey(keys.privateKeyPem) };
}
