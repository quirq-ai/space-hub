import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SubhubStore } from '../src/subhubstore.ts';
import { handleSubhubControl } from '../src/subhubcontrol.ts';
import { NodeWorkSpool, createSubhubServer } from '../src/subhubserver.ts';
import { parentWeb } from '../src/subhubclient.ts';

const oid = 'a'.repeat(40), snapshotId = 'b'.repeat(32);
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subhub-control-'));
  const store = new SubhubStore(path.join(dir, 'parent'));
  const deliveries: { url: string; auth: string | undefined; cookie: string | undefined }[] = [];
  let remoteWrong = false;
  let parentHeadCancelled = false;
  const server = http.createServer(async (req, res) => {
    await handleSubhubControl(store, {
      authorize: async (request, space, owner) => {
        const name = request.headers.authorization?.replace('Bearer ', '');
        return space === 'quirq' && (name === 'owner' || (name === 'member' && !owner)) ? name : null;
      },
      currentHead: async () => oid,
      localRead: async (_project, _oid, _filename, request) => request.method === 'HEAD'
        ? new Response(new ReadableStream({ cancel() { parentHeadCancelled = true; } }), { headers: { 'content-length': '15' } })
        : request.headers.range
        ? new Response('parent', { status: 206, headers: { 'content-range': 'bytes 0-5/15', 'content-length': '6', 'accept-ranges': 'bytes' } })
        : new Response('parent fallback'),
      fetch: (async (url: URL, init: RequestInit) => {
        const headers = new Headers(init.headers);
        deliveries.push({ url: String(url), auth: headers.get('authorization') ?? undefined, cookie: headers.get('cookie') ?? undefined });
        return new Response('node data', { headers: { 'x-spacehub-oid': remoteWrong ? 'c'.repeat(40) : oid, 'x-spacehub-snapshot': snapshotId } });
      }) as typeof fetch,
    }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = async (method: string, route: string, token = 'owner', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + '/-/api/subhubs' + route, { method, headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  return { dir, store, base, ask, deliveries, headCancelled: () => parentHeadCancelled, wrong: () => { remoteWrong = true; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('HTTP lifecycle registers a node, durably spools queued work, then fences worker claims without execution', async () => {
  const f = await setup();
  let node: http.Server | undefined;
  try {
    assert.equal((await f.ask('POST', '/nodes/register', 'member', { id: 'edge_1', space: 'quirq', capacityBytes: 1_000_000 })).response.status, 403);
    const registered = await f.ask('POST', '/nodes/register', 'owner', { id: 'edge_1', space: 'quirq', capacityBytes: 1_000_000 });
    const token = registered.data.token;
    const backup = { list: () => [], readFile: async () => new Uint8Array(), bundlePath: () => undefined };
    const storageDir = path.join(f.dir, 'node');
    node = createSubhubServer({ nodeId: 'edge_1', space: 'quirq', token, storageDir, backup });
    await new Promise<void>(resolve => node!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
    await f.ask('POST', '/nodes/edge_1/heartbeat', token, { freeBytes: 900_000, backups: [] });
    const input = { space: 'quirq', project: 'quirq/quirq', title: 'Review a plan', text: 'Store this for a worker.' };
    const first = await f.ask('POST', '/work', 'member', input, { 'idempotency-key': 'request-0001' });
    const second = await f.ask('POST', '/work', 'member', input, { 'idempotency-key': 'request-0001' });
    assert.equal(first.data.work.id, second.data.work.id);
    assert.equal(first.data.work.status, 'queued');
    const assigned = await f.ask('GET', '/nodes/edge_1/work', token);
    const work = assigned.data.work[0];
    const delivered = await fetch(origin + '/v1/work/' + work.id, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(work) });
    assert.equal(delivered.status, 200);
    assert.equal(new NodeWorkSpool(storageDir).list()[0].id, work.id);
    await f.ask('POST', '/nodes/edge_1/receipt', token, { ids: [work.id] });
    const claimed = await f.ask('POST', `/work/${work.id}/claim`, 'member', { leaseSeconds: 30 });
    assert.equal(claimed.data.work.status, 'claimed');
    assert.equal((await f.ask('POST', `/work/${work.id}/claim`, 'owner', {})).response.status, 409);
    assert.equal((await f.ask('POST', `/work/${work.id}/complete`, 'member', { fence: claimed.data.work.fence - 1, result: 'stale' })).response.status, 409);
    const done = await f.ask('POST', `/work/${work.id}/complete`, 'member', { fence: claimed.data.work.fence, result: 'Reviewed manually.' });
    assert.equal(done.data.work.status, 'completed');
    assert.equal((await f.ask('GET', '/nodes', token)).response.status, 403);
    assert.equal(JSON.stringify((await f.ask('GET', '/nodes?space=quirq')).data).includes(token), false);
  } finally { if (node) { node.closeAllConnections(); await new Promise<void>(resolve => node!.close(() => resolve())); } await f.close(); }
});

test('read gateway routes only matching replicas, strips caller credentials, and falls back on wrong head', async () => {
  const f = await setup();
  try {
    const result = await f.ask('POST', '/nodes/register', 'owner', { id: 'edge-2', space: 'quirq', capacityBytes: 1_000_000, url: 'https://edge.example' });
    await f.ask('POST', '/nodes/edge-2/heartbeat', result.data.token, { freeBytes: 900_000, backups: [{ project: 'quirq/quirq', oid, snapshot: snapshotId, bytes: 1000 }] });
    const url = '/read?' + new URLSearchParams({ project: 'quirq/quirq', path: 'README.md' });
    const read = await f.ask('GET', url, 'member', undefined, { cookie: 'spacehub_session=private-builder-key' });
    assert.equal(read.data, 'node data');
    assert.equal(f.deliveries[0].cookie, undefined);
    assert.equal(f.deliveries[0].auth, `Bearer ${result.data.token}`);
    assert.equal(read.response.headers.get('set-cookie'), null);
    f.wrong();
    const fallback = await f.ask('GET', url);
    assert.equal(fallback.data, 'parent fallback');
    assert.equal(fallback.response.headers.get('x-spacehub-source'), 'parent');
    assert.equal((await f.ask('GET', '/read?project=quirq/quirq&path=../secret')).response.status, 400);
    assert.equal((await f.ask('POST', '/nodes/edge-2/heartbeat', result.data.token, {}, { origin: 'https://evil.example' })).response.status, 403);
  } finally { await f.close(); }
});

test('parent origins cannot smuggle credentials or insecure external destinations', () => {
  assert.equal(parentWeb('wss://hub.quirq.dev'), 'https://hub.quirq.dev');
  assert.equal(parentWeb('ws://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const value of ['http://remote.example', 'https://user:pass@hub.example', 'https://hub.example/path', 'file:///tmp']) assert.throws(() => parentWeb(value));
});

test('range responses retain their semantics and malformed JSON inputs do not become server errors', async () => {
  const f = await setup();
  try {
    const read = await f.ask('GET', '/read?project=quirq/quirq&path=README.md', 'member', undefined, { range: 'bytes=0-5' });
    assert.equal(read.response.status, 206);
    assert.equal(read.response.headers.get('content-range'), 'bytes 0-5/15');
    assert.equal(read.response.headers.get('accept-ranges'), 'bytes');
    assert.equal(read.data, 'parent');
    assert.equal((await f.ask('POST', '/work', 'member', null)).response.status, 400);
    assert.equal((await f.ask('POST', '/work', 'member', [])).response.status, 400);
    const unicode = await f.ask('POST', '/work', 'member', { space: 'quirq', project: 'site', title: 'Review', text: 'Hello 🌍' }, { 'idempotency-key': 'unicode-0001' });
    assert.equal(unicode.data.work.text, 'Hello 🌍');
  } finally { await f.close(); }
});

test('HEAD fallback keeps parent metadata and cancels the upstream body', async () => {
  const f = await setup();
  try {
    const head = await f.ask('HEAD', '/read?project=quirq/quirq&path=README.md');
    assert.equal(head.response.status, 200);
    assert.equal(head.response.headers.get('content-length'), '15');
    assert.equal(head.data, '');
    assert.equal(f.headCancelled(), true);
  } finally { await f.close(); }
});

test('owner-approved reverse-proxy path prefixes are preserved on replica requests', async () => {
  const f = await setup();
  try {
    const result = await f.ask('POST', '/nodes/register', 'owner', { id: 'prefix', space: 'quirq', capacityBytes: 1_000_000, url: 'https://edge.example/subhub/' });
    await f.ask('POST', '/nodes/prefix/heartbeat', result.data.token, { freeBytes: 900_000, backups: [{ project: 'quirq/quirq', oid, snapshot: snapshotId, bytes: 1000 }] });
    assert.equal((await f.ask('GET', '/read?project=quirq/quirq&path=README.md')).data, 'node data');
    assert.equal(new URL(f.deliveries[0].url).pathname, '/subhub/v1/file');
  } finally { await f.close(); }
});
