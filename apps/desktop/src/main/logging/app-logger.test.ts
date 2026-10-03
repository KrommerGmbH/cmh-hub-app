import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'cmh-hub-log-'));
vi.mock('electron', () => ({ app: { getPath: () => userData, on: () => undefined, getName: () => 'test', getVersion: () => '0.0.0' } }));

const { ERROR_REPORT_TAG, pendingErrorReportCount, returnErrorReportBatch, takeErrorReportBatch, writeLog } = await import('./app-logger.js');

describe('오류 보내기 줄(2026-10-03)', () => {
  it('warn · error 만 담고 info 와 보내는 쪽 자신의 로그는 안 담는다', () => {
    takeErrorReportBatch(1000);
    writeLog('info', '보통 글');
    writeLog('warn', '경고', { a: 1 });
    writeLog('error', new Error('터짐'));
    writeLog('warn', `${ERROR_REPORT_TAG} 보내기 실패`);
    const batch = takeErrorReportBatch();
    expect(batch.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(batch[0]?.message).toBe('경고 {"a":1}');
    expect(batch[1]?.message).toContain('Error: 터짐');
  });

  it('긴 글은 4000자로 자르고 200건 넘으면 오래된 것부터 버린다', () => {
    takeErrorReportBatch(1000);
    writeLog('error', 'x'.repeat(5000));
    expect(takeErrorReportBatch()[0]?.message).toHaveLength(4000);
    for (let i = 0; i < 250; i++) writeLog('warn', `w${i}`);
    expect(pendingErrorReportCount()).toBe(200);
    expect(takeErrorReportBatch(1)[0]?.message).toBe('w50');
  });

  it('보내기 실패면 되돌린 묶음이 앞에 선다', () => {
    takeErrorReportBatch(1000);
    writeLog('warn', 'a');
    writeLog('warn', 'b');
    const first = takeErrorReportBatch(1);
    returnErrorReportBatch(first);
    expect(takeErrorReportBatch().map((e) => e.message)).toEqual(['a', 'b']);
  });
});
