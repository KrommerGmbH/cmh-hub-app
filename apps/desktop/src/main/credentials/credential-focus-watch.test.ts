import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: { buildFromTemplate: () => ({ popup: () => undefined }) }, app: {}, safeStorage: {}, Notification: {} }));
const { clickIsInsideActiveField, shouldOfferAccounts } = await import('./credential-focus-watch.js');

const anchor = { x: 10, y: 40 };

describe('왼쪽 클릭 계정 목록(U08b · 2026-10-05 «필드 클릭해도 자동 넣기 안됨»)', () => {
  it('비어 있는 아이디 · 비밀번호 칸을 누르고 저장된 계정이 있으면 띄운다', () => {
    expect(shouldOfferAccounts({ active: 'username', usernameEmpty: true, activeAnchor: anchor }, 1)).toBe(true);
    expect(shouldOfferAccounts({ active: 'password', usernameEmpty: true, activeAnchor: anchor }, 2)).toBe(true);
  });

  it('로그인 칸이 아닌 곳 · 아이디가 이미 있음 · 저장된 계정 0 · 칸이 화면 밖이면 안 띄운다', () => {
    expect(shouldOfferAccounts({ active: null, usernameEmpty: true, activeAnchor: null }, 1)).toBe(false);
    expect(shouldOfferAccounts({ active: 'username', usernameEmpty: false, activeAnchor: anchor }, 1)).toBe(false);
    expect(shouldOfferAccounts({ active: 'username', usernameEmpty: true, activeAnchor: anchor }, 0)).toBe(false);
    expect(shouldOfferAccounts({ active: 'username', usernameEmpty: true, activeAnchor: null }, 1)).toBe(false);
  });

  it('누른 점이 포커스된 칸 상자 안일 때만 — 빈 곳 · 버튼을 눌러 포커스가 칸에 남은 경우는 아니다 · 줌 배율을 곱한다', () => {
    const field = { activeRect: { left: 100, top: 50, right: 300, bottom: 80 } };
    expect(clickIsInsideActiveField(field, { x: 150, y: 60 }, 1)).toBe(true);
    expect(clickIsInsideActiveField(field, { x: 150, y: 200 }, 1)).toBe(false); // 아래 로그인 단추
    expect(clickIsInsideActiveField(field, { x: 300, y: 80 }, 1.25)).toBe(true); // 줌 125% 에서 (240,64) 자리
    expect(clickIsInsideActiveField({ activeRect: null }, { x: 150, y: 60 }, 1)).toBe(false);
  });
});
