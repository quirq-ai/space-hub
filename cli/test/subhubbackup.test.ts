// Subhub backups against local bare Git remotes. No hub or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupStore, type BackupProject } from '../src/subhubbackup.ts';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-backup-'));
const emptyConfig = path.join(temporary, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
test.after(() => {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temporary, { recursive: true, force: true });
});
let counter = 0;

function git(directory: string, ...args: string[]) {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=backup-test', '-c', 'user.email=backup@example.com', ...args], {
    env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function fixture(empty = false) {
  const directory = path.join(temporary, `case-${++counter}`);
  fs.mkdirSync(directory);
  const remote = path.join(directory, 'source.git');
  git(directory, 'init', '--bare', '-q', '-b', 'main', remote);
  const seed = path.join(directory, 'seed');
  let first = '';
  let head = '';
  if (!empty) {
    git(directory, 'init', '-q', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, 'README.md'), 'first\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'first');
    first = git(seed, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(seed, 'README.md'), 'second\n');
    fs.mkdirSync(path.join(seed, 'channels'));
    fs.writeFileSync(path.join(seed, 'channels', '.log.jsonl'), '{"text":"remember me"}\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'second');
    head = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'tag', '-a', 'v1', first, '-m', 'first release');
    git(seed, 'push', '-q', remote, 'main', 'refs/tags/v1', `${head}:refs/custom/work-items`);
  }
  const project: BackupProject = {
    fullName: 'quirq/CON', id: '17', createdAt: '2026-10-31T00:00:00.000Z',
    defaultBranch: 'main', sourceUrl: remote,
  };
  const storage = path.join(directory, 'backup');
  return { directory, remote, seed, first, head, project, storage, store: new BackupStore(storage) };
}

test('initial backup captures every ref, committed chat files, and an immutable self-contained bundle', async () => {
  const f = fixture();
  const snapshot = await f.store.backup(f.project, { SPACEHUB_TOKEN: 'private-test-token-do-not-save' });
  assert.match(snapshot.id, /^[a-f0-9]{32}$/);
  assert.equal(snapshot.project, 'quirq/CON');
  assert.equal(snapshot.oid, f.head);
  assert.equal(snapshot.refs['refs/custom/work-items'], f.head);
  assert.equal(snapshot.refs['refs/tags/v1'], git(f.remote, 'rev-parse', 'refs/tags/v1'));
  assert.equal(snapshot.bundle, 'repository.bundle');
  assert.match(snapshot.sha256!, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(f.store.bundlePath(snapshot.id)!).size + fs.statSync(path.join(f.storage, 'snapshots', snapshot.id, 'manifest.json')).size, snapshot.bytes);
  const manifest = fs.readFileSync(path.join(f.storage, 'snapshots', snapshot.id, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('private-test-token'));
  assert.deepEqual(f.store.list('quirq/CON'), [snapshot]);
  assert.equal(Buffer.from(await f.store.readFile(snapshot.id, f.head, 'channels/.log.jsonl')).toString(), '{"text":"remember me"}\n');
  assert.equal(Buffer.from(await f.store.readFile(snapshot.id, f.first, 'README.md')).toString(), 'first\n');
  const same = await f.store.backup(f.project);
  assert.equal(same.id, snapshot.id);
  assert.equal(f.store.list().length, 1);
});

test('force pushes and deleted refs create a generation while the previous generation restores offline', async () => {
  const f = fixture();
  const old = await f.store.backup(f.project);
  const oldBytes = fs.readFileSync(f.store.bundlePath(old.id)!);
  git(f.seed, 'push', '-q', '--force', f.remote, `${f.first}:refs/heads/main`, ':refs/custom/work-items', ':refs/tags/v1');
  const next = await f.store.backup(f.project);
  assert.notEqual(next.id, old.id);
  assert.deepEqual(next.refs, { 'refs/heads/main': f.first });
  assert.deepEqual(fs.readFileSync(f.store.bundlePath(old.id)!), oldBytes);
  assert.deepEqual(f.store.list().map(snapshot => snapshot.id), [next.id, old.id]);
  const offline = path.join(f.directory, 'source-offline.git');
  fs.renameSync(f.remote, offline);
  await assert.rejects(f.store.backup(f.project), /git clone|git fetch/);
  assert.equal(f.store.list().length, 2);
  const destination = path.join(f.directory, 'restored.git');
  const restored = await new BackupStore(f.storage).restore(old.id, destination);
  assert.equal(restored.directory, destination);
  assert.equal(git(destination, 'rev-parse', 'refs/heads/main'), f.head);
  assert.equal(git(destination, 'rev-parse', 'refs/custom/work-items'), f.head);
  assert.equal(git(destination, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(git(destination, 'show', 'HEAD:README.md'), 'second');
  assert.equal(git(destination, 'remote'), '');
  assert.equal(Buffer.from(await f.store.readFile(old.id, f.head, 'README.md')).toString(), 'second\n');
  await assert.rejects(f.store.readFile(next.id, f.head, 'README.md'));
});

test('empty repositories have metadata-only generations and restore with an unborn HEAD', async () => {
  const f = fixture(true);
  const snapshot = await f.store.backup(f.project);
  assert.deepEqual(snapshot.refs, {});
  assert.equal(snapshot.oid, '');
  assert.equal(snapshot.bundle, undefined);
  assert.equal(f.store.bundlePath(snapshot.id), undefined);
  assert.equal((await f.store.backup(f.project)).id, snapshot.id);
  const destination = path.join(f.directory, 'empty-restored.git');
  await f.store.restore(snapshot.id, destination);
  assert.equal(git(destination, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(git(destination, 'for-each-ref'), '');
  await assert.rejects(f.store.readFile(snapshot.id, 'a'.repeat(40), 'README.md'), /empty snapshot/);
});

test('custom refs to non-commit Git objects survive offline restoration', async () => {
  const f = fixture();
  const blob = git(f.seed, 'rev-parse', 'HEAD:README.md');
  git(f.seed, 'push', '-q', f.remote, `${blob}:refs/custom/blob`);
  const snapshot = await f.store.backup(f.project);
  assert.equal(snapshot.refs['refs/custom/blob'], blob);
  const destination = path.join(f.directory, 'custom-restored.git');
  await f.store.restore(snapshot.id, destination);
  assert.equal(git(destination, 'cat-file', '-p', 'refs/custom/blob'), 'second');
  await assert.rejects(f.store.readFile(snapshot.id, blob, 'README.md'), /must be a commit/);
});

test('a source becoming empty preserves the last populated generation', async () => {
  const f = fixture();
  const populated = await f.store.backup(f.project);
  git(f.remote, 'config', 'receive.denyDeleteCurrent', 'ignore');
  git(f.seed, 'push', '-q', f.remote, ':refs/heads/main', ':refs/custom/work-items', ':refs/tags/v1');
  const empty = await f.store.backup(f.project);
  assert.deepEqual(empty.refs, {});
  assert.equal(f.store.list().length, 2);
  assert.ok(f.store.bundlePath(populated.id));
});

test('project generations cannot be confused and identity verification happens before publication', async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(f.store.backup({ ...f.project, verifyIdentity: async () => { checks++; return false; } }), /identity changed/);
  assert.equal(checks, 1);
  assert.equal(f.store.list().length, 0);
  const first = await f.store.backup(f.project);
  await assert.rejects(f.store.backup({ ...f.project, verifyIdentity: async () => false }), /identity changed/);
  assert.equal(f.store.list().length, 1);
  const replacement = await f.store.backup({ ...f.project, id: '18', createdAt: '2026-10-31T01:00:00.000Z' });
  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.projectId, '18');
  assert.equal(f.store.list().length, 2);
});

test('storage initialization rejects unrelated directories, invalid roots, and symlink traversal', () => {
  const f = fixture(true);
  assert.throws(() => new BackupStore(path.parse(f.storage).root), /root/);
  assert.throws(() => new BackupStore('relative-storage'), /absolute/);
  assert.throws(() => new BackupStore(f.storage, { maxBytes: 0 }), /positive/);
  const unrelated = path.join(f.directory, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => new BackupStore(unrelated).initialize(), /unrelated/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  const link = path.join(f.directory, 'linked');
  fs.symlinkSync(unrelated, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => new BackupStore(path.join(link, 'backup')).initialize(), /symlink|junction/); }
  finally { fs.unlinkSync(link); }
  const marked = path.join(f.directory, 'marked');
  fs.mkdirSync(marked);
  fs.writeFileSync(path.join(marked, '.spacehub-backup.json'), JSON.stringify({ kind: 'spacehub-backup', version: 900, id: 'a'.repeat(32) }));
  assert.throws(() => new BackupStore(marked).initialize(), /unsupported version/);
});

test('project and storage quotas reject new work without deleting retained backups', async () => {
  const f = fixture();
  await assert.rejects(new BackupStore(f.storage, { maxProjectBytes: 1024 }).backup({ ...f.project, estimatedBytes: 2048 }), /project size limit/);
  const snapshot = await f.store.backup(f.project);
  const bounded = new BackupStore(f.storage, { maxBytes: snapshot.bytes + 1 });
  await assert.rejects(bounded.backup(f.project), /quota/);
  assert.equal(bounded.list().length, 1);
  await bounded.restore(snapshot.id, path.join(f.directory, 'restored-despite-quota.git'));
  const tiny = new BackupStore(path.join(f.directory, 'tiny'), { maxBytes: 1 });
  await assert.rejects(tiny.backup(f.project), /quota/);
  assert.deepEqual(tiny.list(), []);
});

test('sibling queued-work usage shares the quota before fetching and immediately before publication', async () => {
  const f = fixture();
  const retained = await f.store.backup(f.project);
  const bundleBefore = fs.readFileSync(f.store.bundlePath(retained.id)!);
  const sizeOf = (directory: string): number => fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const file = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? sizeOf(file) : fs.statSync(file).size);
  }, 0);
  const maxBytes = sizeOf(f.storage) + 1024 * 1024;
  const queue = path.join(f.directory, 'queued-work.json');
  const shared = new BackupStore(f.storage, {
    maxBytes,
    externalUsageBytes: () => fs.existsSync(queue) ? fs.statSync(queue).size : 0,
  });
  assert.equal((await shared.backup(f.project)).id, retained.id);
  fs.writeFileSync(queue, Buffer.alloc(maxBytes + 1));
  await assert.rejects(shared.backup(f.project), /quota/);
  assert.deepEqual(shared.list().map(snapshot => snapshot.id), [retained.id]);
  assert.deepEqual(fs.readFileSync(shared.bundlePath(retained.id)!), bundleBefore);
  fs.unlinkSync(queue);

  // A task queued during the final identity check must also prevent the
  // already-prepared generation from becoming a published snapshot.
  git(f.seed, 'push', '-q', '--force', f.remote, `${f.first}:refs/heads/main`);
  await assert.rejects(shared.backup({
    ...f.project,
    verifyIdentity: async () => { fs.writeFileSync(queue, Buffer.alloc(maxBytes + 1)); return true; },
  }), /quota/);
  assert.deepEqual(shared.list().map(snapshot => snapshot.id), [retained.id]);
  assert.deepEqual(fs.readFileSync(shared.bundlePath(retained.id)!), bundleBefore);
});

test('external quota usage must be a non-negative safe integer', async () => {
  const f = fixture(true);
  for (const usage of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const store = new BackupStore(f.storage, { externalUsageBytes: () => usage });
    await assert.rejects(store.backup(f.project), /non-negative safe integer/);
    assert.deepEqual(store.list(), []);
  }
});

test('malformed identifiers, paths and credential-bearing URLs never reach filesystem destinations', async () => {
  const f = fixture();
  const snapshot = await f.store.backup(f.project);
  await assert.rejects(f.store.backup({ ...f.project, fullName: 'quirq/../escape' }), /metadata/);
  await assert.rejects(f.store.backup({ ...f.project, sourceUrl: 'https://user:secret@example.com/repo' }), /credentials/);
  await assert.rejects(f.store.backup({ ...f.project, sourceUrl: 'https://example.com/repo?token=secret' }), /credentials/);
  assert.throws(() => f.store.bundlePath('../escape'), /snapshot ID/);
  for (const invalid of ['../README.md', '/README.md', 'channels//x', 'channels/./x', 'channels\\x', 'README.md\0']) {
    await assert.rejects(f.store.readFile(snapshot.id, f.head, invalid), /file path/);
  }
  await assert.rejects(f.store.readFile(snapshot.id, '--all', 'README.md'), /object ID/);
  await assert.rejects(f.store.readFile(snapshot.id, f.head, 'channels'), /not a file/);
  await assert.rejects(f.store.readFile(snapshot.id, f.head, 'README.md', 2), /size limit/);
  await assert.rejects(f.store.restore(snapshot.id, f.remote), /already exists/);
  await assert.rejects(f.store.restore(snapshot.id, path.join(f.storage, 'restore.git')), /outside backup storage/);
});

test('damaged bundles and malformed catalog entries are rejected rather than served', async () => {
  const f = fixture();
  const snapshot = await f.store.backup(f.project);
  const bundle = f.store.bundlePath(snapshot.id)!;
  const contents = fs.readFileSync(bundle);
  contents[contents.length - 1] ^= 0xff;
  fs.writeFileSync(bundle, contents);
  assert.throws(() => f.store.bundlePath(snapshot.id), /checksum mismatch/);
  assert.deepEqual(f.store.list(), []);
  await assert.rejects(f.store.restore(snapshot.id, path.join(f.directory, 'damaged.git')), /checksum mismatch/);
  const repaired = await f.store.backup(f.project);
  assert.notEqual(repaired.id, snapshot.id);
  assert.ok(f.store.bundlePath(repaired.id));
  const invalid = path.join(f.storage, 'snapshots', 'a'.repeat(32));
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'manifest.json'), JSON.stringify({ id: '../bad', token: 'not-returned' }));
  assert.ok(!JSON.stringify(f.store.list()).includes('not-returned'));
});

test('a writer lock prevents another process from mutating the same store', async () => {
  const f = fixture();
  f.store.initialize();
  const lock = path.join(f.storage, '.writer.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(f.store.backup(f.project), /writer lock/);
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock);
  await f.store.backup(f.project);
  assert.ok(!fs.existsSync(lock));
});
