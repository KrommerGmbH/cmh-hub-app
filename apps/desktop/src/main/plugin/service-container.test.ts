import { describe, expect, it } from 'vitest';
import { ServiceContainer } from './service-container.js';

interface Greeter { greet(name: string): string }

describe('ServiceContainer — decorate 체인(Shopware services.php decorate · .inner)', () => {
  it('등록 차례대로 겹친다 — 마지막 decorator 가 바깥', () => {
    const container = new ServiceContainer();
    container.register<Greeter>('greeter', () => ({ greet: (name) => `hello ${name}` }));
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (name) => `[a ${inner.greet(name)}]` }), 'plugin-a');
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (name) => `[b ${inner.greet(name)}]` }), 'plugin-b');
    expect(container.get<Greeter>('greeter').greet('kim')).toBe('[b [a hello kim]]');
  });
  it('register 전에 decorate 해도 된다 · 만든 것은 한 번만', () => {
    const container = new ServiceContainer();
    let built = 0;
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (n) => inner.greet(n).toUpperCase() }));
    container.register<Greeter>('greeter', () => {
      built++;
      return { greet: (n) => `hi ${n}` };
    });
    expect(container.get<Greeter>('greeter').greet('lee')).toBe('HI LEE');
    container.get('greeter');
    expect(built).toBe(1);
  });
  it('안쪽을 안 부르는 decorator 는 체인을 끊는다(Shopware 와 같은 위험 · 막지 못함)', () => {
    const container = new ServiceContainer();
    container.register<Greeter>('greeter', () => ({ greet: () => 'base' }));
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (n) => `a(${inner.greet(n)})` }), 'plugin-a');
    container.decorate<Greeter>('greeter', () => ({ greet: () => 'b only' }), 'plugin-b');
    expect(container.get<Greeter>('greeter').greet('x')).toBe('b only');
  });
  it('removeOwner 는 그 플러그인 decorator 만 걷고 다시 만든다', () => {
    const container = new ServiceContainer();
    container.register<Greeter>('greeter', () => ({ greet: () => 'base' }));
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (n) => `a(${inner.greet(n)})` }), 'plugin-a');
    container.decorate<Greeter>('greeter', (inner) => ({ greet: (n) => `b(${inner.greet(n)})` }), 'plugin-b');
    expect(container.get<Greeter>('greeter').greet('x')).toBe('b(a(base))');
    expect(container.removeOwner('plugin-a')).toBe(1);
    expect(container.get<Greeter>('greeter').greet('x')).toBe('b(base)');
  });
  it('없는 서비스 · 두 번 등록 · 자기 의존은 예외', () => {
    const container = new ServiceContainer();
    expect(() => container.get('nope')).toThrow('service "nope" is not registered');
    container.register('a', () => 1);
    expect(() => container.register('a', () => 2)).toThrow('already registered');
    container.register('loop', (c) => c.get('loop'));
    expect(() => container.get('loop')).toThrow('depends on itself');
  });
});
