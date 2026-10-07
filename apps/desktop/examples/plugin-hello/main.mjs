// plugin-hello — R2-a 본보기 플러그인. 앱이 별도 프로세스로 띄운다(Electron utilityProcess · 시험은 Node child_process.fork).
// 앱과는 JSON-RPC 2.0 글만 주고받는다. 이 파일은 의존이 없다(@cmh-hub-app/plugin-api 는 다음 차례).
// 권한: plugin.json permissions 에 entity:cmh_ai_prompt:read 만 있다 → cmh_ai_task 읽기 · cmh_ai_approval 쓰기는 앱이 거부한다.

const port = process.parentPort ?? null; // Electron utility process 에만 있다

function send(message) {
  if (port) port.postMessage(message);
  else if (process.send) process.send(message);
}

function onMessage(listener) {
  if (port) port.on('message', (event) => listener(event.data));
  else process.on('message', listener);
}

let nextId = 1;
const pending = new Map();

function callHost(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function log(level, message) {
  send({ jsonrpc: '2.0', method: 'log', params: { level, message } });
}

/** 앱이 거부해도 플러그인은 죽지 않는다 — 결과로 돌려준다 */
async function attempt(method, params) {
  try {
    return { ok: true, result: await callHost(method, params) };
  } catch (error) {
    return { ok: false, error: { code: error.code ?? null, message: error.message } };
  }
}

let lastEvent = null;

const methods = {
  activate: ({ name, version }) => {
    log('info', `${name} ${version} activated (pid ${process.pid})`);
    return { ok: true };
  },
  deactivate: () => null,
  ping: async (params) => {
    const delayMs = Math.min(Math.max(Number(params?.delayMs) || 0, 0), 60_000);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { pong: true, pid: process.pid };
  },
  // 허용된 읽기(entity:cmh_ai_prompt:read)
  'hello.readPrompts': () => attempt('repository.search', { entity: 'cmh_ai_prompt', criteria: { limit: 5 } }),
  // 선언 안 한 엔티티 — 앱이 거부해야 한다
  'hello.readTasks': () => attempt('repository.search', { entity: 'cmh_ai_task', criteria: {} }),
  // 스스로 승인하기 — 매니페스트에 적을 수도 없고 앱이 늘 거부한다(합의안 5)
  'hello.approveSelf': () => attempt('repository.upsert', { entity: 'cmh_ai_approval', rows: [{ id: 'x', status: 'approved' }] }),
  'hello.lastEvent': () => lastEvent,
};

const notifications = {
  event: (params) => {
    lastEvent = params;
  },
};

onMessage(async (message) => {
  if (!message || message.jsonrpc !== '2.0') return;
  if (typeof message.method !== 'string') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.result);
    return;
  }
  if (message.id === undefined) {
    notifications[message.method]?.(message.params);
    return;
  }
  const handler = Object.hasOwn(methods, message.method) ? methods[message.method] : null;
  if (!handler) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method "${message.method}" not found` } });
    return;
  }
  try {
    const result = await handler(message.params);
    send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
  }
});
