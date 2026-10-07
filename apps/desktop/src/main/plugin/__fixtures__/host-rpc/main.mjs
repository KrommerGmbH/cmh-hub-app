// 시험용 플러그인(R2-b) — host:* RPC 와 tool:* 를 실제 별도 프로세스에서 확인한다(plugin-host-rpc.test.ts).
// probe: host:log(선언 없이 허용) · 표에 없는 host:nope · 선언 없는 엔티티 host:data.search · 선언한 설정 · 선언 안 한 설정을 차례로 부른다.
const port = process.parentPort ?? null;
const send = (m) => (port ? port.postMessage(m) : process.send?.(m));
const on = (f) => (port ? port.on('message', (e) => f(e.data)) : process.on('message', f));

let nextId = 1;
const pending = new Map();
function callHost(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
async function attempt(method, params) {
  try {
    return { ok: true, result: await callHost(method, params) };
  } catch (error) {
    return { ok: false, code: error.code ?? null, message: error.message };
  }
}

const methods = {
  activate: () => null,
  deactivate: () => null,
  probe: async () => ({
    log: await attempt('host:log', { level: 'info', message: 'hello from child' }),
    unknown: await attempt('host:nope', {}),
    undeclaredEntity: await attempt('host:data.search', { entity: 'cmh_ai_task' }),
    declaredEntity: await attempt('host:data.search', { entity: 'cmh_ai_prompt', criteria: { limit: 1 } }),
    setting: await attempt('host:settings.get', { key: 'greeting' }),
    undeclaredSetting: await attempt('host:settings.get', { key: 'secret' }),
  }),
  'tool:echo': (args) => ({ text: String(args?.text ?? '') }),
  'tool:save': () => ({ ok: false, error: 'save refused by plugin' }),
};

on(async (m) => {
  if (!m || m.jsonrpc !== '2.0') return;
  if (typeof m.method !== 'string') {
    const waiter = pending.get(m.id);
    if (!waiter) return;
    pending.delete(m.id);
    if (m.error) waiter.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    else waiter.resolve(m.result);
    return;
  }
  if (m.id === undefined) return;
  const handler = Object.hasOwn(methods, m.method) ? methods[m.method] : null;
  if (!handler) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method "${m.method}" not found` } });
  try {
    send({ jsonrpc: '2.0', id: m.id, result: (await handler(m.params)) ?? null });
  } catch (error) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: error.message } });
  }
});
