import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubhubStore, SubhubError, NODE_STALE_MS, nodeId, nodeUrl } from '../src/subhubstore.ts';

const OID = 'a'.repeat(40);
const SNAPSHOT = 'b'.repeat(32);
const INPUT = { space: 'quirq', project: 'quirq/space-hub', title: 'Keep the issue', text: 'Useful work remains here when every node is offline.', idempotencyKey: 'work-key-123' };
const NODE = { id: 'laptop', space: 'quirq', url: 'https://node.example', capacityBytes: 100_000 };
const backup = (project = INPUT.project, oid = OID, size = 1000) => ({ project, oid, snapshot: SNAPSHOT, bytes: size });
const status = (expected: number) => (error: unknown) => error instanceof SubhubError && error.status === expected;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-subhub-test-'));
  let time = 1_000_000;
  let store = new SubhubStore(dir, () => time);
  return {
    dir, get store() { return store; }, now: () => time, advance: (ms: number) => { time += ms; },
    reopen() { store.close(); store = new SubhubStore(dir, () => time); return store; },
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('registration is durable and retryable, with sanitized listings and independent node credentials', () => {
  const f = fixture();
  try {
    const first = f.store.register(NODE, 'alice');
    assert.ok(first.token.length >= 40);
    assert.equal(first.node.healthy, false);
    assert.equal(f.store.authenticateNode('laptop', 'wrong'), null);
    assert.equal(f.store.authenticateNode('missing', first.token), null);
    assert.equal(f.store.authenticateNode('laptop', first.token)?.id, 'laptop');
    assert.deepEqual(f.store.register(NODE, 'alice'), first);
    assert.throws(() => f.store.register(NODE, 'bob'), status(409));
    assert.throws(() => f.store.register({ ...NODE, space: 'another' }, 'alice'), status(409));
    assert.throws(() => f.store.register({ ...NODE, capacityBytes: 200_000 }, 'alice'), status(409));
    assert.throws(() => f.store.register({ ...NODE, url: 'https://changed.example' }, 'alice'), status(409));
    const second = f.store.register({ ...NODE, id: 'desktop' }, 'alice');
    assert.notEqual(first.token, second.token);
    assert.equal(f.store.authenticateNode('desktop', first.token), null);
    const listed = f.store.nodes('quirq');
    assert.equal(JSON.stringify(listed).includes(first.token), false);
    assert.equal('token' in listed[0], false);
    listed[0].backups.push(backup());
    assert.equal(f.store.nodes('quirq')[0].backups.length, 0);
    f.reopen();
    assert.equal(f.store.register(NODE, 'alice').token, first.token);
    assert.equal(f.store.nodeToken('laptop'), first.token);
    assert.equal(f.store.nodeToken('missing'), null);
    const mode = fs.statSync(path.join(f.dir, 'state.json')).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
  } finally { f.close(); }
});

test('one store writer owns a dedicated directory and close releases its lock', () => {
  const f = fixture();
  try {
    assert.throws(() => new SubhubStore(f.dir), status(409));
    const previous = f.store;
    f.reopen();
    assert.throws(() => previous.nodes('quirq'), status(503));
    assert.throws(() => previous.assignments('laptop', 'wrong'), status(503));
    assert.ok(fs.existsSync(path.join(f.dir, '.writer.lock')));
  } finally { f.close(); }
});

test('storage refuses unrelated directories, malformed state and symlink roots', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-subhub-path-'));
  try {
    const unrelated = path.join(parent, 'unrelated');
    fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'important.txt'), 'keep');
    assert.throws(() => new SubhubStore(unrelated), status(400));
    assert.equal(fs.readFileSync(path.join(unrelated, 'important.txt'), 'utf8'), 'keep');
    const source = path.join(parent, 'source'), link = path.join(parent, 'linked');
    fs.mkdirSync(source);
    try { fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) t.diagnostic('symlink permission unavailable');
      else throw error;
    }
    if (fs.existsSync(link)) assert.throws(() => new SubhubStore(link), status(400));
    const broken = path.join(parent, 'broken');
    const store = new SubhubStore(broken); store.close();
    fs.writeFileSync(path.join(broken, 'state.json'), '{broken');
    assert.throws(() => new SubhubStore(broken), SyntaxError);
    assert.equal(fs.existsSync(path.join(broken, '.writer.lock')), false);
    assert.equal(fs.readFileSync(path.join(broken, 'state.json'), 'utf8'), '{broken');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('node identifiers, URLs and capacity are validated without accepting credential-bearing URLs', () => {
  assert.equal(nodeId('node-1_dev'), 'node-1_dev');
  for (const id of ['../a', 'Upper', '', '__proto__', 'a/b']) assert.throws(() => nodeId(id), status(400));
  assert.equal(nodeUrl('https://node.example/base/'), 'https://node.example/base');
  assert.equal(nodeUrl('http://127.0.0.1:3003'), 'http://127.0.0.1:3003');
  assert.equal(nodeUrl(undefined), undefined);
  for (const url of ['http://node.example', 'https://user:pass@node.example', 'https://node.example/?token=secret', 'https://node.example/#fragment', 'file:///tmp/x']) assert.throws(() => nodeUrl(url), status(400));
  const f = fixture();
  try {
    for (const capacityBytes of [-1, 0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.store.register({ ...NODE, capacityBytes }, 'alice'), status(400));
    assert.equal(f.store.nodes('quirq').length, 0);
  } finally { f.close(); }
});

test('heartbeat authenticates, validates backups against scope/capacity, and reports central time', () => {
  const f = fixture();
  try {
    const { token } = f.store.register(NODE, 'alice');
    assert.throws(() => f.store.heartbeat('laptop', 'wrong', { freeBytes: 10, backups: [] }), status(401));
    assert.throws(() => f.store.heartbeat('laptop', token, { freeBytes: 100_001, backups: [] }), status(400));
    assert.throws(() => f.store.heartbeat('laptop', token, { freeBytes: 0, backups: [backup('another/project')] }), status(400));
    assert.throws(() => f.store.heartbeat('laptop', token, { freeBytes: 0, backups: [backup(INPUT.project, OID, 100_001)] }), status(400));
    assert.throws(() => f.store.heartbeat('laptop', token, { freeBytes: 0, backups: [backup(), backup()] }), status(400));
    assert.throws(() => f.store.heartbeat('laptop', token, { freeBytes: 0, backups: [{ ...backup(), snapshot: '../secret' }] }), status(400));
    assert.equal(f.store.nodes('quirq')[0].seenAt, null);
    const beat = f.store.heartbeat('laptop', token, { freeBytes: 99_000, backups: [backup()] });
    assert.equal(beat.serverTime, f.now());
    assert.equal(beat.node.healthy, true);
    f.advance(NODE_STALE_MS);
    assert.equal(f.store.nodes('quirq')[0].healthy, false);
    f.reopen();
    assert.equal(f.store.nodes('quirq')[0].backups.length, 1);
  } finally { f.close(); }
});

test('work survives every node going offline, restart and idempotent enqueue retries', () => {
  const f = fixture();
  try {
    const item = f.store.enqueue(INPUT, 'alice');
    assert.equal(item.status, 'queued');
    assert.equal(item.project, INPUT.project);
    assert.equal(item.assignedNode, null);
    assert.deepEqual(f.store.enqueue({ ...INPUT, project: 'space-hub' }, 'alice'), item);
    assert.throws(() => f.store.enqueue({ ...INPUT, text: 'Different task' }, 'alice'), status(409));
    assert.throws(() => f.store.enqueue({ ...INPUT, project: 'elsewhere/project' }, 'alice'), status(400));
    item.text = 'caller mutation';
    f.reopen();
    assert.equal(f.store.work(item.id)?.text, INPUT.text);
    assert.equal(f.store.listWork('quirq').length, 1);
    assert.equal(f.store.work('missing'), null);
    assert.equal(f.store.listWork('another').length, 0);
    assert.equal(f.store.enqueue(INPUT, 'bob').actor, 'bob');
  } finally { f.close(); }
});

test('healthy in-scope nodes receive durable work acknowledgements and stale assignments move', () => {
  const f = fixture();
  try {
    const a = f.store.register(NODE, 'alice');
    const b = f.store.register({ ...NODE, id: 'backup' }, 'alice');
    const stranger = f.store.register({ ...NODE, id: 'outside', space: 'another' }, 'bob');
    const work = f.store.enqueue(INPUT, 'alice');
    assert.deepEqual(f.store.assignments('laptop', a.token), []);
    f.store.heartbeat('laptop', a.token, { freeBytes: 90_000, backups: [] });
    f.store.heartbeat('outside', stranger.token, { freeBytes: 100_000, backups: [] });
    assert.deepEqual(f.store.assignments('outside', stranger.token), []);
    assert.equal(f.store.assignments('laptop', a.token)[0].id, work.id);
    assert.throws(() => f.store.receipt('backup', b.token, [work.id]), status(409));
    const received = f.store.receipt('laptop', a.token, [work.id])[0];
    assert.equal(received.status, 'queued');
    assert.equal(received.receivedAt, f.now());
    f.reopen();
    assert.equal(f.store.work(work.id)?.receivedAt, f.now());
    f.advance(NODE_STALE_MS);
    f.store.heartbeat('backup', b.token, { freeBytes: 90_000, backups: [] });
    assert.equal(f.store.assignments('backup', b.token)[0].id, work.id);
    assert.equal(f.store.work(work.id)?.receivedAt, null);
    assert.throws(() => f.store.receipt('laptop', a.token, [work.id]), status(409));
    assert.equal(f.store.work(work.id)?.text, INPUT.text);
  } finally { f.close(); }
});

test('assignment storage respects aggregate free capacity and never reassigns claimed work', () => {
  const f = fixture();
  try {
    const a = f.store.register(NODE, 'alice');
    const b = f.store.register({ ...NODE, id: 'backup' }, 'alice');
    const first = f.store.enqueue(INPUT, 'alice');
    f.store.enqueue({ ...INPUT, idempotencyKey: 'second-work-123' }, 'alice');
    f.store.heartbeat('laptop', a.token, { freeBytes: 1500, backups: [] });
    const assigned = f.store.assignments('laptop', a.token);
    assert.equal(assigned.length, 1);
    f.store.claim(first.id, 'jobs');
    f.advance(NODE_STALE_MS);
    f.store.heartbeat('backup', b.token, { freeBytes: 90_000, backups: [] });
    assert.equal(f.store.assignments('backup', b.token).some(item => item.id === first.id), false);
    assert.equal(f.store.work(first.id)?.status, 'claimed');
  } finally { f.close(); }
});

test('claims are exclusive, expire on the exact boundary, and fence stale completion and release', async () => {
  const f = fixture();
  try {
    const item = f.store.enqueue(INPUT, 'alice');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.store.claim(item.id, 'jobs', 2)),
      Promise.resolve().then(() => f.store.claim(item.id, 'gates', 2)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.store.work(item.id)?.fence, 1);
    f.advance(2000);
    assert.throws(() => f.store.complete(item.id, 'jobs', 1, 'too late'), status(409));
    assert.throws(() => f.store.release(item.id, 'jobs', 1), status(409));
    const reclaimed = f.store.claim(item.id, 'gates', 1);
    assert.equal(reclaimed.fence, 2);
    assert.throws(() => f.store.complete(item.id, 'jobs', 1, 'stale'), status(409));
    assert.throws(() => f.store.complete(item.id, 'jobs', 2, 'wrong worker'), status(409));
    assert.equal(f.store.complete(item.id, 'gates', 2, 'Finished centrally.').status, 'completed');
    assert.throws(() => f.store.claim(item.id, 'jobs'), status(409));
    f.reopen();
    assert.equal(f.store.work(item.id)?.result, 'Finished centrally.');
  } finally { f.close(); }
});

test('valid release preserves payload and increments fencing on the next claim', () => {
  const f = fixture();
  try {
    const item = f.store.enqueue(INPUT, 'alice');
    for (const duration of [0, -1, 301, 1.5]) assert.throws(() => f.store.claim(item.id, 'jobs', duration), status(400));
    const claimed = f.store.claim(item.id, 'jobs', 300);
    const released = f.store.release(item.id, 'jobs', claimed.fence);
    assert.equal(released.status, 'queued');
    assert.equal(released.text, INPUT.text);
    assert.equal(released.worker, null);
    assert.throws(() => f.store.complete(item.id, 'jobs', claimed.fence, 'late'), status(409));
    assert.equal(f.store.claim(item.id, 'jobs').fence, claimed.fence + 1);
    assert.throws(() => f.store.claim('missing', 'jobs'), status(404));
  } finally { f.close(); }
});

test('routing requires an exact advertised replica on a healthy node with a URL', () => {
  const f = fixture();
  try {
    const a = f.store.register(NODE, 'alice');
    const noUrl = f.store.register({ ...NODE, id: 'offline-copy', url: undefined }, 'alice');
    f.store.heartbeat('offline-copy', noUrl.token, { freeBytes: 99_000, backups: [backup()] });
    assert.equal(f.store.route(INPUT.project, OID), null);
    f.store.heartbeat('laptop', a.token, { freeBytes: 99_000, backups: [backup()] });
    assert.deepEqual(f.store.route(INPUT.project, OID), { nodeId: 'laptop', url: NODE.url, ...backup() });
    assert.equal(JSON.stringify(f.store.route(INPUT.project, OID)).includes(a.token), false);
    assert.equal(f.store.route(INPUT.project, 'c'.repeat(40)), null);
    assert.equal(f.store.route('quirq/another', OID), null);
    f.advance(NODE_STALE_MS);
    assert.equal(f.store.route(INPUT.project, OID), null);
    f.store.heartbeat('laptop', a.token, { freeBytes: 100_000, backups: [] });
    assert.equal(f.store.route(INPUT.project, OID), null);
  } finally { f.close(); }
});
