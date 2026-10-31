import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSubhubServer, NodeWorkSpool, type NodeBackupSnapshot } from '../src/subhubserver.ts';

const TOKEN = 'a-private-node-token';
const SNAPSHOT = 'a'.repeat(32);
const OID = 'b'.repeat(40);
const WHERE = { id: 'work-1', space: 'quirq', project: 'quirq/project', text: 'Store this work. Do not run it.', status: 'queued' };
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'subhub-server-'));
function removeTemporary(dir: string) {
  const target = path.resolve(dir);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('subhub-server-')) throw new Error('Refusing to remove a path outside this test\'s temporary directory.');
  fs.rmSync(target, { recursive: true, force: true });
}

async function setup(options: { availableBytes?: () => number } = {}) {
  const storageDir = temporary();
  const manifests: NodeBackupSnapshot[] = [
    { id: SNAPSHOT, project: 'quirq/project', oid: OID, refs: { 'refs/heads/main': OID } },
    { id: 'c'.repeat(32), project: 'other/private', oid: OID },
  ];
  const reads: unknown[][] = [];
  const bundleDir = path.join(storageDir, 'backup', 'snapshots', SNAPSHOT);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'repository.bundle'), 'a known backup bundle');
  let body = Buffer.from('backed-up file');
  let bundle: string | undefined = path.join(bundleDir, 'repository.bundle');
  const backup = {
    list: (project?: string) => manifests.filter(manifest => !project || manifest.project === project),
    readFile: async (...args: [string, string, string, number]) => { reads.push(args); return body; },
    bundlePath: () => bundle,
  };
  const server = createSubhubServer({ nodeId: 'node-1', space: 'quirq', token: TOKEN, storageDir, backup, ...options });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = async (route: string, options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(base + route, {
      method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${options.token ?? TOKEN}`, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });
    return response;
  };
  const file = (extra: Record<string, string> = {}) => '/v1/file?' + new URLSearchParams({ project: 'quirq/project', snapshot: SNAPSHOT, oid: OID, path: 'nested/README.md', ...extra });
  const close = () => { server.close(); server.closeAllConnections(); removeTemporary(storageDir); };
  return { storageDir, server, base, ask, reads, file, manifests, close, setBody: (value: Buffer) => { body = value; }, setBundle: (value: string | undefined) => { bundle = value; } };
}

test('health is minimal and every v1 endpoint requires the node bearer token', async t => {
  const f = await setup(); t.after(f.close);
  const health = await fetch(f.base + '/healthz');
  assert.deepEqual(await health.json(), { ok: true, nodeId: 'node-1', version: 1 });
  for (const route of ['/v1/snapshots', '/v1/work', f.file(), '/v1/unknown']) {
    assert.equal((await fetch(f.base + route)).status, 401, route);
    assert.equal((await f.ask(route, { token: 'incorrect' })).status, 401, route);
  }
  assert.equal((await fetch(f.base + '/v1/work', { headers: { cookie: `spacehub_session=${TOKEN}` } })).status, 401);
  assert.equal(f.reads.length, 0);
});

test('snapshot catalog stays within the configured space', async t => {
  const f = await setup(); t.after(f.close);
  assert.deepEqual(await (await f.ask('/v1/snapshots')).json(), { snapshots: [f.manifests[0]] });
  assert.deepEqual(await (await f.ask('/v1/snapshots?project=quirq/project')).json(), { snapshots: [f.manifests[0]] });
  assert.equal((await f.ask('/v1/snapshots?project=other/private')).status, 403);
  assert.equal((await f.ask('/v1/snapshots?project=quirq/project&project=other/private')).status, 400);
});

test('GET and HEAD read only the named snapshot and commit without redirects or cookies', async t => {
  const f = await setup(); t.after(f.close);
  const response = await f.ask(f.file());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'backed-up file');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('x-spacehub-oid'), OID);
  assert.equal(response.headers.get('x-spacehub-snapshot'), SNAPSHOT);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('location'), null);
  const head = await f.ask(f.file(), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('backed-up file')));
  assert.deepEqual(f.reads, [[SNAPSHOT, OID, 'nested/README.md', 8 * 1024 * 1024], [SNAPSHOT, OID, 'nested/README.md', 8 * 1024 * 1024]]);
});

test('file API refuses traversal, wrong projects, unlisted commits and oversized responses before serving data', async t => {
  const f = await setup(); t.after(f.close);
  for (const filename of ['../secret', '/absolute', 'a/../secret', 'C:\\secret', 'a\\b', 'a\0b', 'a//b', './README.md']) {
    assert.equal((await f.ask(f.file({ path: filename }))).status, 400, filename);
  }
  assert.equal((await f.ask(f.file({ project: 'other/private' }))).status, 403);
  assert.equal((await f.ask(f.file({ project: 'quirq/another' }))).status, 404);
  assert.equal((await f.ask(f.file({ oid: 'd'.repeat(40) }))).status, 404);
  assert.equal((await f.ask(f.file({ snapshot: 'd'.repeat(32) }))).status, 404);
  assert.equal((await f.ask(f.file({ snapshot: '../private' }))).status, 400);
  assert.equal((await f.ask(f.file() + '&path=another')).status, 400);
  assert.equal(f.reads.length, 0);
  f.setBody(Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal((await f.ask(f.file())).status, 413);
});

test('bundle reads stream only a known regular bundle inside node storage', async t => {
  const f = await setup(); t.after(f.close);
  const route = `/v1/snapshots/${SNAPSHOT}/bundle`;
  const response = await f.ask(route);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'a known backup bundle');
  const head = await f.ask(route, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await f.ask('/v1/snapshots/' + 'd'.repeat(32) + '/bundle')).status, 404);
  f.setBundle(path.join(os.tmpdir(), 'repository.bundle'));
  assert.equal((await f.ask(route)).status, 409);
  f.setBundle(undefined);
  assert.equal((await f.ask(route)).status, 404);
});

test('an explicit backup root permits known bundles beside the dedicated work spool', async t => {
  const root = temporary();
  const backupRoot = path.join(root, 'backup');
  const bundleDir = path.join(backupRoot, 'snapshots', SNAPSHOT);
  fs.mkdirSync(bundleDir, { recursive: true });
  const filename = path.join(bundleDir, 'repository.bundle');
  fs.writeFileSync(filename, 'sibling backup');
  const server = createSubhubServer({ nodeId: 'node-1', space: 'quirq', token: TOKEN, storageDir: path.join(root, 'spool'), backupRoot, backup: {
    list: () => [{ id: SNAPSHOT, project: 'quirq/project', oid: OID }],
    readFile: async () => Buffer.alloc(0),
    bundlePath: () => filename,
  } });
  t.after(() => { server.close(); server.closeAllConnections(); removeTemporary(root); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/snapshots/${SNAPSHOT}/bundle`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'sibling backup');
});

test('PUT persists work before acknowledging and is idempotent across new spool instances', async t => {
  const f = await setup(); t.after(f.close);
  const response = await f.ask('/v1/work/work-1', { method: 'PUT', body: WHERE });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, work: WHERE });
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), [WHERE]);
  const duplicate = { status: WHERE.status, text: WHERE.text, project: WHERE.project, space: WHERE.space, id: WHERE.id };
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: duplicate })).status, 200);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, text: 'different' } })).status, 409);
  assert.deepEqual(await (await f.ask('/v1/work')).json(), { work: [WHERE] });
  assert.deepEqual(await (await f.ask('/v1/work/work-1')).json(), { work: WHERE });
});

test('work quota covers durable record overhead and keeps existing deliveries idempotent at zero capacity', async t => {
  let available = 1024;
  const f = await setup({ availableBytes: () => available }); t.after(f.close);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: WHERE })).status, 507);
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), []);
  available = 4096;
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: WHERE })).status, 200);
  available = 0;
  const duplicate = await f.ask('/v1/work/work-1', { method: 'PUT', body: { text: WHERE.text, id: WHERE.id, space: WHERE.space, status: WHERE.status, project: WHERE.project } });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, work: WHERE });
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, text: 'Conflicting work' } })).status, 409);
  assert.equal((await f.ask('/v1/work/work-2', { method: 'PUT', body: { ...WHERE, id: 'work-2' } })).status, 507);
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), [WHERE]);
});

test('invalid capacity reports fail closed without writing new work', async t => {
  let available = 0;
  const f = await setup({ availableBytes: () => available }); t.after(f.close);
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    available = value;
    assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: WHERE })).status, 503, String(value));
  }
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), []);
});

test('work accepts only the node scope, matching safe IDs and bounded JSON from machine callers', async t => {
  const f = await setup(); t.after(f.close);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: WHERE, headers: { origin: f.base } })).status, 403);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, space: 'other', project: 'other/project' } })).status, 403);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, nodeId: 'node-2' } })).status, 403);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, id: '../outside' } })).status, 400);
  assert.equal((await f.ask('/v1/work/..%2Foutside', { method: 'PUT', body: WHERE })).status, 400);
  assert.equal((await f.ask('/v1/work/' + 'a'.repeat(129), { method: 'PUT', body: WHERE })).status, 400);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: { ...WHERE, text: 'x'.repeat(256 * 1024) } })).status, 413);
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), []);
});

test('spool ignores abandoned temporary files and never follows a symlinked record or directory', t => {
  const storageDir = temporary();
  t.after(() => removeTemporary(storageDir));
  const spool = new NodeWorkSpool(storageDir);
  spool.put(WHERE);
  fs.writeFileSync(path.join(spool.dir, '.pending-interrupted'), '{unfinished');
  assert.deepEqual(new NodeWorkSpool(storageDir).list(), [WHERE]);
  assert.throws(() => spool.put({ ...WHERE, project: 'other/project' }), /project in its space/);
  assert.throws(() => spool.put({ ...WHERE, id: '../escaped' }), /safe ID/);
  const elsewhere = path.join(storageDir, 'unrelated');
  fs.mkdirSync(elsewhere);
  const link = path.join(storageDir, 'linked');
  fs.symlinkSync(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new NodeWorkSpool(link), /ordinary directories/);
  // Directory symlinks are available without elevated rights on Windows too.
  fs.symlinkSync(elsewhere, path.join(spool.dir, 'linked-record.json'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => spool.get('linked-record'), /regular file/);
});

test('queue-only API exposes no claim, run or execution route and stores commands as inert text', async t => {
  const f = await setup(); t.after(f.close);
  const marker = path.join(f.storageDir, 'must-not-exist');
  const item = { ...WHERE, text: `node -e require('fs').writeFileSync(${JSON.stringify(marker)},'executed')` };
  assert.equal((await f.ask('/v1/work/work-1', { method: 'PUT', body: item })).status, 200);
  for (const action of ['claim', 'run', 'execute']) assert.equal((await f.ask(`/v1/work/work-1/${action}`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.ask('/v1/work/work-1', { method: 'DELETE' })).status, 405);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), [item]);
});

test('streamed oversized requests are rejected without a queued partial record', async t => {
  const f = await setup(); t.after(f.close);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(f.base + '/v1/work/work-1', { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode!); });
    req.on('error', reject);
    req.write('{"id":"work-1","text":"');
    req.write('x'.repeat(256 * 1024));
    req.end('"}');
  });
  assert.equal(status, 413);
  assert.deepEqual(new NodeWorkSpool(f.storageDir).list(), []);
});
