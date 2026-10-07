import { describe, expect, it } from 'vitest';
import { EventBus } from './event-bus.js';

describe('EventBus — 관찰용 · 주인별 자동 해제', () => {
  it('등록 차례대로 부르고 dispose 로 하나를 푼다', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('app.ready', (payload) => { seen.push(`a:${String(payload)}`); });
    const second = bus.on('app.ready', () => { seen.push('b'); });
    await bus.emit('app.ready', 1);
    second.dispose();
    second.dispose();
    await bus.emit('app.ready', 2);
    expect(seen).toEqual(['a:1', 'b', 'a:2']);
  });
  it('플러그인 unload(removeOwner) 때 그 플러그인 구독만 풀린다(Obsidian registerEvent 꼴)', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const hello = bus.scope('plugin-hello');
    hello.on('app.ready', () => { seen.push('hello-1'); });
    hello.on('entity.written', () => { seen.push('hello-2'); });
    bus.on('app.ready', () => { seen.push('core'); });
    expect(bus.listenerCount(undefined, 'plugin-hello')).toBe(2);
    expect(bus.removeOwner('plugin-hello')).toBe(2);
    await bus.emit('app.ready');
    await bus.emit('entity.written');
    expect(seen).toEqual(['core']);
    expect(bus.listenerCount()).toBe(1);
  });
  it('한 핸들러가 던지거나 거부돼도 다른 핸들러는 돌고 emit 은 던지지 않는다', async () => {
    const errors: string[] = [];
    const bus = new EventBus({ onError: (error, event, owner) => errors.push(`${event}/${owner}/${(error as Error).message}`) });
    const seen: string[] = [];
    bus.on('x', () => { throw new Error('sync'); }, 'p1');
    bus.on('x', async () => { throw new Error('async'); }, 'p2');
    bus.on('x', () => { seen.push('ok'); });
    await expect(bus.emit('x')).resolves.toBeUndefined();
    expect(seen).toEqual(['ok']);
    expect(errors).toEqual(['x/p1/sync', 'x/p2/async']);
  });
});
