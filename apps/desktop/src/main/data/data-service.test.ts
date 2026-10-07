// R1 앱 연결 — DataService ↔ 자료 프로세스(data-worker)를 Node fork 어댑터로 끝까지 시험한다(Electron utilityProcess 는 같은 RPC · 같은 진입 파일).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Criteria, openSqliteDatabase } from '@cmh-hub-app/data';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NodeProcessLauncher, type ProcessLauncher } from '../plugin/process-launcher.js';
import { RpcError } from '../plugin/plugin-rpc.js';
import { DATA_METHOD, DATA_RPC_ERROR, type DataOpenErrorData } from './data-protocol.js';
import { DataService, SECRET_READERS, type DataServiceOptions } from './data-service.js';
import { buildDataWorker, type BuiltWorker } from './__tests__/build-worker.js';

const PROVIDER_ID = '0123456789abcdef0123456789abcdef';
const SECRET_BLOB = 'ENC:v10:secret-blob';

let built: BuiltWorker;
let root: string;
/** RPC 를 흉내 내는 가짜 자식(FAKE_MODE: normal · hang(open 에 답 안 함) · ignore-term(shutdown 무답 · SIGTERM 무시)) */
let fakeWorkerPath: string;
const services: DataService[] = [];
const launcher = new NodeProcessLauncher();

const FAKE_WORKER = `
const mode = process.env.FAKE_MODE ?? 'normal';
const openDelay = Number(process.env.FAKE_OPEN_DELAY_MS ?? '0');
const reply = (id, result) => process.send({ jsonrpc: '2.0', id, result });
process.on('message', (m) => {
  if (!m || typeof m !== 'object' || typeof m.id !== 'number') return;
  if (m.method === 'open') {
    if (mode === 'hang') return;
    setTimeout(() => reply(m.id, { filename: m.params.filename, updated: [], destructive: [] }), openDelay);
  } else if (m.method === 'shutdown') {
    if (mode !== 'ignore-term') reply(m.id, null);
  } else if (m.method === 'health') {
    reply(m.id, { ok: true, pid: process.pid, filename: '', uptimeMs: 0, entities: 0 });
  }
});
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
setInterval(() => {}, 1 << 30);
`;

beforeAll(async () => {
  built = buildDataWorker();
  root = await mkdtemp(join(tmpdir(), 'cmh-data-service-'));
  fakeWorkerPath = join(root, 'fake-data-worker.mjs');
  await writeFile(fakeWorkerPath, FAKE_WORKER);
}, 120_000);

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
});

afterAll(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  // 남은 자식 0 — 이 시험이 낸 진입 파일 경로로 도는 프로세스를 찾는다
  if (process.platform !== 'win32') {
    const left = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(built.outDir) || line.includes(fakeWorkerPath));
    expect(left).toEqual([]);
  }
  built?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

let seq = 0;
async function newService(extra: Partial<DataServiceOptions> = {}): Promise<{ service: DataService; filename: string; logs: string[] }> {
  const dir = join(root, `case-${++seq}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const filename = join(dir, 'cmh-hub.sqlite');
  const logs: string[] = [];
  const service = new DataService({
    filename,
    launcher,
    workerPath: built.workerPath,
    killTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    onLog: (level, message) => logs.push(`${level}: ${message}`),
    ...extra,
  });
  services.push(service);
  return { service, filename, logs };
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rpcErrorOf(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

/** NodeProcessLauncher 를 감싸 보낸 메서드 · 받은 답 · kill 신호 · exit 를 차례대로 적는다 */
function recordingLauncher(events: string[]): ProcessLauncher {
  return {
    launch(modulePath, options) {
      const channel = launcher.launch(modulePath, options);
      const methodById = new Map<number, string>();
      return {
        get pid() {
          return channel.pid;
        },
        send(message) {
          const m = message as { id?: unknown; method?: unknown };
          if (typeof m.method === 'string') {
            events.push(`send:${m.method}`);
            if (typeof m.id === 'number') methodById.set(m.id, m.method);
          }
          channel.send(message);
        },
        onMessage(listener) {
          channel.onMessage((message) => {
            const m = message as { id?: unknown; method?: unknown };
            if (typeof m.id === 'number' && m.method === undefined) events.push(`reply:${methodById.get(m.id) ?? '?'}`);
            listener(message);
          });
        },
        onExit(listener) {
          channel.onExit((code) => {
            events.push('exit');
            listener(code);
          });
        },
        kill(signal) {
          events.push(`kill:${signal ?? 'SIGTERM'}`);
          channel.kill(signal);
        },
      };
    },
  };
}

const providerRow = { id: PROVIDER_ID, code: 'openai', name: 'OpenAI', kind: 'remote', apiKeyEnc: SECRET_BLOB };

describe('DataService — 별도 프로세스 자료층', () => {
  it('health · upsert · search(Criteria JSON) — 별도 프로세스 · 비밀칸은 결과에 없다', async () => {
    const { service, filename } = await newService();
    const open = await service.start();
    expect(service.state).toBe('running');
    expect(open.updated.length).toBeGreaterThan(0); // 새 파일 → 기본 마이그레이션이 돈다
    expect(existsSync(filename)).toBe(true);

    const health = await service.health();
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(service.pid);
    expect(health.pid).not.toBe(process.pid);
    expect(health.filename).toBe(filename);

    expect((await service.upsert('cmh_ai_provider', [providerRow])).ids).toEqual([PROVIDER_ID]);

    const criteria = new Criteria(1, 10).addFilter(Criteria.equals('code', 'openai'));
    const viaJson = await service.search('cmh_ai_provider', criteria.parse());
    expect(viaJson.total).toBe(1);
    expect(viaJson.elements[0]?.['name']).toBe('OpenAI');
    expect(viaJson.elements[0]).not.toHaveProperty('apiKeyEnc');
    expect(viaJson.elements[0]).not.toHaveProperty('api_key_enc');
    // Criteria 객체를 줘도 parse() 해서 보낸다
    const viaObject = await service.search('cmh_ai_provider', criteria);
    expect(viaObject.elements.map((e) => e['id'])).toEqual([PROVIDER_ID]);

    const one = await service.get('cmh_ai_provider', PROVIDER_ID);
    expect(one?.['code']).toBe('openai');
    expect(one).not.toHaveProperty('apiKeyEnc');
    expect((await service.searchIds('cmh_ai_provider', new Criteria())).ids).toEqual([PROVIDER_ID]);
    const agg = await service.aggregate('cmh_ai_provider', new Criteria().addAggregation(Criteria.count('n', 'id')));
    expect(agg['n']).toBeDefined();
  });

  it('비밀칸으로 거르면 오류 · scope 를 넣으면 거부(늘 api)', async () => {
    const { service } = await newService();
    await service.start();
    await service.upsert('cmh_ai_provider', [providerRow]);

    const bySecret = await rpcErrorOf(service.search('cmh_ai_provider', new Criteria().addFilter(Criteria.equals('apiKeyEnc', SECRET_BLOB))));
    expect(bySecret.code).toBe(DATA_RPC_ERROR.invalidParams);
    expect(bySecret.message).toContain('비밀칸');

    const scopeTop = await rpcErrorOf(service.call(DATA_METHOD.search, { entity: 'cmh_ai_provider', criteria: {}, scope: 'system' }));
    expect(scopeTop.code).toBe(DATA_RPC_ERROR.invalidParams);
    const scopeOpt = await rpcErrorOf(service.call(DATA_METHOD.get, { entity: 'cmh_ai_provider', id: PROVIDER_ID, options: { scope: 'system' } }));
    expect(scopeOpt.code).toBe(DATA_RPC_ERROR.invalidParams);

    const unknown = await rpcErrorOf(service.search('cmh_no_such_entity'));
    expect(unknown.code).toBe(DATA_RPC_ERROR.invalidParams);
  });

  it('secrets.read — main 허용 목록에 있는 호출자만 · 자식은 비밀칸이 아닌 칸을 거부', async () => {
    const { service, logs } = await newService({
      secretReaders: [...SECRET_READERS, { caller: 'test.non-secret', entity: 'cmh_ai_provider', field: 'name' }],
    });
    await service.start();
    await service.upsert('cmh_ai_provider', [providerRow]);

    expect(await service.readSecret('models.provider-key', 'cmh_ai_provider', PROVIDER_ID, 'apiKeyEnc')).toBe(SECRET_BLOB);
    expect(await service.readSecret('models.provider-key', 'cmh_ai_provider', 'ffffffffffffffffffffffffffffffff', 'api_key_enc')).toBeNull();

    const notListed = await rpcErrorOf(service.readSecret('agent.tool', 'cmh_ai_provider', PROVIDER_ID, 'apiKeyEnc'));
    expect(notListed.code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect(logs.some((l) => l.startsWith('warn: secret read denied'))).toBe(true);

    const notSecret = await rpcErrorOf(service.readSecret('test.non-secret', 'cmh_ai_provider', PROVIDER_ID, 'name'));
    expect(notSecret.code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect(notSecret.message).toContain('not a secret field');
  });

  it('call() 은 repo.* · health 만 — secrets.read · shutdown · open 은 자식에게 가지 않고 permissionDenied(검수 6 B1)', async () => {
    const events: string[] = [];
    const { service, filename, logs } = await newService({ launcher: recordingLauncher(events) });
    await service.start();
    await service.upsert('cmh_ai_provider', [providerRow]);

    const bypass = await rpcErrorOf(service.call(DATA_METHOD.readSecret, { entity: 'cmh_ai_provider', id: PROVIDER_ID, field: 'apiKeyEnc' }));
    expect(bypass.code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect(bypass.message).not.toContain(SECRET_BLOB);
    expect((await rpcErrorOf(service.call(DATA_METHOD.shutdown))).code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect((await rpcErrorOf(service.call(DATA_METHOD.open, { filename }))).code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect((await rpcErrorOf(service.call('no.such.method'))).code).toBe(DATA_RPC_ERROR.permissionDenied);
    expect(events.filter((e) => e === `send:${DATA_METHOD.readSecret}` || e === `send:${DATA_METHOD.shutdown}`)).toEqual([]);
    expect(events.filter((e) => e === `send:${DATA_METHOD.open}`)).toHaveLength(1); // start 때 한 번뿐
    expect(logs.filter((l) => l.startsWith('warn: call denied'))).toHaveLength(4);

    // shutdown 이 안 갔다 — DB 는 그대로 열려 있고 공개 메서드는 된다
    expect(service.state).toBe('running');
    expect((await service.health()).ok).toBe(true);
    expect((await service.call(DATA_METHOD.searchIds, { entity: 'cmh_ai_provider', criteria: {} })) as { ids: string[] }).toEqual(
      expect.objectContaining({ ids: [PROVIDER_ID] }),
    );
  });

  it('cmh_ai_approval 쓰기는 이 RPC 로 늘 거부(합의안 5) — 이름 꼴을 바꿔도', async () => {
    const { service } = await newService();
    await service.start();
    for (const entity of ['cmh_ai_approval', 'cmhAiApproval', 'CMH-AI-APPROVAL']) {
      const up = await rpcErrorOf(service.upsert(entity, [{ id: PROVIDER_ID, decision: 'approved' }]));
      expect(up.code).toBe(DATA_RPC_ERROR.permissionDenied);
      const del = await rpcErrorOf(service.delete(entity, [PROVIDER_ID]));
      expect(del.code).toBe(DATA_RPC_ERROR.permissionDenied);
    }
  });

  it('자식이 죽으면 한 번 다시 띄운다 · 두 번째 죽음이면 failed(시험 프로세스 = 앱은 산다)', async () => {
    const { service, logs } = await newService();
    await service.start();
    await service.upsert('cmh_ai_provider', [providerRow]);

    const first = service.pid;
    expect(isAlive(first)).toBe(true);
    process.kill(first!, 'SIGKILL');
    await waitFor(() => service.state === 'running' && service.pid !== undefined && service.pid !== first);
    expect(service.restartCount).toBe(1);
    // 새 자식은 같은 파일을 연다 — 앞서 쓴 줄이 남아 있다
    expect((await service.search('cmh_ai_provider')).elements.map((e) => e['id'])).toEqual([PROVIDER_ID]);

    const second = service.pid;
    process.kill(second!, 'SIGKILL');
    await waitFor(() => service.state === 'failed');
    expect(service.pid).toBeUndefined();
    expect(service.lastError).toContain('after 1 restart');
    const after = await rpcErrorOf(service.search('cmh_ai_provider'));
    expect(after.code).toBe(DATA_RPC_ERROR.unavailable);
    expect(isAlive(first)).toBe(false);
    expect(isAlive(second)).toBe(false);
    expect(logs.some((l) => l.startsWith('error: data process exited unexpectedly'))).toBe(true);
  });

  it('stop — shutdown RPC(답 받음 · WAL 합침) → SIGTERM → 자식이 끝난다 · 남은 자식 0 · 그 뒤 요청은 unavailable', async () => {
    const events: string[] = [];
    const { service, filename } = await newService({ launcher: recordingLauncher(events) });
    await service.start();
    await service.upsert('cmh_ai_provider', [providerRow]);
    expect(existsSync(`${filename}-wal`)).toBe(true); // 쓰기 뒤 WAL 이 있다
    const pid = service.pid;
    expect(isAlive(pid)).toBe(true);
    await service.stop();
    expect(service.state).toBe('stopped');
    expect(isAlive(pid)).toBe(false);
    // shutdown 을 보냈고 · 자식이 답했고(DB 닫음) · 그 뒤에야 SIGTERM — SIGKILL 은 없다
    const sent = events.indexOf(`send:${DATA_METHOD.shutdown}`);
    const replied = events.indexOf(`reply:${DATA_METHOD.shutdown}`);
    const term = events.indexOf('kill:SIGTERM');
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(replied).toBeGreaterThan(sent);
    expect(term).toBeGreaterThan(replied);
    expect(events).not.toContain('kill:SIGKILL');
    // 마지막 연결이 닫히며 WAL 이 본 파일로 합쳐지고 지워졌다 · 쓴 줄은 본 파일에 있다
    expect(existsSync(`${filename}-wal`)).toBe(false);
    const check = openSqliteDatabase(filename);
    try {
      expect(check.database.prepare('SELECT code FROM cmh_ai_provider').all()).toEqual([{ code: 'openai' }]);
    } finally {
      check.database.close();
    }
    expect((await rpcErrorOf(service.health())).code).toBe(DATA_RPC_ERROR.unavailable);
    await service.stop(); // 두 번 불러도 된다
  });

  it('깨진 DB 파일 → corruptDatabase(-32014) · failed · lastFailure · 원본 그대로 · 자식 끝남(검수 6 S4)', async () => {
    const { service, filename } = await newService();
    const garbage = Buffer.from('this is not a sqlite database — '.repeat(200), 'utf8');
    await writeFile(filename, garbage);
    const error = await rpcErrorOf(service.start());
    expect(error.code).toBe(DATA_RPC_ERROR.corruptDatabase);
    expect(error.data).toEqual({ name: 'CorruptDatabaseError', reason: 'corruptDatabase', backupPath: null, sqliteCode: 'SQLITE_NOTADB' });
    expect(service.state).toBe('failed');
    expect(service.lastFailure?.code).toBe(DATA_RPC_ERROR.corruptDatabase);
    expect(service.pid).toBeUndefined();
    expect(readFileSync(filename).equals(garbage)).toBe(true);
    expect((await rpcErrorOf(service.health())).code).toBe(DATA_RPC_ERROR.unavailable);
  });

  it('깨진 DB 파일 + 앞선 사본 → data.backupPath 에만 전체 경로 · 메시지 · 로그는 파일 이름만(검수 6 S4 · N6)', async () => {
    const { service, filename, logs } = await newService();
    const garbage = Buffer.from('not sqlite either — '.repeat(300), 'utf8');
    await writeFile(filename, garbage);
    await writeFile(`${filename}.pre-migration.bak`, 'OLD-BACKUP');
    const error = await rpcErrorOf(service.start());
    expect(error.code).toBe(DATA_RPC_ERROR.corruptDatabase);
    expect((error.data as DataOpenErrorData).backupPath).toBe(`${filename}.pre-migration.bak`);
    expect((service.lastFailure?.data as DataOpenErrorData).backupPath).toBe(`${filename}.pre-migration.bak`);
    expect(error.message).toContain('cmh-hub.sqlite.pre-migration.bak');
    expect(error.message).not.toContain(dirname(filename));
    expect(logs.some((l) => l.startsWith('error: start failed'))).toBe(true);
    expect(logs.filter((l) => l.includes(dirname(filename)))).toEqual([]);
    // 사용자 파일은 지우지도 덮지도 않았다
    expect(readFileSync(filename).equals(garbage)).toBe(true);
    expect(readFileSync(`${filename}.pre-migration.bak`, 'utf8')).toBe('OLD-BACKUP');
  });

  it('마이그레이션 실패 → 사본으로 되돌림 · 원본 자료 남음 · 다시 띄우지 않음', async () => {
    const { service, filename } = await newService();
    // 기본 마이그레이션이 만들 테이블을 다른 꼴로 미리 만들어 둔다 → CREATE TABLE 실패
    const handle = openSqliteDatabase(filename);
    handle.database.exec('CREATE TABLE cmh_ai_provider (x INTEGER); INSERT INTO cmh_ai_provider (x) VALUES (42);');
    handle.database.close();

    const error = await rpcErrorOf(service.start());
    expect(error.code).toBe(DATA_RPC_ERROR.openFailed);
    expect(error.message).toContain('되돌렸다');
    expect(error.message).not.toContain(dirname(filename));
    expect(error.data).toEqual({ name: 'MigrationError', reason: 'migrationFailed', backupPath: `${filename}.pre-migration.bak` });
    expect(service.state).toBe('failed');
    expect(service.restartCount).toBe(0);
    expect(existsSync(`${filename}.pre-migration.bak`)).toBe(true);

    const check = openSqliteDatabase(filename);
    try {
      expect(check.database.prepare('SELECT x FROM cmh_ai_provider').all()).toEqual([{ x: 42 }]);
    } finally {
      check.database.close();
    }
  });

  it('open 시간초과(startTimeoutMs 를 줄 때) → timeout · failed · 자식을 거둔다(검수 6 N8)', async () => {
    const { service } = await newService({ workerPath: fakeWorkerPath, env: { FAKE_MODE: 'hang' }, startTimeoutMs: 300, killTimeoutMs: 300 });
    const starting = service.start();
    const pid = service.pid;
    expect(isAlive(pid)).toBe(true);
    const error = await rpcErrorOf(starting);
    expect(error.code).toBe(DATA_RPC_ERROR.timeout);
    expect(service.state).toBe('failed');
    expect(service.lastFailure?.code).toBe(DATA_RPC_ERROR.timeout);
    await waitFor(() => !isAlive(pid));
  });

  it('open 은 기본 시간초과가 없다 — 요청 시간(requestTimeoutMs)보다 오래 걸려도 끝까지 기다린다 · 그 사이 요청은 unavailable(검수 6 S3)', async () => {
    const { service } = await newService({ workerPath: fakeWorkerPath, env: { FAKE_MODE: 'normal', FAKE_OPEN_DELAY_MS: '900' }, requestTimeoutMs: 200 });
    const starting = service.start();
    const t0 = Date.now();
    const during = await rpcErrorOf(service.health());
    expect(during.code).toBe(DATA_RPC_ERROR.unavailable);
    expect(during.message).toContain('still starting');
    expect(Date.now() - t0).toBeLessThan(800);
    const open = await starting;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(open.updated).toEqual([]);
    expect(service.state).toBe('running');
    expect((await service.health()).pid).toBe(service.pid);
  });

  it('자식이 SIGTERM 을 무시하면 SIGKILL 로 거둔다(검수 6 N8)', async () => {
    const events: string[] = [];
    const { service, logs } = await newService({
      workerPath: fakeWorkerPath,
      env: { FAKE_MODE: 'ignore-term' },
      launcher: recordingLauncher(events),
      stopTimeoutMs: 200,
      killTimeoutMs: 300,
    });
    await service.start();
    const pid = service.pid;
    const t0 = Date.now();
    await service.stop();
    const elapsed = Date.now() - t0;
    expect(service.state).toBe('stopped');
    expect(isAlive(pid)).toBe(false);
    expect(events.filter((e) => e.startsWith('kill:'))).toEqual(['kill:SIGTERM', 'kill:SIGKILL']);
    expect(elapsed).toBeGreaterThanOrEqual(200 + 300 - 20); // shutdown 무답 + SIGTERM 무시를 다 기다렸다
    expect(logs.filter((l) => l.startsWith('error:'))).toEqual([]);
  });

  it('다시 띄우는 중 stop → 새 자식도 거두고 stopped 로 남는다 · failed · error 로그 없음(검수 6 N8)', async () => {
    const { service, logs } = await newService();
    await service.start();
    const first = service.pid;
    process.kill(first!, 'SIGKILL');
    await waitFor(() => service.state === 'restarting');
    const second = service.pid;
    expect(second).not.toBe(first);
    await service.stop();
    expect(service.state).toBe('stopped');
    expect(isAlive(second)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(service.state).toBe('stopped'); // 늦게 끝난 재시작이 running · failed 로 바꾸지 않는다
    expect(service.lastError).toBeNull();
    expect(logs.filter((l) => l.startsWith('error:'))).toEqual([]);
  });

  it('띄우는 중 stop → start 는 거부되지만 failed 아님 · error 로그 없음(검수 6 N4)', async () => {
    const { service, logs } = await newService({ workerPath: fakeWorkerPath, env: { FAKE_MODE: 'normal', FAKE_OPEN_DELAY_MS: '600' } });
    const starting = service.start();
    const pid = service.pid;
    await new Promise((r) => setTimeout(r, 50));
    await service.stop();
    await rpcErrorOf(starting);
    expect(service.state).toBe('stopped');
    expect(service.lastFailure).toBeNull();
    expect(isAlive(pid)).toBe(false);
    expect(logs.filter((l) => l.startsWith('error:'))).toEqual([]);
  });
});
