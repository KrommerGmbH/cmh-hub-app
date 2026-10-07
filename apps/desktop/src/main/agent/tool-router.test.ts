import { describe, expect, it } from 'vitest';

import { fakeMcp, spyTool } from './__tests__/agent-test-support.js';
import { ToolRouter, WEB_SEARCH_NO_PROVIDER, createEchoTool, createWebSearchTool, toModelName } from './tool-router.js';
import type { BrowserToolBridge, WebSearchProvider } from './tool-router.js';

describe('ToolRouter', () => {
  it('세 출처를 Guard 이름으로 모으고 모델 이름은 [A-Za-z0-9_-] 로 바꾼다', async () => {
    const mcp = fakeMcp('cmh-shop-api.mcp', ['dal_update']);
    const browser: BrowserToolBridge = {
      listTools: async () => [{ name: 'navigate', description: 'go', parameters: { type: 'object' } }],
      callTool: async () => ({ ok: true, text: 'went', truncated: false }),
    };
    const router = new ToolRouter({ appTools: [createEchoTool()], browser, mcp: { manager: mcp.manager } });
    expect(await router.refresh()).toEqual({ errors: [] });
    expect(router.list().map((t) => [t.name, t.modelName, t.source, t.known])).toEqual([
      ['app:echo', 'app__echo', 'app', true],
      // 브라우저 다리가 known 을 안 주면 false(검수 4 권고 9)
      ['browser:navigate', 'browser__navigate', 'browser', false],
      ['mcp:cmh-shop-api.mcp:dal_update', 'mcp__cmh-shop-api_mcp__dal_update', 'mcp', false],
    ]);
    expect(router.lookup('mcp__cmh-shop-api_mcp__dal_update')?.name).toBe('mcp:cmh-shop-api.mcp:dal_update');
    expect(router.lookup('app:echo')?.modelName).toBe('app__echo');
    expect(await router.call('mcp:cmh-shop-api.mcp:dal_update', { entity: 'product' })).toEqual({ ok: true, text: 'ok', truncated: false });
    expect(mcp.calls).toEqual([{ code: 'cmh-shop-api.mcp', name: 'dal_update', args: { entity: 'product' } }]);
    expect(await router.call('browser:navigate', {})).toEqual({ ok: true, text: 'went', truncated: false });
  });

  it('64자를 넘는 이름은 해시 꼬리를 붙여 줄이고 겹치면 _2 를 붙인다', () => {
    const long = `mcp:${'s'.repeat(40)}:${'t'.repeat(40)}`;
    const name = toModelName(long);
    expect(name.length).toBe(64);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    const router = new ToolRouter({ appTools: [spyTool('a.b'), spyTool('a_b')] });
    expect(router.list().map((t) => t.modelName)).toEqual(['app__a_b', 'app__a_b_2']);
  });

  it('도구 정의는 도구 수 · 설명 길이 · 글자 합 상한과 filter 로 자른다', () => {
    const tools = ['a', 'b', 'c'].map((n) => ({ ...spyTool(n), description: 'x'.repeat(50) }));
    const router = new ToolRouter({ appTools: tools });
    const byCount = router.definitions({ maxTools: 2, maxDescriptionChars: 10, maxTotalChars: 10_000 });
    expect(byCount.tools.map((t) => t.function.name)).toEqual(['app__a', 'app__b']);
    expect(byCount.tools[0]?.function.description).toBe(`${'x'.repeat(10)}…`);
    expect(byCount.dropped).toEqual(['app:c']);
    const byFilter = router.definitions({ maxTools: 10, maxDescriptionChars: 10, maxTotalChars: 10_000, filter: (t) => t.name !== 'app:b' });
    expect(byFilter.tools.map((t) => t.function.name)).toEqual(['app__a', 'app__c']);
    const bySize = router.definitions({ maxTools: 10, maxDescriptionChars: 10, maxTotalChars: 1 });
    expect(bySize.tools).toEqual([]);
  });

  it('웹 검색은 공급자가 없으면 목록에서 빠지고 불리면 «검색 공급자 없음»', async () => {
    const router = new ToolRouter({ appTools: [createWebSearchTool(null)] });
    expect(router.definitions().tools).toEqual([]);
    expect(await router.call('app:web_search', { query: 'q' })).toEqual({ ok: false, error: WEB_SEARCH_NO_PROVIDER, truncated: false });
  });

  it('웹 검색 공급자가 있으면 목록에 들고 결과를 JSON 글로 돌려준다', async () => {
    const provider: WebSearchProvider = {
      id: 'fake',
      search: async (query, opts) => [{ title: query, url: 'https://example.com', snippet: String(opts.limit) }],
    };
    const router = new ToolRouter({ appTools: [createWebSearchTool(provider)] });
    expect(router.definitions().tools.map((t) => t.function.name)).toEqual(['app__web_search']);
    const r = await router.call('app:web_search', { query: 'q', limit: 3 });
    expect(r).toEqual({ ok: true, text: '[{"title":"q","url":"https://example.com","snippet":"3"}]', truncated: false });
  });

  it('call 은 던지지 않는다 — 모르는 이름 · 도구가 던진 예외 모두 ok false', async () => {
    const thrower = { ...spyTool('t'), run: () => { throw new Error('kaboom'); } };
    const router = new ToolRouter({ appTools: [thrower] });
    expect(await router.call('app:none', {})).toEqual({ ok: false, error: 'unknown tool "app:none"', truncated: false });
    expect(await router.call('app:t', {})).toEqual({ ok: false, error: 'app:t: kaboom', truncated: false });
  });

  it('출처 실패는 errors 로 돌려주고 나머지 출처는 남긴다', async () => {
    const browser: BrowserToolBridge = {
      listTools: async () => {
        throw new Error('bridge down');
      },
      callTool: async () => ({ ok: false, error: 'x', truncated: false }),
    };
    const router = new ToolRouter({ appTools: [createEchoTool()], browser });
    expect((await router.refresh()).errors).toEqual(['browser: tools list failed: bridge down']);
    expect(router.list().map((t) => t.name)).toEqual(['app:echo']);
  });

  it('앱 도구 이름이 마디 규칙을 어기거나 겹치면 생성 때 예외', () => {
    expect(() => new ToolRouter({ appTools: [spyTool('a:b')] })).toThrow(/must match/);
    expect(() => new ToolRouter({ appTools: [spyTool('a'), spyTool('a')] })).toThrow(/duplicate/);
  });

  it('브라우저 도구는 다리가 명시하지 않으면 known false · needsApproval true(검수 4 권고 9)', async () => {
    const browser: BrowserToolBridge = {
      listTools: async () => [
        { name: 'click', description: 'c', parameters: {} },
        { name: 'read', description: 'r', parameters: {}, known: true, needsApproval: false },
      ],
      callTool: async () => ({ ok: true, text: '', truncated: false }),
    };
    const router = new ToolRouter({ browser });
    await router.refresh();
    expect(router.list().map((t) => [t.name, t.known, t.needsApproval])).toEqual([
      ['browser:click', false, true],
      ['browser:read', true, false],
    ]);
  });

  it('definitions 는 보여 준 도구만 담은 이름 표(모델 이름 · Guard 이름)를 함께 돌려준다', () => {
    const router = new ToolRouter({ appTools: [spyTool('a'), spyTool('b'), createWebSearchTool(null)] });
    const set = router.definitions({ maxTools: 1, maxDescriptionChars: 10, maxTotalChars: 10_000 });
    expect([...set.byName.keys()]).toEqual(['app__a', 'app:a']);
    expect(set.byName.get('app__a')?.name).toBe('app:a');
    expect(set.byName.has('app__b')).toBe(false); // 상한으로 빠짐
    expect(set.byName.has('app__web_search')).toBe(false); // 공급자 없음
  });

  it('모델 이름 겹침은 등록 차례와 상관없이 Guard 이름 차례로 푼다', () => {
    const one = new ToolRouter({ appTools: [spyTool('a.b'), spyTool('a_b')] });
    const two = new ToolRouter({ appTools: [spyTool('a_b'), spyTool('a.b')] });
    expect(one.lookup('app__a_b')?.name).toBe('app:a.b');
    expect(two.lookup('app__a_b')?.name).toBe('app:a.b');
    expect(two.list().map((t) => t.name)).toEqual(['app:a_b', 'app:a.b']); // 목록 차례는 등록 차례 그대로
  });
});
