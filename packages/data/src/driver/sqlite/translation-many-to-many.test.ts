// 1차 실제 엔티티에는 번역 칸 · n:m 이 없다 → 시험용 정의로 driver 길만 확인한다
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Criteria } from '../../criteria.js';
import { defineEntity, EntityRegistry } from '../../definition/index.js';
import { SchemaBuilder } from '../../migration/index.js';
import { hid } from '../../test-support/fixtures.js';
import { openSqliteDatabase, type SqliteHandle } from './sqlite-database.js';
import { SqliteDriver } from './sqlite-driver.js';

const registry = new EntityRegistry();
registry.register(
  defineEntity({
    entityName: 'test_note',
    fields: [
      { name: 'code', type: 'string', required: true },
      { name: 'title', type: 'string', translated: true, required: true },
      { name: 'body', type: 'text', translated: true },
    ],
    associations: [{ kind: 'manyToMany', propertyName: 'tags', reference: 'test_tag', mappingTable: 'test_note_tag', mappingLocalColumn: 'note_id', mappingReferenceColumn: 'tag_id' }],
  }),
);
registry.register(
  defineEntity({
    entityName: 'test_tag',
    fields: [{ name: 'name', type: 'string', required: true }],
    associations: [{ kind: 'manyToMany', propertyName: 'notes', reference: 'test_note', mappingTable: 'test_note_tag', mappingLocalColumn: 'tag_id', mappingReferenceColumn: 'note_id' }],
  }),
);

let h: SqliteHandle;
let ko: SqliteDriver;
let de: SqliteDriver;
beforeEach(async () => {
  h = openSqliteDatabase(':memory:');
  await SchemaBuilder.createTable(h.db, registry.get('test_note'));
  await SchemaBuilder.createTable(h.db, registry.get('test_tag'));
  await sql`CREATE TABLE test_note_tag (note_id TEXT NOT NULL REFERENCES test_note(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES test_tag(id) ON DELETE CASCADE, PRIMARY KEY (note_id, tag_id))`.execute(h.db);
  ko = new SqliteDriver({ db: h.db, registry, locale: 'ko-KR' });
  de = new SqliteDriver({ db: h.db, registry, locale: 'de-DE' });
  await ko.upsert('test_note', [
    { id: hid(1), code: 'a', title: '사과', body: '빨갛다' },
    { id: hid(2), code: 'b', title: '바나나' },
  ]);
  await de.upsert('test_note', [{ id: hid(1), title: 'Apfel' }]);
  await ko.upsert('test_tag', [
    { id: hid(11), name: 'fruit' },
    { id: hid(12), name: 'red' },
  ]);
  await sql`INSERT INTO test_note_tag VALUES (${hid(1)}, ${hid(11)}), (${hid(1)}, ${hid(12)}), (${hid(2)}, ${hid(11)})`.execute(h.db);
});
afterEach(async () => {
  await h.db.destroy();
});

describe('번역 칸(<entity>_translation · locale)', () => {
  it('locale 마다 따로 읽고 쓴다 · 번역 없는 줄은 null(서버 fallback 은 1차에 없음)', async () => {
    const k = await ko.search('test_note', new Criteria().addSorting(Criteria.sort('title', 'DESC')));
    expect(k.elements.map((e) => [e['code'], e['title'], e['body']])).toEqual([
      ['a', '사과', '빨갛다'],
      ['b', '바나나', null],
    ]);
    const d = await de.search('test_note', new Criteria().addSorting(Criteria.sort('code')));
    expect(d.elements.map((e) => e['title'])).toEqual(['Apfel', null]);
    expect((await ko.search('test_note', new Criteria().addFilter(Criteria.contains('title', '나')))).elements.map((e) => e['code'])).toEqual(['b']);
    // 같은 locale 다시 쓰면 덮는다
    await ko.upsert('test_note', [{ id: hid(2), body: '노랗다' }]);
    expect((await ko.get('test_note', hid(2)))?.['body']).toBe('노랗다');
  });

  it('새 줄은 번역 필수 칸도 있어야 한다', async () => {
    await expect(ko.upsert('test_note', [{ code: 'c' }])).rejects.toThrow(/필수 칸 'title'/);
  });
});

describe('manyToMany(중간 테이블)', () => {
  it('짝을 읽어 채운다 · 대상 정렬 · 연관 경로 필터', async () => {
    const c = new Criteria().addSorting(Criteria.sort('code'));
    c.getAssociation('tags').addSorting(Criteria.sort('name', 'DESC'));
    const r = await ko.search('test_note', c);
    expect(r.elements.map((e) => [e['code'], (e['tags'] as Array<Record<string, unknown>>).map((t) => t['name'])])).toEqual([
      ['a', ['red', 'fruit']],
      ['b', ['fruit']],
    ]);
    const red = await ko.search('test_note', new Criteria().addFilter(Criteria.equals('tags.name', 'red')));
    expect(red.elements.map((e) => e['code'])).toEqual(['a']);
    const back = await ko.search('test_tag', new Criteria().addFilter(Criteria.equals('notes.title', '바나나')));
    expect(back.elements.map((e) => e['name'])).toEqual(['fruit']);
  });
});
