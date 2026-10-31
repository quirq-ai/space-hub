import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriveStore, DRIVE_MAX_FILE_BYTES } from '../src/subhubdrive.ts';

function setup(t: { after(fn: () => void): void }, availableBytes?: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subhub-drive-'));
  t.after(() => {
    const checked = path.resolve(root);
    if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('subhub-drive-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(checked, { recursive: true, force: true });
  });
  const storage = path.join(root, 'drive');
  return { root, storage, drive: new DriveStore(storage, { availableBytes }) };
}
const status = (expected: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === expected;

test('drive files, version metadata and stats survive a new store instance', t => {
  const f = setup(t);
  assert.deepEqual(f.drive.stats(), { files: 0, bytes: 0, updatedAt: null });
  const data = Buffer.from('A shared team document.');
  const file = f.drive.write('docs/plan.txt', data, null);
  assert.equal(file.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(file.size, data.length);
  assert.equal(typeof file.updatedAt, 'number');
  const reopened = new DriveStore(f.storage);
  assert.deepEqual(reopened.read(file.path), { metadata: file, data });
  assert.deepEqual(reopened.list('docs/'), [file]);
  assert.deepEqual(reopened.list('elsewhere/'), []);
  assert.deepEqual(reopened.stats(), { files: 1, bytes: data.length, updatedAt: file.updatedAt });
});

test('create-only and stale CAS writes preserve the original; successful replacement retains its old blob', t => {
  const { drive, storage } = setup(t);
  const first = drive.write('note.txt', Buffer.from('first'), null);
  assert.throws(() => drive.write('note.txt', Buffer.from('second'), null), status(412));
  assert.throws(() => drive.write('note.txt', Buffer.from('second'), '0'.repeat(64)), status(412));
  assert.equal(drive.read('note.txt').data.toString(), 'first');
  const next = drive.write('note.txt', Buffer.from('second'), first.sha256);
  assert.notEqual(next.sha256, first.sha256);
  assert.ok(next.updatedAt > first.updatedAt);
  assert.equal(drive.read('note.txt').data.toString(), 'second');
  assert.equal(fs.readFileSync(path.join(storage, 'blobs', first.sha256), 'utf8'), 'first');
  assert.throws(() => drive.write('missing.txt', Buffer.alloc(0), first.sha256), status(412));
});

test('quota includes immutable bytes and index publication overhead, preserving data on refusal', t => {
  let available = 4096;
  const { drive, storage } = setup(t, () => available);
  assert.throws(() => drive.write('note.txt', Buffer.from('small'), null), status(507));
  assert.equal(fs.readdirSync(path.join(storage, 'blobs')).length, 0);
  available = 16 * 1024;
  const first = drive.write('note.txt', Buffer.from('small'), null);
  available = 0;
  assert.deepEqual(drive.write('note.txt', Buffer.from('small'), first.sha256), first);
  assert.throws(() => drive.write('note.txt', Buffer.from('replacement'), first.sha256), status(507));
  assert.deepEqual(drive.read('note.txt').metadata, first);
  assert.equal(drive.read('note.txt').data.toString(), 'small');
  assert.equal(fs.readdirSync(path.join(storage, 'blobs')).length, 1);
  for (const invalid of [-1, Infinity, NaN, 1.5]) {
    available = invalid;
    assert.throws(() => drive.write('new.txt', Buffer.from('new'), null), status(503));
  }
});

test('unsafe paths, oversized files and file/folder collisions are rejected', t => {
  const { drive } = setup(t);
  for (const filename of ['', '../outside', '/absolute', 'a/../b', 'C:\\outside', 'a\\b', 'a//b', './x', 'a\0b', 'a\nb']) {
    assert.throws(() => drive.write(filename, Buffer.from('x'), null), status(400), filename);
    assert.throws(() => drive.read(filename), status(400), filename);
  }
  assert.throws(() => drive.write('large', Buffer.alloc(DRIVE_MAX_FILE_BYTES + 1), null), status(413));
  drive.write('docs/readme', Buffer.from('hello'), null);
  assert.throws(() => drive.write('docs', Buffer.from('collision'), null), status(409));
  drive.write('plain-file', Buffer.alloc(0), null);
  assert.throws(() => drive.write('plain-file/nested', Buffer.alloc(0), null), status(409));
  const special = drive.write('__proto__', Buffer.from('safe virtual filename'), null);
  assert.equal(drive.read('__proto__').metadata.sha256, special.sha256);
});

test('corrupted blob content fails checksum validation instead of serving different bytes', t => {
  const { drive, storage } = setup(t);
  const file = drive.write('a.txt', Buffer.from('first'), null);
  fs.writeFileSync(path.join(storage, 'blobs', file.sha256), 'other');
  assert.throws(() => drive.read('a.txt'), status(409));
  assert.throws(() => drive.write('a.txt', Buffer.from('first'), file.sha256), status(409));
});

test('drive refuses unrelated storage, symlinked directories and symlinked content', t => {
  const { root, storage, drive } = setup(t);
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => new DriveStore(unrelated), status(409));
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  const linked = path.join(root, 'linked');
  fs.symlinkSync(unrelated, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new DriveStore(linked), status(409));
  const file = drive.write('a.txt', Buffer.from('abc'), null);
  const blob = path.join(storage, 'blobs', file.sha256);
  fs.unlinkSync(blob);
  fs.symlinkSync(unrelated, blob, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => drive.read('a.txt'), status(409));
});

test('existing writer locks and damaged indexes fail closed without overwriting retained data', t => {
  const { drive, storage } = setup(t);
  const file = drive.write('a.txt', Buffer.from('retained'), null);
  fs.writeFileSync(path.join(storage, '.writer.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => drive.write('b.txt', Buffer.from('new'), null), status(409));
  assert.equal(drive.read('a.txt').data.toString(), 'retained');
  fs.unlinkSync(path.join(storage, '.writer.lock'));
  fs.writeFileSync(path.join(storage, 'index.json'), '{broken');
  assert.throws(() => new DriveStore(storage), status(409));
  assert.equal(fs.readFileSync(path.join(storage, 'blobs', file.sha256), 'utf8'), 'retained');
});
