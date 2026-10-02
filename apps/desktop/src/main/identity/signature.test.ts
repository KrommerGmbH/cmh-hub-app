import { describe, expect, it } from 'vitest';
import { generateIdentityKeys, signaturePayload, signHeaders, verifyHeaders } from './signature.js';

describe('H03 서명', () => {
  it('서명 대상 = id|ts|nonce|METHOD|path(쿼리 뺌)', () => {
    expect(signaturePayload('i1', 1790000000, 'n1', 'post', 'https://h.test/api/search/product?x=1')).toBe('i1|1790000000|n1|POST|/api/search/product');
  });
  it('서명 → 검증 성공 · path 가 다르면 실패 · 다른 키면 실패', () => {
    const keys = generateIdentityKeys();
    const url = 'https://h.test/api/_action/cmh-hub-app/heartbeat';
    const h = signHeaders({ installationId: 'i1', privateKey: keys.privateKeyPem, method: 'POST', url, appVersion: '0.1.0' });
    expect(verifyHeaders(h, keys.publicKeyPem, 'POST', url)).toBe(true);
    expect(verifyHeaders(h, keys.publicKeyPem, 'POST', 'https://h.test/api/other')).toBe(false);
    expect(verifyHeaders(h, generateIdentityKeys().publicKeyPem, 'POST', url)).toBe(false);
    expect(h['X-Cmh-App-Nonce']).toMatch(/^[0-9a-f]{32}$/);
  });
});
