// A connected sub-hub's storage, read live through the hub: the relay, and
// the whole path from an operator through the hub to a running machine
// (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { backupHub, hubBackupConfig } from '../src/hubbackup.ts';
import { InstanceConnections } from '../src/instanceconnections.ts';
import { handleInstanceRecovery } from '../src/instancerecovery.ts';
import { runInstanceSubhub } from '../src/instanceruntime.ts';
import { RelayError, SubhubRelay } from '../src/subhubrelay.ts';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const SNAP = 'c'.repeat(32);
const OPERATOR = 'operator-token-for-the-test';

test('a question reaches the machine whether it asks first or polls first, and only its answer counts', async () => {
  const relay = new SubhubRelay();
  const asked = relay.ask(A, 'storage', undefined, 1000);
  const [question] = await relay.poll(A, 1000);
  assert.equal(question.op, 'storage');
  assert.throws(() => relay.answer(B, question.id, { result: 'not yours' }), (e: RelayError) => e.status === 404);
  relay.answer(A, question.id, { result: { snapshots: [] } });
  assert.deepEqual(await asked, { snapshots: [] });
  const polling = relay.poll(A, 1000);
  const second = relay.ask(A, 'snapshot', SNAP, 1000);
  const [q2] = await polling;
  assert.equal(q2.snapshot, SNAP);
  relay.answer(A, q2.id, { error: 'no such backup' });
  await assert.rejects(second, (e: RelayError) => e.status === 502 && /no such backup/.test(e.message));
});

test('no answer in time is a 504; bad ids and too many waiting questions are refused', async () => {
  const relay = new SubhubRelay();
  await assert.rejects(relay.ask(A, 'storage', undefined, 20), (e: RelayError) => e.status === 504);
  assert.deepEqual(await relay.poll(A, 10), [], 'a timed-out question is not handed over later');
  assert.throws(() => relay.ask(A, 'snapshot', '../x', 20), (e: RelayError) => e.status === 400);
  const pending = Array.from({ length: 32 }, () => relay.ask(B, 'storage', undefined, 50).catch(() => undefined));
  assert.throws(() => relay.ask(B, 'storage', undefined, 50), (e: RelayError) => e.status === 429);
  await Promise.all(pending);
});

test('an operator reads a running sub-hub\'s storage, one backup\'s files, and verifies it there', async t => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subhub-relay-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'data');
  fs.mkdirSync(path.join(root, 'data/replicas/1/clog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/replicas/1/clog/0.stdb.log'), 'commit log');
  const cfg = hubBackupConfig({ SPACEHUB_DATA_ROOT: root }, 'hub.example')!;
  await backupHub(cfg, 1_000);
  const connections = new InstanceConnections(path.join(tmp, 'connections'));
  connections.initialize();
  const relay = new SubhubRelay();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({
      vault: cfg.vault, connections, relay, source: 'hub.example', storage: cfg.vault.storageDir, containers: [], restoreRoot: '',
      authorize: async r => r.headers.authorization === `Bearer ${OPERATOR}`,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = async (route: string, method = 'GET', token = OPERATOR) => {
    const res = await fetch(`${hub}/-/api/instance-recovery${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
    return { status: res.status, body: await res.json() };
  };
  const stop = new AbortController();
  const statuses: string[] = [];
  const running = runInstanceSubhub({ storage: path.join(tmp, 'subhub'), hub, operatorToken: OPERATOR, name: 'office backup', intervalSeconds: 1, signal: stop.signal, onStatus: s => statuses.push(s.state) }, { heartbeatIntervalMs: 50 });
  t.after(async () => { stop.abort(); await running.catch(() => undefined); server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 100 && !statuses.includes('up-to-date'); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(statuses.includes('up-to-date'), 'the sub-hub copied the backup');

  const page = await ask(`/subhubs/${encodeURIComponent('office backup')}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.connection.name, 'office backup');
  assert.equal(page.body.live.name, 'office backup');
  assert.equal(page.body.live.keep, 24);
  assert.equal(page.body.live.snapshots.length, 1);
  assert.ok(page.body.live.freeBytes > 0);
  const id = page.body.live.snapshots[0].id;

  const files = await ask(`/subhubs/office%20backup/snapshots/${id}`);
  assert.equal(files.status, 200);
  assert.deepEqual(files.body.files.map((f: { path: string }) => f.path), ['data/data/replicas/1/clog/0.stdb.log', 'hub.json']);
  assert.equal(files.body.hub.kind, 'spacehub-hub-data');
  const verified = await ask(`/subhubs/office%20backup/snapshots/${id}/verify`, 'POST');
  assert.equal(verified.status, 200);
  assert.equal(verified.body.files, 2);

  // Operators only, the right method, a known machine.
  assert.equal((await ask('/subhubs/office%20backup', 'GET', 'not-an-operator')).status, 403);
  assert.equal((await ask(`/subhubs/office%20backup/snapshots/${id}/verify`)).status, 405);
  assert.equal((await ask('/subhubs/nobody')).status, 404);
  // A machine polls only for itself.
  const other = connections.register('other machine');
  const foreign = await fetch(`${hub}/-/api/instance-recovery/connections/${page.body.connection.id}/requests`, { headers: { authorization: `Bearer ${other.token}` } });
  assert.equal(foreign.status, 403);
  await foreign.body?.cancel();
});
