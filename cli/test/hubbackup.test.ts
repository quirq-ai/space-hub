// The hub backs up its own data folder while it runs, keeps the newest, and
// sub-hubs copy those off the machine with a --keep window (npm test).
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
