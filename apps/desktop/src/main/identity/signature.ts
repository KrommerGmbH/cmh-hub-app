// H03 — 서명 대상 문자열 · Ed25519 서명. electron 을 import 하지 않는 순수 모듈(vitest).
// 서명 대상 = installationId|timestamp|nonce|METHOD|path (body 없음 · path 는 쿼리 뺀 경로) — 서버 T41-2 와 같은 규칙(2026-10-02 하나로 맞춤).
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { APP_HEADERS } from '@cmh-hub-app/contracts';

export function signaturePayload(installationId: string, timestamp: number, nonce: string, method: string, url: string): string {
  const path = new URL(url, 'https://placeholder.invalid').pathname;
  return [installationId, String(timestamp), nonce, method.toUpperCase(), path].join('|');
}

export function generateIdentityKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signHeaders(
  args: { installationId: string; privateKey: KeyObject | string; method: string; url: string; appVersion: string; now?: number },
): Record<string, string> {
  const timestamp = Math.floor((args.now ?? Date.now()) / 1000);
  const nonce = randomBytes(16).toString('hex');
  const key = typeof args.privateKey === 'string' ? createPrivateKey(args.privateKey) : args.privateKey;
  const signature = sign(null, Buffer.from(signaturePayload(args.installationId, timestamp, nonce, args.method, args.url)), key).toString('base64');
  return {
    [APP_HEADERS.installation]: args.installationId,
    [APP_HEADERS.timestamp]: String(timestamp),
    [APP_HEADERS.nonce]: nonce,
    [APP_HEADERS.signature]: signature,
    [APP_HEADERS.version]: args.appVersion,
  };
}

/** 시험용 — 서버가 하는 검증과 같은 계산 */
export function verifyHeaders(headers: Record<string, string>, publicKeyPem: string, method: string, url: string): boolean {
  const payload = signaturePayload(
    headers[APP_HEADERS.installation] ?? '',
    Number(headers[APP_HEADERS.timestamp]),
    headers[APP_HEADERS.nonce] ?? '',
    method,
    url,
  );
  return verify(null, Buffer.from(payload), publicKeyPem, Buffer.from(headers[APP_HEADERS.signature] ?? '', 'base64'));
}
