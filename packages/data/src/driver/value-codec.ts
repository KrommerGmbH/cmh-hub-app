// R1 — 칸 종류별 값 바꾸기. 저장(SQLite): bool 0/1 · json 글자 · datetime ISO(UTC · ms) · date YYYY-MM-DD.
// 응답: Shopware 처럼 camelCase 속성 · bool true/false · json 객체 · datetime ISO 글자.
import { isId } from '../naming.js';
import type { FieldDefinition } from '../definition/types.js';

export class ValueError extends Error {
  override readonly name = 'ValueError';
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDateTime(value: unknown, at: string): string {
  const d = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
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
