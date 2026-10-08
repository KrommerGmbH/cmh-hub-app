// R7-c — Migration1791417600SystemConfig · system_config 정의(로컬 앱 전용 설정 행)
import { describe, expect, it } from 'vitest';
import { Criteria } from '../criteria.js';
import { DataWriteError } from '../driver/types.js';
import { DataSourceFactory } from '../repository.js';

const NOW = '2026-10-08T00:00:00.000Z';
const CHANNEL_A = 'a'.repeat(32);
const CHANNEL_B = 'b'.repeat(32);

describe('system_config — SettingsStore 저장 자리', () => {
  it('json 칸은 객체로 쓰고 객체로 읽는다 · 칸 이름은 camelCase 응답', async () => {
    const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:' });
    expect(ds.migration?.updated).toContain('Migration1791417600SystemConfig');
    const repo = ds.repository('system_config');
    const id = '1'.repeat(32);
    await repo.upsert([
      { id, configuration_key: 'app.ui.theme', configuration_value: { _value: { mode: 'dark', n: [1, 2] } }, sales_channel_id: null, created_at: NOW, updated_at: null },
    ]);
    const r = await repo.search(new Criteria().addFilter(Criteria.equals('configurationKey', 'app.ui.theme')));
    expect(r.elements).toEqual([
      { id, configurationKey: 'app.ui.theme', configurationValue: { _value: { mode: 'dark', n: [1, 2] } }, salesChannelId: null, createdAt: NOW, updatedAt: null },
    ]);
    await ds.close();
  });

  it('null 채널은 키 하나에 한 줄(부분 UNIQUE 색인) · 판매채널이 다르면 같은 키 여럿', async () => {
    const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:' });
    const repo = ds.repository('system_config');
    const row = (id: string, channel: string | null) => ({ id, configurationKey: 'app.ui.theme', configurationValue: { _value: 1 }, salesChannelId: channel, createdAt: NOW });
    await repo.upsert([row('1'.repeat(32), null)]);
    await expect(repo.upsert([row('2'.repeat(32), null)])).rejects.toThrow(DataWriteError);
    await repo.upsert([row('3'.repeat(32), CHANNEL_A), row('4'.repeat(32), CHANNEL_B)]);
    await expect(repo.upsert([row('5'.repeat(32), CHANNEL_A)])).rejects.toThrow(DataWriteError);
    // 키는 대소문자를 가른다(SettingsStore 캐시 Map 과 같다)
    await repo.upsert([{ ...row('6'.repeat(32), null), configurationKey: 'APP.ui.theme' }]);
    expect((await repo.searchIds({})).ids).toHaveLength(4);
    await ds.close();
  });

  it('필수 칸 — configuration_key · configuration_value 가 없으면 새 줄 거부', async () => {
    const ds = await DataSourceFactory.create({ dataSource: 'local', filename: ':memory:' });
    const repo = ds.repository('system_config');
    await expect(repo.upsert([{ configurationKey: 'app.ui.theme' }])).rejects.toThrow(/configurationValue/);
    await expect(repo.upsert([{ configurationValue: { _value: 1 } }])).rejects.toThrow(/configurationKey/);
    await ds.close();
  });
});
