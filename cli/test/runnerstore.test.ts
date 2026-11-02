// The runner store: the same behaviour in memory and over the hub admin's SQL + reducer API (npm test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminStore, memoryStore, type RunnerStore } from '../src/runnerstore.ts';

const caps = { followUp: true, stop: true, events: true, repo: true, connect: false };
const newRunner = (id: string, owner = 'priya') => ({ id, owner, name: `${owner}'s hub`, kind: 'Agents Hub · OpenAI', url: `https://${id}.example`, sealedToken: 'SEALED', capabilities: caps, isDefault: false });

async function behaves(store: RunnerStore) {
  await store.addRunner(newRunner('a1b2c3d4e5f6a7b8'));
  const [r] = await store.listRunners('priya');
  assert.equal(r.id, 'a1b2c3d4e5f6a7b8');
  assert.deepEqual(r.capabilities, caps);
  assert.ok(!('sealedToken' in r), 'a Runner never carries its token');
  assert.equal(await store.sealedTokenOf('a1b2c3d4e5f6a7b8'), 'SEALED');
  assert.equal((await store.runnerAt('priya', 'https://a1b2c3d4e5f6a7b8.example'))?.id, 'a1b2c3d4e5f6a7b8');
  await store.addWorker({ taskId: 't-1', runnerId: 'a1b2c3d4e5f6a7b8', runnerUrl: 'https://a1b2c3d4e5f6a7b8.example', launcher: 'priya', space: 'acme', project: 'site', conversation: 'Chat/general/chat.json', title: 'Fix' });
  await store.updateWorker('t-1', { status: 'done', result: { summary: 'ok', links: ['https://x/pull/1'], error: null } });
  const w = await store.getWorker('t-1');
  assert.equal(w?.status, 'done');
  assert.deepEqual(w?.result, { summary: 'ok', links: ['https://x/pull/1'], error: null });
  assert.equal((await store.listWorkers({ launcher: 'priya' })).length, 1);
}

test('memoryStore keeps runners and workers', async () => {
  await behaves(memoryStore());
});

test('memoryStore: one default per owner, the first one', async () => {
  const s = memoryStore();
  await s.addRunner(newRunner('a000000000000001'));
  await s.addRunner(newRunner('a000000000000002'));
  assert.deepEqual((await s.listRunners('priya')).map(r => r.isDefault), [true, false]);
  await s.updateRunner('a000000000000002', { isDefault: true });
  assert.deepEqual((await s.listRunners('priya')).map(r => r.isDefault), [false, true]);
  await s.deleteRunner('a000000000000002');
  assert.deepEqual((await s.listRunners('priya')).map(r => r.isDefault), [true]);
});

// A stand-in for SpacetimeDB's HTTP API inside the container: /sql answers from a tiny table map, /call records.
const tables: Record<string, Record<string, unknown>[]> = { runner: [], worker: [] };
const sqlSeen: string[] = [];
const calls: { reducer: string; args: unknown[] }[] = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.headers.authorization !== 'Bearer ADMIN') return res.writeHead(401).end('no');
  if (req.url === '/v1/database/spacehub/sql') {
    sqlSeen.push(body);
    const table = /FROM (\w+)/.exec(body)![1];
    const where = [...body.matchAll(/(\w+) = '((?:[^']|'')*)'/g)].map(m => [m[1], m[2].replace(/''/g, "'")]);
    const rows = tables[table].filter(row => where.every(([k, v]) => String(row[k]) === v));
    const names = rows[0] ? Object.keys(rows[0]) : ['id'];
    return res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows: rows.map(r => names.map(n => r[n])) }]));
  }
  const m = /^\/v1\/database\/spacehub\/call\/(\w+)$/.exec(req.url!);
  if (m) {
    const args = JSON.parse(body) as unknown[];
    calls.push({ reducer: m[1], args });
    const ts = { __timestamp_micros_since_unix_epoch__: 1_793_700_000_000_000 };
    if (m[1] === 'runner_add') {
      const [id, owner, name, kind, url, sealed_token, capabilities, is_default] = args;
      tables.runner.push({ id, owner, name, kind, url, sealed_token, capabilities, is_default: is_default || !tables.runner.some(r => r.owner === owner), connected_at: ts, checked_at: ts });
    }
    if (m[1] === 'worker_add') {
      const [task_id, runner_id, runner_url, launcher, space, project, conversation, title] = args;
      tables.worker.push({ task_id, runner_id, runner_url, launcher, space, project, conversation, title, status: 'running', result: '', created_at: ts, updated_at: ts });
    }
    if (m[1] === 'worker_update') {
      const [task_id, status, result] = args;
      const row = tables.worker.find(w => w.task_id === task_id)!;
      if (status) row.status = status;
      if (result) row.result = result;
    }
    return res.end('');
  }
  res.writeHead(404).end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const cfg = { adminToken: 'ADMIN', http: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db: 'spacehub' };

test('adminStore keeps runners and workers through SQL and the admin reducers', async () => {
  await behaves(adminStore(cfg));
  assert.deepEqual(calls[0], { reducer: 'runner_add', args: ['a1b2c3d4e5f6a7b8', 'priya', "priya's hub", 'Agents Hub · OpenAI', 'https://a1b2c3d4e5f6a7b8.example', 'SEALED', JSON.stringify(caps), false] });
  assert.ok(sqlSeen.every(q => !q.includes('SEALED') || /SELECT sealed_token/.test(q)), 'the token is only selected where asked for');
});

test('adminStore refuses unsafe values before any SQL is sent', async () => {
  const s = adminStore(cfg);
  const before = sqlSeen.length;
  await assert.rejects(s.listRunners("x' OR '1'='1"), /invalid/);
  await assert.rejects(s.getWorker("t'1"), /invalid/);
  await assert.rejects(s.getRunner('not-hex'), /invalid/);
  assert.equal(sqlSeen.length, before);
});
