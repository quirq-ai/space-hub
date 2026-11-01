// The hub backs up its own data folder while it runs, keeps the newest, and
// sub-hubs copy those off the machine with a --keep window (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { backupHub, hubBackupConfig, startHubBackups } from '../src/hubbackup.ts';
import { InstanceConnections } from '../src/instanceconnections.ts';
import { handleInstanceRecovery } from '../src/instancerecovery.ts';
import { runInstanceSubhub } from '../src/instanceruntime.ts';
import { InstanceVault } from '../src/instancevault.ts';

const OPERATOR = 'operator-token-for-the-test';

function put(root: string, name: string, text: string) {
  const at = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

// A data folder shaped like the server image's /data.
function dataRoot(t: { after(fn: () => void): void }) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-backup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'data');
  put(root, 'config/id_ecdsa', 'server signing key');
  put(root, 'config/cli.toml', 'spacetimedb_token = "owner"');
  put(root, 'data/control-db/db', 'control');
  put(root, 'data/replicas/1/snapshots/00000000000000000001.snapshot_dir/00000000000000000001.snapshot_bsatn', 'snapshot');
  put(root, 'data/replicas/1/clog/00000000000000000000.stdb.log', 'commit log');
  put(root, 'data/logs/spacetime-standalone.log', 'log');
  put(root, 'data/cache/wasmtime/x', 'cache');
  put(root, 'data/spacetime.pid', '42');
  put(root, '.spacehub/recovery-connections/connections.json', '{}');
  return { tmp, root };
}

test('settings: on with a data root, off with 0 minutes, the vault beside the data by default', t => {
  const { root } = dataRoot(t);
  assert.equal(hubBackupConfig({}), null);
  assert.equal(hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_MINUTES: '0' }), null);
  const cfg = hubBackupConfig({ SPACEHUB_DATA_ROOT: root }, 'hub.example')!;
  assert.equal(cfg.everyMs, 60 * 60_000);
  assert.equal(cfg.keep, 3);
  assert.equal(cfg.vault.storageDir, path.join(root, '.spacehub', 'backups'));
  assert.throws(() => hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_MINUTES: '1' }), /5 to 10080/);
  assert.throws(() => hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_KEEP: '0' }), /1 to 100/);
});

test('a backup is the data folder without logs, caches, the pid file or the vault; the oldest go past keep', async t => {
  const { tmp, root } = dataRoot(t);
  const cfg = { ...hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_KEEP: '2' }, 'hub.example')! };
  const first = await backupHub(cfg, 1_000);
  assert.equal(first.consistency, 'live-copy');
  assert.deepEqual(first.coverage, { data: true, runtime: false, configuration: false });
  assert.deepEqual(first.services, ['spacehub']);
  const restored = path.join(tmp, 'restored');
  await cfg.vault.restore(first.id, restored);
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : files.push(`${rel}${e.name}`));
  };
  walk(restored, '');
  assert.deepEqual(files.sort(), [
    'data/config/cli.toml',
    'data/config/id_ecdsa',
    'data/data/control-db/db',
    'data/data/replicas/1/clog/00000000000000000000.stdb.log',
    'data/data/replicas/1/snapshots/00000000000000000001.snapshot_dir/00000000000000000001.snapshot_bsatn',
    'hub.json',
  ]);
  assert.equal(fs.readFileSync(path.join(restored, 'data/config/id_ecdsa'), 'utf8'), 'server signing key');
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored, 'hub.json'), 'utf8')).kind, 'spacehub-hub-data');
  await backupHub(cfg, 2_000);
  const third = await backupHub(cfg, 3_000);
  assert.deepEqual(cfg.vault.list().map(s => s.createdAt), [3_000, 2_000]);
  assert.equal(cfg.vault.list()[0].id, third.id);
  // No staging is left behind next to the vault.
  assert.deepEqual(fs.readdirSync(path.join(root, '.spacehub')).sort(), ['backups', 'recovery-connections']);
});

test('a sub-hub copies the hub\'s live backups and keeps only its --keep newest', async t => {
  const { tmp, root } = dataRoot(t);
  const cfg = hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_KEEP: '3' }, 'hub.example')!;
  const connections = new InstanceConnections(path.join(tmp, 'connections'));
  connections.initialize();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({
      vault: cfg.vault, connections, source: 'hub.example', storage: cfg.vault.storageDir, containers: [], restoreRoot: '',
      authorize: async r => r.headers.authorization === `Bearer ${OPERATOR}`,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const storage = path.join(tmp, 'subhub');
  const sync = () => runInstanceSubhub({ storage, hub, operatorToken: OPERATOR, name: 'laptop', once: true, keep: 2 }, { heartbeatIntervalMs: 50 });
  await backupHub(cfg, 1_000);
  await backupHub(cfg, 2_000);
  await backupHub(cfg, 3_000);
  await sync();
  const local = () => new InstanceVault(storage).list().map(s => s.createdAt);
  assert.deepEqual(local(), [3_000, 2_000], 'only the newest two are copied');
  put(root, 'data/replicas/1/clog/00000000000000000000.stdb.log', 'commit log, longer now');
  await backupHub(cfg, 4_000);
  await sync();
  assert.deepEqual(local(), [4_000, 3_000], 'the oldest goes as a new one arrives');
  assert.equal(connections.list()[0].name, 'laptop');
});

test('a backup copies only what changed since the last one and shares the rest; a sub-hub downloads only that', async t => {
  const { tmp, root } = dataRoot(t);
  // SpacetimeDB links one snapshot object into each snapshot that holds it.
  const object = (n: number) => path.join(root, `data/replicas/1/snapshots/0000000000000000000${n}.snapshot_dir/objects/ab/cdef`);
  put(root, 'data/replicas/1/snapshots/00000000000000000001.snapshot_dir/objects/ab/cdef', 'object');
  fs.mkdirSync(path.dirname(object(2)), { recursive: true });
  fs.linkSync(object(1), object(2));
  put(root, 'data/replicas/1/module_logs/2026-11-01.log', 'module log');
  const key = path.join(root, 'config/id_ecdsa'), clog = path.join(root, 'data/replicas/1/clog/00000000000000000000.stdb.log');
  fs.chmodSync(key, 0o640);
  // Everything last changed a minute ago.
  const past = new Date(Date.now() - 60_000);
  const touch = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const at = path.join(dir, e.name); if (e.isDirectory()) touch(at); else fs.utimesSync(at, past, past); } };
  touch(root);
  const cfg = hubBackupConfig({ SPACEHUB_DATA_ROOT: root, SPACEHUB_BACKUP_KEEP: '1' }, 'hub.example')!;
  const connections = new InstanceConnections(path.join(tmp, 'connections'));
  connections.initialize();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({
      vault: cfg.vault, connections, source: 'hub.example', storage: cfg.vault.storageDir, containers: [], restoreRoot: '',
      authorize: async r => r.headers.authorization === `Bearer ${OPERATOR}`,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const storage = path.join(tmp, 'subhub');
  const downloaded: string[] = [];
  const counting: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/file')) downloaded.push(url.searchParams.get('path')!);
    return fetch(input, init);
  };
  const sync = () => runInstanceSubhub({ storage, hub, operatorToken: OPERATOR, name: 'laptop', once: true, keep: 2 }, { heartbeatIntervalMs: 50, fetch: counting });
  const payload = (vault: InstanceVault, id: string, name: string) => path.join(vault.storageDir, 'snapshots', id, 'payload', ...name.split('/'));
  const ino = (vault: InstanceVault, id: string, name: string) => fs.statSync(payload(vault, id, name)).ino;
  const OBJECT_1 = 'data/data/replicas/1/snapshots/00000000000000000001.snapshot_dir/objects/ab/cdef';
  const OBJECT_2 = OBJECT_1.replace('0001.snapshot_dir', '0002.snapshot_dir');
  const size = (...texts: string[]) => texts.reduce((n, text) => n + Buffer.byteLength(text), 0);

  const first = await backupHub(cfg, Date.now());
  assert.equal(first.copied, size('server signing key', 'spacetimedb_token = "owner"', 'control', 'snapshot', 'commit log', 'object'), 'the first copies all the data once');
  const paths = cfg.vault.describe(first.id).files.map(f => f.path);
  assert.ok(paths.includes(OBJECT_2) && !paths.some(p => p.includes('module_logs/')), 'both names of the object, no module logs');
  assert.equal(ino(cfg.vault, first.id, OBJECT_1), ino(cfg.vault, first.id, OBJECT_2), 'one object, linked as in the data');
  await sync();

  // A commit is added and the key's mode changes: only those two are copied.
  fs.appendFileSync(clog, ', and another commit');
  fs.chmodSync(key, 0o600);
  const second = await backupHub(cfg, Date.now());
  assert.equal(second.copied, size('commit log, and another commit', 'server signing key'));
  assert.deepEqual(cfg.vault.list().map(s => s.id), [second.id], 'keep 1: the first is gone, its shared files stay');
  await cfg.vault.verify(second.id);
  const restored = path.join(tmp, 'restored');
  await cfg.vault.restore(second.id, restored);
  assert.equal(fs.readFileSync(path.join(restored, 'data/data/replicas/1/clog/00000000000000000000.stdb.log'), 'utf8'), 'commit log, and another commit');
  assert.equal(fs.readFileSync(path.join(restored, 'data/config/cli.toml'), 'utf8'), 'spacetimedb_token = "owner"');
  assert.equal(fs.statSync(path.join(restored, 'data/config/id_ecdsa')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(restored, OBJECT_2), 'utf8'), 'object');
  assert.deepEqual(fs.readdirSync(path.join(restored, 'data/data/replicas/1/module_logs')), []);

  downloaded.length = 0;
  await sync();
  assert.deepEqual(downloaded.sort(), ['data/data/replicas/1/clog/00000000000000000000.stdb.log', 'hub.json'], 'the sub-hub holds the rest already');
  const local = new InstanceVault(storage);
  assert.deepEqual(local.list().map(s => s.id), [second.id, first.id]);
  await local.verify(second.id);
  assert.equal(ino(local, second.id, 'data/config/cli.toml'), ino(local, first.id, 'data/config/cli.toml'), 'shared on the sub-hub too');
});

test('the last attempt is kept with its reason, across a restart; operators see it and start one at once', async t => {
  const { tmp, root } = dataRoot(t);
  // A volume's lost+found is left out, even when the hub cannot read it.
  fs.mkdirSync(path.join(root, 'lost+found'), { mode: 0o000 });
  const cfg = hubBackupConfig({ SPACEHUB_DATA_ROOT: root }, 'hub.example')!;
  const lines: string[] = [];
  let backups = startHubBackups(cfg, line => lines.push(line), 60_000);
  t.after(() => backups.stop());
  const connections = new InstanceConnections(path.join(tmp, 'connections'));
  connections.initialize();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({
      vault: cfg.vault, connections, source: 'hub.example', storage: cfg.vault.storageDir, containers: [], restoreRoot: '', hubBackups: backups,
      authorize: async r => r.headers.authorization === `Bearer ${OPERATOR}`,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}/-/api/instance-recovery`;
  const call = async (route: string, method = 'GET', token = OPERATOR) => {
    const res = await fetch(hub + route, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  const settled = async () => { for (let i = 0; i < 200 && backups.state().running; i++) await new Promise(r => setTimeout(r, 10)); };

  const before = await call('/status');
  assert.equal(before.body.hubBackup.everyMinutes, 60);
  assert.equal(before.body.hubBackup.running, false);
  assert.equal(before.body.hubBackup.last, undefined, 'nothing tried yet');
  assert.ok(before.body.hubBackup.nextAt > Date.now());

  const started = await call('/hub-backup', 'POST');
  assert.equal(started.status, 202);
  assert.equal(started.body.running, true);
  assert.equal((await call('/hub-backup', 'POST')).status, 409, 'one at a time');
  await settled();
  const ok = (await call('/status')).body.hubBackup.last;
  assert.equal(ok.ok, true);
  assert.equal(ok.snapshot, cfg.vault.list()[0].id);

  // Something the hub cannot back up: the reason is kept and shown.
  fs.symlinkSync('/etc/hosts', path.join(root, 'data', 'odd-link'));
  backups.now();
  await settled();
  const failed = (await call('/status')).body.hubBackup.last;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /not a file or folder: data\/odd-link/);
  assert.ok(lines.some(line => line.includes('hub backup failed')));

  // A restarted hub still knows the last result.
  backups.stop();
  backups = startHubBackups(cfg, () => undefined, 60_000);
  assert.equal(backups.state().last?.error, failed.error);

  assert.equal((await call('/hub-backup', 'POST', 'not-an-operator')).status, 403);
  assert.equal((await call('/hub-backup')).status, 405);
  fs.chmodSync(path.join(root, 'lost+found'), 0o700);
});
