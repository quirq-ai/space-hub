import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { InstanceConnections } from '../src/instanceconnections.ts';
import type { Snapshot } from '../src/instancevault.ts';

const snapshot = (): Snapshot => ({ id: 'a'.repeat(32), createdAt: 1_700_000_000_000, source: 'primary-hub', services: ['spacehub', 'proxy'], scope: 'instance', consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true }, files: 5, bytes: 1024, sha256: 'b'.repeat(64) });
const denied = (status: number) => (error: any) => error.status === status;
function fixture(t: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-connections-'));
  t.after(() => { const checked = path.resolve(root); assert.equal(path.dirname(checked), path.resolve(os.tmpdir())); assert.ok(path.basename(checked).startsWith('instance-connections-')); fs.rmSync(checked, { recursive: true, force: true }); });
  const storage = path.join(root, 'registry'); let now = 1_700_000_000_000;
  const connections = new InstanceConnections(storage, { now: () => now }); connections.initialize();
  return { root, storage, connections, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('registration persists only hashed credentials; public status and online age survive restart', t => {
  const f = fixture(t), enrollment = f.connections.register('Recovery laptop');
  assert.match(enrollment.id, /^[a-f0-9]{32}$/); assert.match(enrollment.token, /^[a-f0-9]{64}$/);
  const text = fs.readFileSync(path.join(f.storage, 'connections.json'), 'utf8');
  assert.ok(!text.includes(enrollment.token));
  assert.ok(text.includes(crypto.createHash('sha256').update(enrollment.token).digest('hex')));
  assert.equal(f.connections.authorize(enrollment.token), true);
  assert.equal(f.connections.authorize('c'.repeat(64)), false);
  assert.equal(f.connections.authorize('hub-operator'), false);
  const first = f.connections.list()[0];
  assert.equal(first.online, true); assert.equal(first.state, 'waiting'); assert.equal(first.connectedAt, f.now());
  assert.ok(!JSON.stringify(first).includes('token'));
  f.advance(45_001); assert.equal(f.connections.list()[0].online, false);
  const reopened = new InstanceConnections(f.storage, { now: f.now }); reopened.initialize();
  assert.equal(reopened.authorize(enrollment.token), true);
  const updated = reopened.heartbeat(enrollment.id, enrollment.token, { state: 'up-to-date', snapshots: [snapshot()], lastSeen: 0 });
  assert.equal(updated.online, true); assert.equal(updated.lastSeen, f.now()); assert.equal(updated.connectedAt, first.connectedAt);
  updated.snapshots[0].services.push('caller-mutation'); assert.deepEqual(reopened.list()[0].snapshots[0].services, ['spacehub', 'proxy']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.storage, 'connections.json')).mode & 0o777, 0o600);
});

test('persisted client enrollment is idempotent after a lost response and rejects identity or token conflicts', t => {
  const f = fixture(t), enrollment = { id: '1'.repeat(32), token: '2'.repeat(64) };
  assert.deepEqual(f.connections.register('Laptop', enrollment), enrollment);
  f.advance(2000); f.connections.heartbeat(enrollment.id, enrollment.token, { state: 'syncing', snapshots: [snapshot()] });
  const before = f.connections.list();
  assert.deepEqual(new InstanceConnections(f.storage).register('Laptop', enrollment), enrollment);
  assert.equal(f.connections.list().length, 1); assert.equal(f.connections.list()[0].lastSeen, before[0].lastSeen); assert.equal(f.connections.list()[0].state, 'syncing');
  assert.throws(() => f.connections.register('Different name', enrollment), denied(409));
  assert.throws(() => f.connections.register('Laptop', { ...enrollment, token: '3'.repeat(64) }), denied(409));
  assert.throws(() => f.connections.register('Other machine', { ...enrollment, id: '4'.repeat(32) }), denied(409));
  assert.throws(() => f.connections.register('Laptop', { id: '../escape', token: enrollment.token }), denied(400));
});

test('only the matching machine can update its heartbeat and reports contain full-instance summaries only', t => {
  const f = fixture(t), one = f.connections.register('One'), two = f.connections.register('Two'), before = f.connections.list();
  assert.throws(() => f.connections.heartbeat(one.id, two.token, { state: 'error', snapshots: [] }), denied(403));
  assert.throws(() => f.connections.heartbeat('../escape', one.token, { state: 'error', snapshots: [] }), denied(403));
  assert.deepEqual(f.connections.list(), before);
  for (const input of [{ state: 'execute', snapshots: [] }, { state: 'up-to-date', snapshots: [{ ...snapshot(), scope: 'project' }] }, { state: 'up-to-date', snapshots: [{ ...snapshot(), coverage: { data: false, runtime: true, configuration: true } }] }, { state: 'up-to-date', snapshots: [snapshot(), snapshot()] }, { state: 'up-to-date', snapshots: Array.from({ length: 257 }, snapshot) }]) assert.throws(() => f.connections.heartbeat(one.id, one.token, input), denied(400));
  const clean = f.connections.heartbeat(one.id, one.token, { state: 'error', snapshots: [{ ...snapshot(), source: 'TOKEN=secret-value', environment: ['PRIVATE_KEY=secret-value'] }], error: 'Failed at C:\\private\\token.txt with Bearer secret-value', session: 'private-user-session', work: 'run this' });
  assert.equal(clean.snapshots[0].source, '[redacted]'); assert.match(clean.error!, /Check the Sub-hub CLI/);
  assert.ok(!JSON.stringify(clean).includes('secret-value')); assert.ok(!JSON.stringify(clean).includes('private-user-session')); assert.ok(!('work' in clean));
  const noError = f.connections.heartbeat(one.id, one.token, { state: 'up-to-date', snapshots: [] }); assert.ok(!('error' in noError));
  const largeMetadata = { ...snapshot(), source: 'p'.repeat(1024), services: Array.from({ length: 256 }, (_, index) => `service-${index}`) };
  assert.deepEqual(f.connections.heartbeat(one.id, one.token, { state: 'up-to-date', snapshots: [largeMetadata] }).snapshots, [largeMetadata]);
});

test('machine names cannot be links, HTML or private configuration', t => {
  const f = fixture(t);
  for (const name of ['', '  ', '<script>x</script>', 'https://machine.example', 'TOKEN=secret', 'name\nnewline', '../escape', 'x'.repeat(81)]) assert.throws(() => f.connections.register(name), denied(400));
  assert.equal(f.connections.list().length, 0);
  f.connections.register('Málaga workstation'); assert.equal(f.connections.list()[0].name, 'Málaga workstation');
});

test('dedicated directories, writer locks, corruption and symlinked registry files fail closed', t => {
  const f = fixture(t), unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'untouched');
  assert.throws(() => new InstanceConnections(unrelated).initialize(), /empty dedicated/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'untouched');
  fs.writeFileSync(path.join(f.storage, '.writer.lock'), JSON.stringify({ pid: process.pid, nonce: 'a'.repeat(32) }));
  assert.throws(() => f.connections.register('Blocked'), denied(409)); fs.unlinkSync(path.join(f.storage, '.writer.lock'));
  f.connections.register('Before corruption');
  fs.writeFileSync(path.join(f.storage, 'connections.json'), '{"version":99}');
  assert.throws(() => f.connections.list(), denied(409));
  assert.throws(() => f.connections.register('After corruption'), denied(409));
  assert.equal(fs.readFileSync(path.join(f.storage, 'connections.json'), 'utf8'), '{"version":99}');
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(unrelated, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new InstanceConnections(linked).initialize(), /symlinks/);
});

test('a positively dead writer is recovered while active or malformed locks remain protected', t => {
  const f = fixture(t), child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 10_000 });
  assert.equal(child.status, 0); assert.ok(child.pid > 0);
  assert.throws(() => process.kill(child.pid, 0), (error: any) => error.code === 'ESRCH');
  const lock = path.join(f.storage, '.writer.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: 'c'.repeat(32) }));
  const machine = f.connections.register('After crash'); assert.equal(f.connections.authorize(machine.token), true); assert.equal(fs.existsSync(lock), false);
  // A crash from the earlier PID-only format can be recovered as well.
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid }));
  assert.equal(f.connections.heartbeat(machine.id, machine.token, { state: 'waiting', snapshots: [] }).online, true);
  fs.writeFileSync(lock, 'partial lock');
  assert.throws(() => f.connections.register('Invalid writer'), denied(409)); assert.equal(fs.readFileSync(lock, 'utf8'), 'partial lock');
});

test('lock release verifies its owner nonce and never removes a replacement lock', t => {
  const f = fixture(t), original = fs.renameSync, lock = path.join(f.storage, '.writer.lock');
  const replacement = JSON.stringify({ pid: process.pid, nonce: 'e'.repeat(32) });
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    original(from, to);
    if (String(to) === path.join(f.storage, 'connections.json')) fs.writeFileSync(lock, replacement);
  }) as typeof fs.renameSync;
  try { assert.throws(() => f.connections.register('Replaced writer'), /ownership changed/); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement); assert.equal(f.connections.list().length, 1);
});

test('the acquisition guard excludes another stale reaper through writer creation and is released before normal mutation', t => {
  const f = fixture(t), child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 10_000 });
  assert.equal(child.status, 0); assert.throws(() => process.kill(child.pid, 0), (error: any) => error.code === 'ESRCH');
  const lock = path.join(f.storage, '.writer.lock'), guard = lock + '.guard';
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, nonce: 'd'.repeat(32) }));
  const unlink = fs.unlinkSync, rename = fs.renameSync; let attempted = false, changed = false;
  fs.unlinkSync = ((filename: fs.PathLike) => {
    unlink(filename);
    if (String(filename) === lock && !attempted) {
      attempted = true; assert.equal(fs.existsSync(guard), true);
      assert.throws(() => new InstanceConnections(f.storage).register('Concurrent stale reaper'), /guard.*inspect/);
    }
  }) as typeof fs.unlinkSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(f.storage, 'connections.json')) { changed = true; assert.equal(fs.existsSync(guard), false); assert.equal(fs.existsSync(lock), true); }
    rename(from, to);
  }) as typeof fs.renameSync;
  try { f.connections.register('Only acquired writer'); }
  finally { fs.unlinkSync = unlink; fs.renameSync = rename; }
  assert.equal(attempted, true); assert.equal(changed, true); assert.equal(f.connections.list().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(guard), false);
});

test('an abandoned acquisition guard fails closed with an inspection message and never gets automatically reclaimed', t => {
  const f = fixture(t), guard = path.join(f.storage, '.writer.lock.guard');
  fs.writeFileSync(guard, '{"pid":1}');
  const reopened = new InstanceConnections(f.storage); reopened.initialize(); assert.deepEqual(reopened.list(), []);
  assert.throws(() => reopened.register('Blocked by guard'), /inspect \.writer\.lock\.guard before removal/);
  assert.equal(fs.readFileSync(guard, 'utf8'), '{"pid":1}'); assert.equal(fs.existsSync(path.join(f.storage, '.writer.lock')), false);
});
