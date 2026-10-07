// R1 — 칸 종류별 값 바꾸기. 저장(SQLite): bool 0/1 · json 글자 · datetime ISO(UTC · ms) · date YYYY-MM-DD.
// 시간대 없는 날짜시각 · 날짜만 글자는 UTC 로 읽는다(컴퓨터 시간대와 무관 · 2026-10-07 검수 B2).
// 응답: Shopware 처럼 camelCase 속성 · bool true/false · json 객체 · datetime ISO 글자.
import { isId } from '../naming.js';
import type { FieldDefinition } from '../definition/types.js';

export class ValueError extends Error {
  override readonly name = 'ValueError';
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 시간대 없는 날짜시각(`2026-10-07 09:00:00` · `2026-10-07T09:00` · `.123` 붙은 것). JS `new Date()` 는 이것을 «내 컴퓨터 시간대»로
 * 읽는다(공백 꼴은 엔진마다 다름) → 같은 값이 컴퓨터마다 다른 시각이 된다. Shopware 는 날짜시각을 UTC 로 `Y-m-d H:i:s.v` 꼴로 저장한다
 * (Defaults::STORAGE_DATE_TIME_FORMAT) — 그래서 시간대 없는 값은 UTC 로 읽는다(2026-10-07 검수 B2).
 */
const NAIVE_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** 글자 → Date. 시간대 없는 꼴 · 날짜만은 UTC 로 · 나머지(`Z` · `+09:00` 붙은 것)는 그 시간대대로 */
function parseDateTimeString(value: string): Date {
  if (DATE_ONLY.test(value)) return new Date(`${value}T00:00:00Z`);
  const naive = NAIVE_DATE_TIME.exec(value);
  if (naive) return new Date(`${naive[1] ?? ''}T${naive[2] ?? ''}Z`);
  return new Date(value);
}

export function normalizeDateTime(value: unknown, at: string): string {
  const d = value instanceof Date ? value : typeof value === 'string' ? parseDateTimeString(value) : typeof value === 'number' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new ValueError(`${at}: 날짜시각으로 읽을 수 없다 (${String(value)})`);
  return d.toISOString();
}

export function normalizeDate(value: unknown, at: string): string {
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
  return normalizeDateTime(value, at).slice(0, 10);
}

function toBool(value: unknown, at: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new ValueError(`${at}: 참거짓이 아니다 (${String(value)})`);
}

function toNumber(value: unknown, at: string, integer: boolean): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValueError(`${at}: 수가 아니다 (${String(value)})`);
  if (integer && !Number.isInteger(n)) throw new ValueError(`${at}: 정수가 아니다 (${String(value)})`);
  return n;
}

/** 쓰기 · 필터 값 → SQLite 값. null 은 그대로 */
export function toStorage(field: FieldDefinition, value: unknown, at: string): string | number | null {
  if (value === null) return null;
  if (value === undefined) throw new ValueError(`${at}: 값이 undefined 다`);
  switch (field.type) {
    case 'id':
    case 'fk':
      if (!isId(value)) throw new ValueError(`${at}: 32자 hex id 가 아니다 (${String(value)})`);
      return value;
    case 'string':
    case 'text':
      if (typeof value !== 'string') throw new ValueError(`${at}: 글자가 아니다`);
      return value;
    case 'int':
      return toNumber(value, at, true);
    case 'float':
      return toNumber(value, at, false);
    case 'bool':
      return toBool(value, at) ? 1 : 0;
    case 'json':
      return JSON.stringify(value);
    case 'datetime':
      return normalizeDateTime(value, at);
    case 'date':
      return normalizeDate(value, at);
  }
}

/** SQLite 값 → 응답 값 */
export function fromStorage(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'bool':
      return value === 1 || value === true || value === '1';
    case 'json':
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    case 'int':
    case 'float':
      return typeof value === 'number' ? value : Number(value);
    default:
      return value;
  }
}

/** 서버 JSON 응답 값 → 로컬 응답과 같은 꼴(대조용 · datetime 은 서버가 `+00:00` 꼴로 줄 수 있다) */
export function fromServer(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'datetime':
      return normalizeDateTime(value, field.name);
    case 'date':
      return normalizeDate(value, field.name);
    case 'int':
    case 'float':
      return typeof value === 'number' ? value : Number(value);
    case 'bool':
      return typeof value === 'boolean' ? value : value === 1 || value === '1';
    default:
      return value;
  }
}
