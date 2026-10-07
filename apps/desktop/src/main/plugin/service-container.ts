// R2-a — 서비스 컨테이너(DI). electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// Shopware `services.php` 의 `decorate` + `.inner` 체인 · Theia `rebind` 자리. 1차는 main 안 서비스만(플러그인 프로세스 쪽 서비스는 RPC 다음 차례).
// 겹치는 차례: register 한 바탕 위에 decorate 를 등록 차례대로 씌운다 → 마지막에 등록한 decorator 가 바깥(get 이 돌려주는 것).
//
// ⚠ Shopware 와 같은 위험: decorator 가 안쪽(inner)을 부르지 않으면 그 아래 체인(바탕 + 먼저 씌운 decorator)이 통째로 끊긴다.
//   이 컨테이너는 그것을 알아챌 수 없다(호출 여부는 실행 중에만 보인다). PLAN R2 §5 «안 부르면 예외» 는 1차에서 못 지킨다 —
//   decorator 를 쓰는 플러그인은 «안쪽을 반드시 부른다» 를 리뷰로 지키고, 서비스 인터페이스는 작게 둔다.
//   (같은 서비스를 두 플러그인이 decorate 하면 등록 차례대로 체인 · Shopware 와 같다.)

export type ServiceFactory<T> = (container: ServiceContainer) => T;
export type DecoratorFactory<T> = (inner: T, container: ServiceContainer) => T;

interface Entry {
  base: { readonly factory: ServiceFactory<unknown>; readonly owner: string | null } | null;
  readonly decorators: { readonly factory: DecoratorFactory<unknown>; readonly owner: string | null }[];
  instance: { value: unknown } | null;
}

export class ServiceContainer {
  private readonly entries = new Map<string, Entry>();
  private readonly building = new Set<string>();

  register<T>(id: string, factory: ServiceFactory<T>, owner: string | null = null): void {
    const entry = this.entry(id);
    if (entry.base) throw new Error(`service "${id}" is already registered${entry.base.owner ? ` by ${entry.base.owner}` : ''}`);
    entry.base = { factory: factory as ServiceFactory<unknown>, owner };
    this.invalidateAll();
  }

  /** register 보다 먼저 불러도 된다(바탕이 생길 때 씌운다) · get 때 만들어진다 */
  decorate<T>(id: string, factory: DecoratorFactory<T>, owner: string | null = null): void {
    this.entry(id).decorators.push({ factory: factory as DecoratorFactory<unknown>, owner });
    this.invalidateAll();
  }

  has(id: string): boolean {
    return this.entries.get(id)?.base != null;
  }

  get<T>(id: string): T {
    const entry = this.entries.get(id);
    if (!entry?.base) throw new Error(`service "${id}" is not registered`);
    if (entry.instance) return entry.instance.value as T;
    if (this.building.has(id)) throw new Error(`service "${id}" depends on itself`);
    this.building.add(id);
    try {
      let value = entry.base.factory(this);
      for (const decorator of entry.decorators) value = decorator.factory(value, this);
      entry.instance = { value };
      return value as T;
    } finally {
      this.building.delete(id);
    }
  }

  /** 플러그인을 내릴 때 — 그 주인의 바탕 · decorator 를 걷고 만든 것을 버린다. 지운 수를 돌려준다. */
  removeOwner(owner: string): number {
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (entry.base?.owner === owner) {
        entry.base = null;
        removed++;
      }
      const before = entry.decorators.length;
      for (let i = entry.decorators.length - 1; i >= 0; i--) {
        if (entry.decorators[i]?.owner === owner) entry.decorators.splice(i, 1);
      }
      removed += before - entry.decorators.length;
    }
    if (removed > 0) this.invalidateAll();
    return removed;
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { base: null, decorators: [], instance: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** 다른 서비스가 이 서비스를 붙잡고 만들어졌을 수 있으므로 만든 것 전부를 버린다(1차는 단순하게) */
  private invalidateAll(): void {
    for (const entry of this.entries.values()) entry.instance = null;
  }
}
