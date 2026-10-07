// R1 — Shopware MigrationStep 꼴: creationTimestamp · update(db) · updateDestructive(db) (2026-10-07)
// update = 되돌릴 수 있는 것(테이블 · 칸 더하기) · updateDestructive = 지우기 · 이름 바꾸기 — 앱 판 올림 때만 돈다(PLAN R1 §5 ④)
import type { Kysely } from 'kysely';

export abstract class Migration {
  /** 유닉스 초 — 이 순서로 돈다 */
  abstract readonly creationTimestamp: number;

  /** `migration.class` 에 적히는 이름. 기본은 클래스 이름(번들러가 이름을 줄이면 덮어써야 한다) */
  get className(): string {
    return this.constructor.name;
  }

  abstract update(db: Kysely<any>): Promise<void>;

  updateDestructive(_db: Kysely<any>): Promise<void> {
    return Promise.resolve();
  }
}
