// A hub that keeps no backups serves its data folder live, and a sub-hub (the
// backup container, or any machine) copies it, only what changed (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InstanceConnections } from '../src/instanceconnections.ts';
import { handleInstanceRecovery } from '../src/instancerecovery.ts';
import { runInstanceSubhub } from '../src/instanceruntime.ts';
import { InstanceVault } from '../src/instancevault.ts';

const OPERATOR = 'operator-token-for-the-test';
const CLOG = 'data/replicas/1/clog/00000000000000000000.stdb.log';
const OBJECT = 'data/replicas/1/snapshots/00000000000000000001.snapshot_dir/objects/ab/cdef';

function put(root: string, name: string, text: string) {
  const at = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

// A hub serving a data folder shaped like the server image's /data, with no
// vault of its own.
async function hub(t: { after(fn: () => void): void }) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-data-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'data');
  put(root, 'config/id_ecdsa', 'server signing key');
  put(root, 'config/cli.toml', 'spacetimedb_token = "owner"');
  put(root, 'data/control-db/db', 'control');
  put(root, OBJECT, 'object');
  // SpacetimeDB links one snapshot object into each snapshot that holds it.
  fs.mkdirSync(path.dirname(path.join(root, OBJECT.replace('0001.snapshot_dir', '0002.snapshot_dir'))), { recursive: true });
  fs.linkSync(path.join(root, OBJECT), path.join(root, OBJECT.replace('0001.snapshot_dir', '0002.snapshot_dir')));
  put(root, CLOG, 'commit log');
  put(root, 'data/replicas/1/module_logs/2026-11-01.log', 'module log');
  put(root, 'data/logs/spacetime-standalone.log', 'log');
  put(root, 'data/cache/wasmtime/x', 'cache');
  put(root, 'data/spacetime.pid', '42');
  put(root, '.spacehub/recovery-connections/connections.json', '{}');
  fs.chmodSync(path.join(root, 'config/id_ecdsa'), 0o640);
  // Everything last changed a minute ago.
  const past = new Date(Date.now() - 60_000);
  const touch = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const at = path.join(dir, e.name); if (e.isDirectory()) touch(at); else fs.utimesSync(at, past, past); } };
  touch(root);
  const connections = new InstanceConnections(path.join(tmp, 'connections'));
  connections.initialize();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({
      vault: null, connections, source: 'hub.example', storage: '', containers: [], restoreRoot: '', dataRoot: root,
      authorize: async r => r.headers.authorization === `Bearer ${OPERATOR}`,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { tmp, root, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('a sub-hub copies a hub that keeps no backups: its data folder live, the commit logs last, then only what changed', async t => {
  const { tmp, root, url } = await hub(t);
  const storage = path.join(tmp, 'backup');
  const fetched: string[] = [];
  let dropped = 0;
  const counting: typeof fetch = (input, init) => {
    const at = new URL(String(input));
    if (at.pathname.endsWith('/source/live/file')) {
      // The connection drops once: that file is tried again.
      if (at.searchParams.get('path') === 'data/control-db/db' && !dropped++) return Promise.reject(new TypeError('fetch failed'));
      fetched.push(at.searchParams.get('path')!);
    }
    return fetch(input, init);
  };
  const sync = () => runInstanceSubhub({ storage, hub: url, operatorToken: OPERATOR, name: 'backup', once: true, keep: 2 }, { heartbeatIntervalMs: 50, fetch: counting });
  const vault = new InstanceVault(storage);
  const payload = (id: string, name: string) => path.join(storage, 'snapshots', id, 'payload', ...name.split('/'));

  await sync();
  const [first] = vault.list();
  assert.equal(first.consistency, 'live-copy');
  assert.equal(first.source, url);
  assert.equal(fetched.at(-1), CLOG, 'the commit log comes last');
  assert.equal(fetched.filter(name => name.endsWith('/objects/ab/cdef')).length, 1, 'one object, two names: copied once');
  assert.deepEqual(fetched.filter(name => !name.endsWith('/objects/ab/cdef')).sort(), ['config/cli.toml', 'config/id_ecdsa', CLOG, 'data/control-db/db'].sort());
  assert.equal(fs.statSync(payload(first.id, `data/${OBJECT}`)).ino, fs.statSync(payload(first.id, `data/${OBJECT.replace('0001.snapshot_dir', '0002.snapshot_dir')}`)).ino, 'and kept once');
  const restored = path.join(tmp, 'restored');
  await vault.restore(first.id, restored);
  assert.equal(fs.readFileSync(path.join(restored, 'data', 'config/id_ecdsa'), 'utf8'), 'server signing key');
  assert.equal(fs.statSync(path.join(restored, 'data', 'config/id_ecdsa')).mode & 0o777, 0o640, 'modes as on the hub');
  assert.equal(fs.readFileSync(path.join(restored, 'data', CLOG), 'utf8'), 'commit log');
  assert.equal(fs.readFileSync(path.join(restored, 'data', 'data/control-db/db'), 'utf8'), 'control', 'the dropped download was tried again');
  assert.deepEqual(fs.readdirSync(path.join(restored, 'data/data/replicas/1/module_logs')), [], 'module logs left out, their folder kept');
  for (const left of ['data/logs', 'data/cache', 'data/spacetime.pid', '.spacehub']) assert.equal(fs.existsSync(path.join(restored, 'data', left)), false, `${left} is left out`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored, 'hub.json'), 'utf8')).kind, 'spacehub-hub-data');

  // A commit is added, the key's mode changes, and SpacetimeDB makes another
  // snapshot holding the same object: only the first two move.
  fs.appendFileSync(path.join(root, CLOG), ', and another commit');
  const third = OBJECT.replace('0001.snapshot_dir', '0003.snapshot_dir');
  fs.mkdirSync(path.dirname(path.join(root, third)), { recursive: true });
  fs.linkSync(path.join(root, OBJECT), path.join(root, third));
  fs.chmodSync(path.join(root, 'config/id_ecdsa'), 0o600);
  fetched.length = 0;
  await sync();
  assert.deepEqual(fetched.sort(), ['config/id_ecdsa', CLOG]);
  const [second] = vault.list();
  assert.notEqual(second.id, first.id);
  await vault.verify(second.id);
  const again = path.join(tmp, 'again');
  await vault.restore(second.id, again);
  assert.equal(fs.readFileSync(path.join(again, 'data', CLOG), 'utf8'), 'commit log, and another commit');
  assert.equal(fs.statSync(path.join(again, 'data', 'config/id_ecdsa')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(again, 'data', third), 'utf8'), 'object');
  assert.equal(fs.statSync(payload(second.id, `data/${third}`)).ino, fs.statSync(payload(first.id, `data/${OBJECT}`)).ino, 'the new name shares the copy already here');
  assert.equal(fs.statSync(payload(second.id, 'data/config/cli.toml')).ino, fs.statSync(payload(first.id, 'data/config/cli.toml')).ino, 'unchanged files are shared on disk');

  await sync();
  assert.equal(vault.list().length, 2, 'keep 2');
  // The hub keeps nothing of its own.
  assert.deepEqual(fs.readdirSync(path.join(root, '.spacehub')), ['recovery-connections']);
});

test('the hub serves its data only to sub-hubs and operators, and only what a backup holds', async t => {
  const { root, url } = await hub(t);
  const get = (route: string, token = OPERATOR) => fetch(`${url}/-/api/instance-recovery${route}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get('/source/live?part=body', 'someone')).status, 403);
  assert.equal((await get('/source/live/file?path=config/id_ecdsa', 'someone')).status, 403);
  const body = await (await get('/source/live?part=body')).json();
  assert.ok(body.files.some((f: { path: string }) => f.path === 'config/id_ecdsa'));
  assert.ok(!body.files.some((f: { path: string }) => f.path.includes('/clog/')), 'the commit logs are their own part');
  const logs = await (await get('/source/live?part=logs')).json();
  assert.deepEqual(logs.files.map((f: { path: string }) => f.path), [CLOG]);
  const file = await get(`/source/live/file?path=${encodeURIComponent(CLOG)}`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'commit log');
  for (const name of ['../outside', '.spacehub/recovery-connections/connections.json', 'data/logs/spacetime-standalone.log', 'data/replicas/1/module_logs/2026-11-01.log', 'data/spacetime.pid']) {
    assert.ok([400, 404].includes((await get(`/source/live/file?path=${encodeURIComponent(name)}`)).status), name);
  }
  fs.symlinkSync('/etc/hosts', path.join(root, 'config', 'hosts'));
  assert.equal((await get('/source/live/file?path=config/hosts')).status, 404, 'no links');
  assert.equal((await get('/source/live?part=body')).status, 409, 'a link in the data folder stops a listing');
  assert.equal((await get('/source/live?part=all')).status, 400);
});
