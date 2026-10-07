// 시험용 고집쟁이 플러그인 — activate 에는 답하지만 deactivate 에는 답하지 않고 SIGTERM 도 무시한다.
// plugin-process.test.ts 의 «SIGTERM 을 무시해도 stop() 은 stopTimeout 뒤 SIGKILL 로 끝난다» 가 쓴다.
// 매니페스트 이름이 `-silent` 로 끝나면 activate 에도 답하지 않는다(start 실패 길 · 앱이 env 를 고정하므로 이름으로 고른다).
const port = process.parentPort ?? null;
const send = (m) => (port ? port.postMessage(m) : process.send?.(m));
const on = (f) => (port ? port.on('message', (e) => f(e.data)) : process.on('message', f));
process.on('SIGTERM', () => {
  send({ jsonrpc: '2.0', method: 'log', params: { level: 'warn', message: 'SIGTERM ignored' } });
});
// IPC 가 끊겨도 살아 있게(고아가 되는지 시험이 본다)
setInterval(() => {}, 1_000);
on((m) => {
  if (!m || typeof m.method !== 'string' || m.id === undefined) return;
  if (m.method === 'activate') {
    if (String(m.params?.name ?? '').endsWith('-silent')) return;
    send({ jsonrpc: '2.0', id: m.id, result: null });
    return;
  }
  if (m.method === 'deactivate') return; // 답하지 않는다
  send({ jsonrpc: '2.0', id: m.id, result: { pid: process.pid } });
});
