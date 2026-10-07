// R2-a — 관찰용 이벤트 버스. electron 을 import 하지 않는 순수 모듈(vitest 로 시험한다).
// Shopware EventSubscriber 와 같은 자리: «observation and enrichment» 만 — 흐름을 바꾸려면 ServiceContainer.decorate 를 쓴다.
// 그래서 핸들러의 반환값은 버리고, 한 핸들러가 던져도 다른 핸들러는 계속 돈다(오류는 onError 로 알린다).
// 주인(owner = 플러그인 이름)을 달아 두면 removeOwner 한 번으로 그 플러그인 구독이 전부 풀린다(Obsidian `registerEvent` 꼴).

export type EventHandler = (payload: unknown, event: string) => unknown;

export interface Disposable {
  dispose(): void;
}

export interface EventBusOptions {
  /** 핸들러 예외 · 거부된 Promise 를 받는다. 주지 않으면 조용히 버리지 않고 console.error 로 남긴다. */
  readonly onError?: (error: unknown, event: string, owner: string | null) => void;
}

interface Subscription {
  readonly event: string;
  readonly handler: EventHandler;
  readonly owner: string | null;
}

export class EventBus {
  private readonly byEvent = new Map<string, Subscription[]>();
  private readonly onError: (error: unknown, event: string, owner: string | null) => void;

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError ?? ((error, event, owner) => console.error(`[event-bus] handler failed (${event}${owner ? ` · ${owner}` : ''})`, error));
  }

  on(event: string, handler: EventHandler, owner: string | null = null): Disposable {
    const subscription: Subscription = { event, handler, owner };
    const list = this.byEvent.get(event) ?? [];
    list.push(subscription);
    this.byEvent.set(event, list);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.remove(subscription);
      },
    };
  }

  /** 한 주인(플러그인) 이름에 묶인 구독 도우미 — unload 때 removeOwner(owner) 로 한꺼번에 풀린다 */
  scope(owner: string): { on(event: string, handler: EventHandler): Disposable } {
    return { on: (event, handler) => this.on(event, handler, owner) };
  }

  /** 등록 차례대로 부른다. 모든 핸들러(비동기 포함)가 끝날 때까지 기다리지만 실패는 onError 로만 알리고 던지지 않는다. */
  async emit(event: string, payload?: unknown): Promise<void> {
    const list = [...(this.byEvent.get(event) ?? [])];
    const pending: Promise<void>[] = [];
    for (const subscription of list) {
      try {
        const result = subscription.handler(payload, event);
        if (result instanceof Promise) {
          pending.push(result.then(() => undefined, (error: unknown) => this.onError(error, event, subscription.owner)));
        }
      } catch (error) {
        this.onError(error, event, subscription.owner);
      }
    }
    await Promise.all(pending);
  }

  /** 지운 구독 수를 돌려준다 */
  removeOwner(owner: string): number {
    let removed = 0;
    for (const [event, list] of this.byEvent) {
      const kept = list.filter((s) => s.owner !== owner);
      removed += list.length - kept.length;
      if (kept.length === 0) this.byEvent.delete(event);
      else this.byEvent.set(event, kept);
    }
    return removed;
  }

  listenerCount(event?: string, owner?: string): number {
    const lists = event === undefined ? [...this.byEvent.values()] : [this.byEvent.get(event) ?? []];
    return lists.reduce((sum, list) => sum + list.filter((s) => owner === undefined || s.owner === owner).length, 0);
  }

  private remove(subscription: Subscription): void {
    const list = this.byEvent.get(subscription.event);
    if (!list) return;
    const index = list.indexOf(subscription);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.byEvent.delete(subscription.event);
  }
}
