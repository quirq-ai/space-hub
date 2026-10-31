import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InstanceVault, InstanceVaultError, type CaptureInfo } from '../src/instancevault.ts';

const INFO: CaptureInfo = { source: 'spacehub,proxy', services: ['spacehub', 'proxy'], consistency: 'stopped-containers', createdAt: 1_700_000_000_000, coverage: { data: true, runtime: true, configuration: true } };
const SECRET = 'private-oauth-secret-and-signing-key';
const refusal = (code: number) => (error: unknown) => error instanceof InstanceVaultError && error.status === code;

function write(root: string, name: string, value: string | Buffer, mode = 0o600) {
  const filename = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value, { mode });
  return filename;
}
function totalBytes(root: string): number {
  const stat = fs.lstatSync(root);
  return stat.isDirectory() ? fs.readdirSync(root).reduce((total, name) => total + totalBytes(path.join(root, name)), 0) : stat.size;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-instance-test-'));
  const source = path.join(root, 'prepared'), storage = path.join(root, 'vault');
  fs.mkdirSync(source);
  write(source, 'deployment.json', JSON.stringify({ Image: 'sha256:original-runtime', Env: [`SPACEHUB_GITHUB_CLIENT_SECRET=${SECRET}`], Mounts: ['/data'] }));
  write(source, 'images/spacehub.tar', Buffer.alloc(2 * 1024 * 1024 + 19, 0x47));
  write(source, 'images/proxy.tar', 'proxy-runtime');
  write(source, 'containers/spacehub.tar', 'original-container-filesystem-and-writable-layer');
  write(source, 'volumes/data/config/id_ecdsa', SECRET);
  write(source, 'volumes/data/config/id_ecdsa.pub', 'public-key');
  write(source, 'volumes/data/config/cli.toml', `spacetimedb_token = "${SECRET}"\n`);
  write(source, 'volumes/data/data/metadata.toml', 'version="2.12.0"\nedition="standalone"\n');
  write(source, 'volumes/data/data/control-db/db', Buffer.from([0, 1, 2, 255]));
  write(source, 'volumes/data/data/replicas/1/clog/00000000000000000000.stdb.log', 'all-accounts-orgs-projects-chats-permissions-private-tables');
  write(source, 'volumes/data/data/program-bytes/01/module', 'original-module');
  write(source, 'volumes/data/.private-setting', 'hidden configuration');
  fs.mkdirSync(path.join(source, 'volumes', 'data', 'empty-directory'));
  const vault = new InstanceVault(storage); vault.initialize();
  return { root, source, storage, vault, close() { vault.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('captures, verifies and restores all private deployment bytes, runtime, keys and empty directories', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO);
    assert.match(snapshot.id, /^[a-f0-9]{32}$/); assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.scope, 'instance'); assert.equal(snapshot.consistency, 'stopped-containers');
    assert.equal(snapshot.files, 12); assert.equal(snapshot.bytes, totalBytes(f.source));
    assert.deepEqual(snapshot.services, ['proxy', 'spacehub']);
    assert.deepEqual(snapshot.coverage, { data: true, runtime: true, configuration: true });
    const listed = f.vault.list();
    assert.deepEqual(listed, [snapshot]); assert.equal(JSON.stringify(listed).includes(SECRET), false);
    assert.equal(JSON.stringify(listed).includes('id_ecdsa'), false);
    assert.equal('manifest' in listed[0], false); assert.equal('deployment' in listed[0], false);
    listed[0].services.push('caller-mutation'); assert.deepEqual(f.vault.list()[0].services, snapshot.services);
    const verified = await f.vault.verify(snapshot.id);
    assert.equal(verified.files, snapshot.files); assert.equal(verified.bytes, snapshot.bytes);
    assert.ok(verified.verifiedAt > 0);
    const destination = path.join(f.root, 'recovered');
    const restored = await f.vault.restore(snapshot.id, destination);
    assert.equal(restored.directory, destination); assert.deepEqual(restored.snapshot, snapshot);
    assert.equal(fs.readFileSync(path.join(destination, 'volumes/data/config/id_ecdsa'), 'utf8'), SECRET);
    assert.equal(fs.readFileSync(path.join(destination, 'deployment.json'), 'utf8'), fs.readFileSync(path.join(f.source, 'deployment.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(destination, 'containers/spacehub.tar'), 'utf8'), 'original-container-filesystem-and-writable-layer');
    assert.equal(fs.readFileSync(path.join(destination, 'volumes/data/.private-setting'), 'utf8'), 'hidden configuration');
    assert.ok(fs.statSync(path.join(destination, 'volumes/data/empty-directory')).isDirectory());
    assert.equal(totalBytes(destination), snapshot.bytes);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(destination, 'volumes/data/config/id_ecdsa')).mode & 0o777, 0o600);
    const reopened = new InstanceVault(f.storage); reopened.initialize();
    assert.deepEqual(reopened.list(), [snapshot]); await reopened.verify(snapshot.id); reopened.close();
  } finally { f.close(); }
});

test('verified full-instance transfer retains source identity and private bytes without a new generation', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO);
    const manifest = await f.vault.exportManifest(snapshot.id);
    const replica = new InstanceVault(path.join(f.root, 'replica')); replica.initialize();
    const imported = await replica.importSnapshot(f.source, manifest);
    assert.deepEqual(imported, snapshot);
    assert.deepEqual(await replica.importSnapshot(f.source, manifest), snapshot, 'Retries reuse the immutable generation');
    assert.equal(replica.list().length, 1);
    await replica.verify(snapshot.id);
    const output = await f.vault.openPayload(snapshot.id, 'volumes/data/config/id_ecdsa');
    const parts: Buffer[] = []; for await (const part of output.stream) parts.push(Buffer.from(part));
    assert.equal(Buffer.concat(parts).toString('utf8'), SECRET);
    assert.equal(output.size, Buffer.byteLength(SECRET));
    await assert.rejects(f.vault.openPayload(snapshot.id, '../manifest.json'));
    await assert.rejects(f.vault.openPayload(snapshot.id, 'private-unlisted-file'));
    const restored = path.join(f.root, 'replica-restored'); await replica.restore(snapshot.id, restored);
    assert.equal(fs.readFileSync(path.join(restored, 'volumes/data/config/id_ecdsa'), 'utf8'), SECRET);
  } finally { f.close(); }
});

test('automatic transfer rejects altered manifests and corrupt files before publication', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO), manifest = await f.vault.exportManifest(snapshot.id);
    const replica = new InstanceVault(path.join(f.root, 'replica')); replica.initialize();
    const changed = structuredClone(manifest); changed.files[0].sha256 = '0'.repeat(64);
    await assert.rejects(replica.importSnapshot(f.source, changed), /integrity/);
    const empty = structuredClone(manifest);
    empty.files = []; empty.directories = [];
    const { files: _files, bytes: _bytes, sha256: _hash, ...info } = empty.snapshot;
    empty.snapshot.files = 0; empty.snapshot.bytes = 0;
    empty.snapshot.sha256 = crypto.createHash('sha256').update(JSON.stringify({ version: 1, info, rootMode: empty.rootMode, directories: [], files: [] })).digest('hex');
    await assert.rejects(replica.importSnapshot(f.source, empty), /bundle needs/);
    fs.writeFileSync(path.join(f.source, 'containers', 'spacehub.tar'), 'corrupt-transfer');
    await assert.rejects(replica.importSnapshot(f.source, manifest));
    assert.deepEqual(replica.list(), []);
    assert.deepEqual(fs.readdirSync(path.join(replica.storageDir, 'staging')), []);
    assert.equal((await f.vault.verify(snapshot.id)).snapshot.sha256, snapshot.sha256);
  } finally { f.close(); }
});

test('a concurrent lock recovery guard is never adopted or removed by another writer', async () => {
  const f = fixture();
  try {
    const guard = path.join(f.storage, '.writer.lock.guard');
    fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, nonce: 'another-acquirer' }));
    const reopened = new InstanceVault(f.storage); reopened.initialize();
    await assert.rejects(reopened.capture(f.source, INFO), /lock acquisition is busy/);
    assert.match(fs.readFileSync(guard, 'utf8'), /another-acquirer/);
    assert.equal(fs.existsSync(path.join(f.storage, '.writer.lock')), false);
    fs.unlinkSync(guard);
    const snapshot = await reopened.capture(f.source, INFO);
    await reopened.verify(snapshot.id);
  } finally { f.close(); }
});

test('refuses partial coverage and incomplete prepared bundles rather than publishing misleading snapshots', async () => {
  const f = fixture();
  try {
    for (const key of ['data', 'runtime', 'configuration'] as const) await assert.rejects(f.vault.capture(f.source, { ...INFO, coverage: { ...INFO.coverage, [key]: false } }), refusal(400));
    await assert.rejects(f.vault.capture(f.source, { ...INFO, consistency: 'live-copy' as any }), refusal(400));
    const incomplete = path.join(f.root, 'incomplete'); fs.mkdirSync(incomplete); write(incomplete, 'deployment.json', '{}');
    await assert.rejects(f.vault.capture(incomplete, INFO), refusal(400));
    write(incomplete, 'images/spacehub.tar', 'base-image'); write(incomplete, 'volumes/data.tar', 'complete-private-mount-archive');
    await assert.rejects(f.vault.capture(incomplete, INFO), refusal(400));
    write(incomplete, 'containers/spacehub.tar', 'container-writable-layer');
    const completeArchive = await f.vault.capture(incomplete, INFO);
    const archiveDestination = path.join(f.root, 'archive-restored'); await f.vault.restore(completeArchive.id, archiveDestination);
    assert.equal(fs.readFileSync(path.join(archiveDestination, 'volumes/data.tar'), 'utf8'), 'complete-private-mount-archive');
    assert.deepEqual(f.vault.list(), [completeArchive]); assert.deepEqual(fs.readdirSync(path.join(f.storage, 'staging')), []);
    assert.equal(fs.existsSync(path.join(f.storage, '.writer.lock')), false);
  } finally { f.close(); }
});

test('vault roots are dedicated and sources cannot include or live within vault storage', async () => {
  const f = fixture();
  try {
    const unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated); write(unrelated, 'important', 'keep');
    assert.throws(() => new InstanceVault(unrelated).initialize(), refusal(400));
    assert.equal(fs.readFileSync(path.join(unrelated, 'important'), 'utf8'), 'keep');
    assert.throws(() => new InstanceVault(path.parse(f.root).root), refusal(400));
    assert.throws(() => new InstanceVault('relative-vault'), refusal(400));
    for (const maxBytes of [0, -1, NaN, 1.5]) assert.throws(() => new InstanceVault(path.join(f.root, 'invalid'), { maxBytes }), refusal(400));
    await assert.rejects(f.vault.capture(f.root, INFO), refusal(400));
    await assert.rejects(f.vault.capture(path.join(f.storage, 'staging'), INFO), refusal(400));
    assert.deepEqual(f.vault.list(), []);
  } finally { f.close(); }
});

test('rejects source symlinks and junctions, while materializing legitimate hardlinked snapshot objects', async t => {
  const f = fixture();
  try {
    const key = path.join(f.source, 'volumes/data/config/id_ecdsa');
    const alias = path.join(f.source, 'volumes/data/config/hardlinked-key');
    fs.linkSync(key, alias);
    const snapshot = await f.vault.capture(f.source, INFO);
    const destination = path.join(f.root, 'hardlink-restored'); await f.vault.restore(snapshot.id, destination);
    assert.equal(fs.statSync(path.join(destination, 'volumes/data/config/hardlinked-key')).nlink, 1);
    const linkedSource = path.join(f.root, 'source-link');
    try { fs.symlinkSync(f.source, linkedSource, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.diagnostic('symlink creation permission unavailable'); return; }
      throw error;
    }
    await assert.rejects(f.vault.capture(linkedSource, INFO), refusal(400));
    const nested = path.join(f.source, 'volumes/data/link');
    fs.symlinkSync(path.dirname(key), nested, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.vault.capture(f.source, INFO), refusal(400));
    const linkedVault = path.join(f.root, 'vault-link'); fs.symlinkSync(f.storage, linkedVault, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new InstanceVault(linkedVault).initialize(), refusal(400));
    assert.equal(f.vault.list().length, 1);
  } finally { f.close(); }
});

test('payload corruption fails verification and restore, leaving older immutable snapshots usable', async () => {
  const f = fixture();
  try {
    const first = await f.vault.capture(f.source, INFO);
    write(f.source, 'volumes/data/config/id_ecdsa', 'new-private-key');
    const second = await f.vault.capture(f.source, { ...INFO, createdAt: INFO.createdAt! + 1 });
    assert.deepEqual(f.vault.list().map(snapshot => snapshot.id), [second.id, first.id]);
    const target = path.join(f.storage, 'snapshots', second.id, 'payload/volumes/data/config/id_ecdsa');
    fs.writeFileSync(target, 'tampered');
    await assert.rejects(f.vault.verify(second.id), refusal(409));
    const destination = path.join(f.root, 'corrupt-restore');
    await assert.rejects(f.vault.restore(second.id, destination), refusal(409));
    assert.equal(fs.existsSync(destination), false);
    await f.vault.verify(first.id);
    const recovered = path.join(f.root, 'original'); await f.vault.restore(first.id, recovered);
    assert.equal(fs.readFileSync(path.join(recovered, 'volumes/data/config/id_ecdsa'), 'utf8'), SECRET);
  } finally { f.close(); }
});

test('manifest traversal, missing parents and catalog tampering cannot redirect restore writes', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO);
    const filename = path.join(f.storage, 'snapshots', snapshot.id, 'manifest.json');
    const original = fs.readFileSync(filename, 'utf8');
    for (const invalidPath of ['../escape', '/escape', 'a/../../escape', 'C:/escape', 'a\\escape', 'a//escape', 'a/trailing.', 'a/trailing ', 'a/CON', 'a/nul.tar', 'a/COM1.txt', 'a/with?question', 'a/with<angle']) {
      const manifest = JSON.parse(original); manifest.files[0].path = invalidPath;
      fs.writeFileSync(filename, JSON.stringify(manifest));
      await assert.rejects(f.vault.restore(snapshot.id, path.join(f.root, 'outside')), refusal(400));
      assert.equal(fs.existsSync(path.join(f.root, 'outside')), false);
      assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
    }
    fs.writeFileSync(filename, original);
    const catalog = path.join(f.storage, 'snapshots', snapshot.id, 'snapshot.json');
    const changed = JSON.parse(fs.readFileSync(catalog, 'utf8')); changed.bytes++;
    fs.writeFileSync(catalog, JSON.stringify(changed));
    await assert.rejects(f.vault.verify(snapshot.id), refusal(409));
    await assert.rejects(f.vault.verify('../elsewhere'), refusal(400));
  } finally { f.close(); }
});

test('restore exclusively creates a new outside directory and preserves existing destinations', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO);
    const existing = path.join(f.root, 'existing'); fs.mkdirSync(existing); write(existing, 'keep', 'original');
    await assert.rejects(f.vault.restore(snapshot.id, existing), refusal(409));
    assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'original');
    const empty = path.join(f.root, 'empty'); fs.mkdirSync(empty);
    await assert.rejects(f.vault.restore(snapshot.id, empty), refusal(409));
    await assert.rejects(f.vault.restore(snapshot.id, path.join(f.storage, 'bad-restore')), refusal(400));
    await assert.rejects(f.vault.restore(snapshot.id, 'relative-restore'), refusal(400));
    assert.equal(f.vault.list().length, 1);
  } finally { f.close(); }
});

test('quota is checked before copying and again after metadata, without harming prior snapshots', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, INFO);
    const current = totalBytes(f.storage), sourceBytes = totalBytes(f.source);
    const tooSmall = new InstanceVault(f.storage, { maxBytes: current + sourceBytes - 1 }); tooSmall.initialize();
    await assert.rejects(tooSmall.capture(f.source, INFO), refusal(413));
    const noMetadataRoom = new InstanceVault(f.storage, { maxBytes: current + sourceBytes + 128 }); noMetadataRoom.initialize();
    await assert.rejects(noMetadataRoom.capture(f.source, INFO), refusal(413));
    assert.deepEqual(f.vault.list(), [snapshot]); await f.vault.verify(snapshot.id);
    assert.deepEqual(fs.readdirSync(path.join(f.storage, 'staging')), []);
    assert.equal(fs.existsSync(path.join(f.storage, '.writer.lock')), false);
  } finally { f.close(); }
});

test('capture holds a per-operation writer lock while concurrent readers remain usable', async () => {
  const f = fixture();
  try {
    const first = await f.vault.capture(f.source, INFO);
    const other = new InstanceVault(f.storage); other.initialize();
    const filename = path.join(f.storage, '.writer.lock');
    fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') }));
    try {
      assert.deepEqual(other.list(), [first]); await other.verify(first.id);
      await assert.rejects(other.capture(f.source, INFO), refusal(409));
    } finally { fs.unlinkSync(filename); }
    const results = await Promise.allSettled([f.vault.capture(f.source, INFO), other.capture(f.source, INFO)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.vault.list().length, 2);
    const sequential = await Promise.all([f.vault.capture(f.source, INFO), f.vault.capture(f.source, INFO)]);
    assert.notEqual(sequential[0].id, sequential[1].id);
    assert.equal(f.vault.list().length, 4);
  } finally { f.close(); }
});

test('source mutation during asynchronous transfer aborts the snapshot and releases the writer lock', async () => {
  const f = fixture();
  try {
    const first = await f.vault.capture(f.source, INFO);
    const transfer = f.vault.capture(f.source, INFO);
    const modified = new Promise<void>(resolve => setImmediate(() => { write(f.source, 'deployment.json', JSON.stringify({ modified: true, secret: SECRET })); resolve(); }));
    await assert.rejects(transfer, refusal(409)); await modified;
    assert.deepEqual(f.vault.list(), [first]); await f.vault.verify(first.id);
    assert.deepEqual(fs.readdirSync(path.join(f.storage, 'staging')), []);
    assert.equal(fs.existsSync(path.join(f.storage, '.writer.lock')), false);
  } finally { f.close(); }
});

test('metadata labels redact credentials while full private payload remains recoverable', async () => {
  const f = fixture();
  try {
    const snapshot = await f.vault.capture(f.source, { ...INFO, source: 'https://user:source-secret@example.invalid?token=source-secret' });
    assert.equal(JSON.stringify(f.vault.list()).includes('source-secret'), false);
    assert.equal(JSON.stringify(f.vault.list()).includes(SECRET), false);
    await f.vault.verify(snapshot.id);
    const destination = path.join(f.root, 'private-restore'); await f.vault.restore(snapshot.id, destination);
    assert.ok(fs.readFileSync(path.join(destination, 'deployment.json'), 'utf8').includes(SECRET));
  } finally { f.close(); }
});
