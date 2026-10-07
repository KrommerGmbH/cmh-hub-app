// R1 앱 연결 — DataService ↔ 자료 프로세스(data-worker)를 Node fork 어댑터로 끝까지 시험한다(Electron utilityProcess 는 같은 RPC · 같은 진입 파일).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Criteria, openSqliteDatabase } from '@cmh-hub-app/data';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NodeProcessLauncher } from '../plugin/process-launcher.js';
import { RpcError } from '../plugin/plugin-rpc.js';
import { DATA_METHOD, DATA_RPC_ERROR } from './data-protocol.js';
import { DataService, SECRET_READERS, type DataServiceOptions } from './data-service.js';
import { buildDataWorker, type BuiltWorker } from './__tests__/build-worker.js';

const PROVIDER_ID = '0123456789abcdef0123456789abcdef';
const SECRET_BLOB = 'ENC:v10:secret-blob';

let built: BuiltWorker;
let root: string;
const services: DataService[] = [];
const launcher = new NodeProcessLauncher();

beforeAll(async () => {
  built = buildDataWorker();
  root = await mkdtemp(join(tmpdir(), 'cmh-data-service-'));
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
      .filter((line) => line.includes(built.outDir));
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

  it('stop — shutdown → 자식이 끝난다 · 남은 자식 0 · 그 뒤 요청은 unavailable', async () => {
    const { service } = await newService();
    await service.start();
    const pid = service.pid;
    expect(isAlive(pid)).toBe(true);
    await service.stop();
    expect(service.state).toBe('stopped');
    expect(isAlive(pid)).toBe(false);
    expect((await rpcErrorOf(service.health())).code).toBe(DATA_RPC_ERROR.unavailable);
    await service.stop(); // 두 번 불러도 된다
  });

  it('깨진 DB 파일 → 열기 실패를 RPC 오류로 알림 · failed · 원본 그대로 · 자식 끝남', async () => {
    const { service, filename } = await newService();
    const garbage = Buffer.from('this is not a sqlite database — '.repeat(200), 'utf8');
    await writeFile(filename, garbage);
    const error = await rpcErrorOf(service.start());
    expect(error.code).toBe(DATA_RPC_ERROR.openFailed);
    expect(service.state).toBe('failed');
    expect(service.pid).toBeUndefined();
    expect(readFileSync(filename).equals(garbage)).toBe(true);
    expect((await rpcErrorOf(service.health())).code).toBe(DATA_RPC_ERROR.unavailable);
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
});
