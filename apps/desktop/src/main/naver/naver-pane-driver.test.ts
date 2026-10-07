import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { NaverPaneDriver } from './naver-pane-driver.js';

describe('NaverPaneDriver.run 검증', () => {
  it('객체가 아닌 단계를 넣으면 결과 op 가 invalid 이고 첫 단계에서 멈춘다', async () => {
    const isDestroyedMock = vi.fn(() => false);
    const mockWc = {
      isDestroyed: isDestroyedMock,
    } as unknown as import('electron').WebContents;

    const driver = new NaverPaneDriver(mockWc, { allowedOrigins: ['https://example.com'] });
    const result = await driver.run([42]);

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.op).toBe('invalid');
    expect(result.steps[0]?.error).toBe('invalid-step');
    expect(result.error?.code).toBe('invalid-step');
    expect(isDestroyedMock).toHaveBeenCalledTimes(1);
  });
});
