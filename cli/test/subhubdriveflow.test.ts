import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SubhubStore } from '../src/subhubstore.ts';
import { DriveStore } from '../src/subhubdrive.ts';
import { createSubhubServer } from '../src/subhubserver.ts';
import { handleSubhubControl } from '../src/subhubcontrol.ts';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subhub-drive-flow-'));
  const store = new SubhubStore(path.join(root, 'parent'));
  const drive = new DriveStore(path.join(root, 'node', 'drive'), { availableBytes: () => 64 * 1024 * 1024 });
  drive.initialize();
  const node = http.createServer();
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  const registered = store.register({ id: 'local-drive', space: 'quirq', url: nodeUrl, capacityBytes: 128 * 1024 * 1024, mode: 'drive' }, 'owner');
  let mode: 'backup' | 'drive' = 'drive';
  const received: http.IncomingHttpHeaders[] = [];
  const handler = createSubhubServer({ nodeId: 'local-drive', space: 'quirq', token: registered.token, storageDir: path.join(root, 'node', 'work'),
    backup: { list: () => [], readFile: async () => new Uint8Array(), bundlePath: () => undefined }, drive, mode: () => mode });
  node.on('request', (req, res) => { received.push(req.headers); handler.emit('request', req, res); });
  store.heartbeat('local-drive', registered.token, { freeBytes: 64 * 1024 * 1024, backups: [], drive: drive.stats() });
  store.register({ id: 'private-node', space: 'private', capacityBytes: 100_000 }, 'other');
  const parent = http.createServer((req, res) => {
    void handleSubhubControl(store, {
      authorize: async (request, space, owner) => {
        if (request.headers.origin && request.headers.origin !== 'http://trusted.local') return null;
        const actor = request.headers.authorization?.replace('Bearer ', '') ?? /viewer=(owner|member)/.exec(request.headers.cookie ?? '')?.[1];
        return space === 'quirq' && (actor === 'owner' || (!owner && actor === 'member')) ? actor : null;
      },
      currentHead: async () => null,
      localRead: async () => { throw new Error('Active drive requests must not reach parent Git storage'); },
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(resolve => parent.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(parent.address() as AddressInfo).port}/-/api/subhubs`;
  const file = base + '/drive/file?' + new URLSearchParams({ space: 'quirq', node: 'local-drive', path: 'documents/hello.txt' });
  const ask = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { cookie: 'viewer=member; private-cookie=never-forward', ...Object.fromEntries(new Headers(init.headers)) } });
  return { root, store, drive, registered, received, base, file, ask, mode: (value: 'backup' | 'drive') => { mode = value; }, close: async () => {
    for (const server of [node, parent]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('browser gateway stores drive bytes on the node, reads them with integrity checks, and preserves version conflicts', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('Stored on the connected machine.');
    const upload = await f.ask(f.file, { method: 'PUT', body: bytes, headers: { 'if-none-match': '*' } });
    assert.equal(upload.status, 200);
    const saved = (await upload.json()).file;
    assert.equal(saved.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(f.drive.read('documents/hello.txt').data, bytes);
    const download = await f.ask(f.file);
    assert.equal(download.headers.get('x-spacehub-source'), 'local-drive');
    assert.equal(download.headers.get('etag'), `"${saved.sha256}"`);
    assert.equal(await download.text(), bytes.toString());
    const head = await f.ask(f.file, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal(await head.text(), '');
    const list = await f.ask(f.base + '/drive/files?space=quirq&node=local-drive');
    assert.equal((await list.json()).files[0].path, 'documents/hello.txt');
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'conflict', headers: { 'if-none-match': '*' } })).status, 412);
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'conflict', headers: { 'if-match': 'a'.repeat(64) } })).status, 412);
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'updated', headers: { 'if-match': saved.sha256 } })).status, 200);
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'no version' })).status, 428);
    assert.ok(f.received.every(headers => headers.cookie === undefined && headers.authorization === `Bearer ${f.registered.token}`));
    const metadata = JSON.stringify(f.store.nodes('quirq'));
    assert.equal(metadata.includes(bytes.toString()), false);
    assert.equal(metadata.includes(f.registered.token), false);
  } finally { await f.close(); }
});

test('UI listings are membership-filtered, settings require ownership, and disabled/offline drives fail explicitly', async () => {
  const f = await fixture();
  try {
    const aggregate = await f.ask(f.base + '/nodes');
    assert.deepEqual((await aggregate.json()).nodes.map((node: any) => node.id), ['local-drive']);
    assert.deepEqual((await (await fetch(f.base + '/nodes')).json()).nodes, []);
    assert.equal((await f.ask(f.base + '/activity')).status, 200);
    const settings = f.base + '/nodes/local-drive';
    const change = (token: string, value: unknown) => f.ask(settings, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await change('member', { space: 'quirq', enabled: false })).status, 403);
    assert.equal((await change('owner', { space: 'quirq', enabled: false })).status, 200);
    assert.equal((await f.ask(f.file)).status, 409);
    assert.equal((await change('owner', { space: 'quirq', enabled: true })).status, 200);
    f.mode('backup');
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'wrong mode', headers: { 'if-none-match': '*' } })).status, 409);
    f.mode('drive');
    assert.equal((await f.ask(f.file, { method: 'PUT', body: 'cross-site', headers: { 'if-none-match': '*', origin: 'https://evil.example' } })).status, 403);
    assert.equal((await f.ask(f.file.replace('quirq', 'private'))).status, 403);
    assert.equal((await f.ask(f.file.replace('documents%2Fhello.txt', '..%2Fsecret'))).status, 400);
    const events = (await (await f.ask(f.base + '/activity')).json()).activity;
    assert.ok(events.length > 0 && events.every((event: any) => event.space === 'quirq'));
  } finally { await f.close(); }
});
