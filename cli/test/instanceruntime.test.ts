import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InstanceVault } from '../src/instancevault.ts';
import { runInstanceSubhub, type InstanceRuntimeStatus } from '../src/instanceruntime.ts';
import { InstanceConnections } from '../src/instanceconnections.ts';
import { handleInstanceRecovery } from '../src/instancerecovery.ts';

const PREFIX = '/-/api/instance-recovery';
const OPERATOR = 'private-operator-token-never-persisted';
const SECRET = 'private-entire-instance-identity-key';
function put(root: string, filename: string, bytes: string | Buffer) {
  const target = path.join(root, ...filename.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-runtime-'));
  const prepared = path.join(root, 'prepared'); fs.mkdirSync(prepared);
  put(prepared, 'deployment.json', JSON.stringify({ Env: [`SIGNING_KEY=${SECRET}`] }));
  put(prepared, 'images/runtime.tar', Buffer.alloc(64 * 1024, 0x31));
  put(prepared, 'containers/hub.tar', 'complete-writable-layer');
  put(prepared, 'volumes/private.tar', `all-orgs-chats-permissions-and-identities:${SECRET}`);
  const source = new InstanceVault(path.join(root, 'source')); source.initialize();
  const captured = await source.capture(prepared, { source: 'fixture-hub', services: ['hub'], consistency: 'stopped-containers', createdAt: 1700000000000, coverage: { data: true, runtime: true, configuration: true } });
  const manifest = await source.exportManifest(captured.id);
  const storage = path.join(root, 'replica');
  const clients = new Map<string, string>();
  const registrations: any[] = [], beats: any[] = [], requests: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const control = { available: true, empty: false, corrupt: false, badPath: false, hugeIndex: false, lostRegistration: false, slow: false, enrollmentDenied: false, machineDenied: false, files: 0 };
  const json = (res: http.ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const body = async (req: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString('utf8')); };
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://local'); requests.push({ path: url.pathname, headers: req.headers });
      const route = url.pathname.slice(PREFIX.length), bearer = req.headers.authorization;
      if (route === '/connections' && req.method === 'POST') {
        if (control.enrollmentDenied || bearer !== `Bearer ${OPERATOR}`) { json(res, 403, { error: 'operator only' }); return; }
        const input = await body(req); registrations.push(input);
        assert.match(input.id, /^[a-f0-9]{32}$/); assert.match(input.token, /^[a-f0-9]{64}$/);
        if (clients.has(input.id) && clients.get(input.id) !== input.token) { json(res, 409, {}); return; }
        clients.set(input.id, input.token);
        if (control.lostRegistration) { control.lostRegistration = false; res.destroy(); return; }
        json(res, 200, { id: input.id, token: input.token }); return;
      }
      const authorized = [...clients.values()].some(token => bearer === `Bearer ${token}`);
      if (control.machineDenied || !authorized) { json(res, 403, { error: 'machine only' }); return; }
      const heartbeat = /^\/connections\/([a-f0-9]{32})\/heartbeat$/.exec(route);
      if (heartbeat) { assert.equal(bearer, `Bearer ${clients.get(heartbeat[1])}`); beats.push(await body(req)); json(res, 200, { ok: true }); return; }
      if (route === '/source/snapshots') {
        if (!control.available) { json(res, 503, { error: 'No full-instance backup source is configured' }); return; }
        if (control.hugeIndex) { res.writeHead(200, { 'content-length': String(5 * 1024 * 1024) }); res.end('{}'); return; }
        json(res, 200, { snapshots: control.empty ? [] : source.list() }); return;
      }
      if (route === `/source/snapshots/${captured.id}/manifest`) {
        const sent = structuredClone(manifest); if (control.badPath) sent.files[0].path = '../escape';
        json(res, 200, sent); return;
      }
      if (route === `/source/snapshots/${captured.id}/file`) {
        const filename = url.searchParams.get('path');
        const file = manifest.files.find(file => file.path === filename);
        if (!file) { json(res, 404, {}); return; }
        control.files++;
        const bytes = fs.readFileSync(path.join(source.storageDir, 'snapshots', captured.id, 'payload', ...file.path.split('/')));
        if (control.corrupt && bytes.length) bytes[0] ^= 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-spacehub-sha256': file.sha256, 'x-spacehub-snapshot': captured.id });
        if (!control.slow) { res.end(bytes); return; }
        let offset = 0;
        const timer = setInterval(() => { const next = bytes.subarray(offset, offset + 8192); offset += next.length; res.write(next); if (offset >= bytes.length) { clearInterval(timer); res.end(); } }, 20);
        res.once('close', () => clearInterval(timer)); return;
      }
      json(res, 404, {});
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: 'fixture failure' }); else res.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run = (extra: Partial<Parameters<typeof runInstanceSubhub>[0]> = {}) => runInstanceSubhub({ storage, hub, operatorToken: OPERATOR, once: true, ...extra });
  return { root, source, storage, captured, manifest, hub, control, registrations, clients, beats, requests, run,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('connected Sub-hub imports exact immutable instance snapshots and reuses its private machine identity on restart', async () => {
  const f = await fixture();
  try {
    const statuses: InstanceRuntimeStatus[] = [];
    await f.run({ name: 'office', onStatus: value => statuses.push(value) });
    const local = new InstanceVault(f.storage);
    assert.deepEqual(local.list(), [f.captured]); await local.verify(f.captured.id);
    const restored = path.join(f.root, 'restored'); await local.restore(f.captured.id, restored);
    assert.match(fs.readFileSync(path.join(restored, 'deployment.json'), 'utf8'), new RegExp(SECRET));
    assert.equal(statuses.at(-1)?.state, 'up-to-date');
    assert.deepEqual(f.beats.at(-1), { state: 'up-to-date', snapshots: [f.captured] });
    assert.equal(f.registrations.length, 1);
    assert.equal(JSON.stringify(statuses).includes(SECRET), false);
    const stateFile = path.join(f.storage + '.runtime', 'connection.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.registered, true); assert.equal(saved.hub, f.hub); assert.equal(saved.storage, f.storage);
    assert.equal(fs.readFileSync(stateFile, 'utf8').includes(OPERATOR), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    const downloads = f.control.files;
    await f.run({ operatorToken: undefined });
    assert.equal(f.registrations.length, 1); assert.equal(f.control.files, downloads);
    assert.equal(f.beats.at(-1).state, 'up-to-date');
    assert.ok(f.requests.every(item => !item.headers.cookie && !item.headers.origin));
    assert.equal(fs.existsSync(path.join(f.storage + '.runtime', '.writer.lock')), false);
    assert.deepEqual(fs.readdirSync(path.join(f.storage + '.runtime', 'staging')), []);
  } finally { await f.close(); }
});

test('the actual recovery API and connection registry accept a complete runtime synchronization and machine-only restart', async () => {
  const f = await fixture();
  const registry = new InstanceConnections(path.join(f.root, 'registry'));
  registry.initialize();
  const server = http.createServer((req, res) => {
    void handleInstanceRecovery({ vault: f.source, connections: registry, authorize: async req => req.headers.authorization === `Bearer ${OPERATOR}`, source: 'real-api-fixture', storage: f.source.storageDir, containers: [], restoreRoot: '' }, req, res, new URL(req.url!, 'http://local'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const options = { hub, storage: f.storage, name: 'Office replica', operatorToken: OPERATOR, once: true };
    await runInstanceSubhub(options);
    assert.deepEqual(new InstanceVault(f.storage).list(), [f.captured]);
    const connected = registry.list();
    assert.equal(connected.length, 1); assert.equal(connected[0].name, 'Office replica');
    assert.equal(connected[0].state, 'up-to-date'); assert.equal(connected[0].online, true);
    assert.deepEqual(connected[0].snapshots, [f.captured]);
    assert.equal(JSON.stringify(connected).includes(SECRET), false); assert.equal(JSON.stringify(connected).includes('token'), false);
    await runInstanceSubhub({ ...options, operatorToken: undefined });
    assert.equal(registry.list().length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('an unconfigured or empty complete-instance source waits without inventing a successful backup', async () => {
  for (const available of [true, false]) {
    const f = await fixture();
    try {
      f.control.empty = true; f.control.available = available;
      await f.run();
      assert.deepEqual(new InstanceVault(f.storage).list(), []);
      assert.deepEqual(f.beats.at(-1), { state: 'waiting', snapshots: [] });
      assert.equal(f.control.files, 0);
    } finally { await f.close(); }
  }
});

test('registration persists a pending caller identity before the network and retries response loss without duplicate machines', async () => {
  const f = await fixture();
  try {
    f.control.lostRegistration = true; f.control.empty = true;
    await assert.rejects(f.run(), /could not be synchronized/);
    const filename = path.join(f.storage + '.runtime', 'connection.json');
    const pending = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(pending.registered, false); assert.equal(f.clients.size, 1);
    await f.run();
    assert.equal(f.clients.size, 1); assert.equal(f.registrations.length, 2);
    assert.deepEqual(f.registrations[0], f.registrations[1]);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).registered, true);
    assert.equal(f.beats.at(-1).state, 'waiting');
  } finally { await f.close(); }
});

test('enrollment needs operator access promptly, while revoked saved machine credentials never re-register', async () => {
  for (const operatorToken of [undefined, OPERATOR]) {
    const f = await fixture();
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 1000);
    try {
      f.control.enrollmentDenied = true;
      await assert.rejects(f.run({ once: false, operatorToken, signal: controller.signal }), /Sign in as a hub recovery operator/);
      assert.equal(f.clients.size, 0);
      const saved = JSON.parse(fs.readFileSync(path.join(f.storage + '.runtime', 'connection.json'), 'utf8'));
      assert.equal(saved.registered, false);
    } finally { clearTimeout(deadline); controller.abort(); await f.close(); }
  }
  const f = await fixture();
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 1000);
  try {
    f.control.empty = true; await f.run(); f.control.machineDenied = true;
    const before = fs.readFileSync(path.join(f.storage + '.runtime', 'connection.json'), 'utf8');
    await assert.rejects(f.run({ once: false, signal: controller.signal }), /machine credential.*saved identity has been retained/);
    assert.equal(f.registrations.length, 1);
    assert.equal(fs.readFileSync(path.join(f.storage + '.runtime', 'connection.json'), 'utf8'), before);
  } finally { clearTimeout(deadline); controller.abort(); await f.close(); }
});

test('corrupted downloads never publish or advertise a backup, and the same connection can retry safely', async () => {
  const f = await fixture();
  try {
    f.control.corrupt = true;
    const statuses: InstanceRuntimeStatus[] = [];
    await assert.rejects(f.run({ onStatus: status => statuses.push(status) }), /could not be synchronized/);
    assert.deepEqual(new InstanceVault(f.storage).list(), []);
    assert.equal(f.beats.at(-1).state, 'error'); assert.deepEqual(f.beats.at(-1).snapshots, []);
    assert.equal(JSON.stringify(statuses).includes(OPERATOR), false); assert.equal(JSON.stringify(statuses).includes(f.storage), false);
    assert.deepEqual(fs.readdirSync(path.join(f.storage + '.runtime', 'staging')), []);
    f.control.corrupt = false; await f.run({ operatorToken: undefined });
    assert.equal(new InstanceVault(f.storage).list()[0].id, f.captured.id);
    assert.equal(f.registrations.length, 1);
  } finally { await f.close(); }
});

test('unsafe source paths and oversized metadata fail before any payload request or external write', async () => {
  for (const failure of ['badPath', 'hugeIndex'] as const) {
    const f = await fixture();
    try {
      f.control[failure] = true;
      await assert.rejects(f.run(), /could not be synchronized/);
      assert.equal(f.control.files, 0); assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
      assert.deepEqual(new InstanceVault(f.storage).list(), []);
      assert.equal(f.beats.at(-1).state, 'error');
    } finally { await f.close(); }
  }
});

test('saved connections are target bound and insecure remote URLs are rejected before registration', async () => {
  const f = await fixture();
  try {
    f.control.empty = true; await f.run();
    const count = f.requests.length;
    await assert.rejects(f.run({ hub: 'https://other.example' }), /hub binding/);
    assert.equal(f.requests.length, count);
    for (const hub of ['http://untrusted.example', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=value']) await assert.rejects(f.run({ hub }), /HTTPS hub URL/);
    assert.equal(f.requests.length, count);
    assert.equal(fs.existsSync(path.join(f.storage + '.runtime', '.writer.lock')), false);
  } finally { await f.close(); }
});

test('independent heartbeats continue while streaming and abort cleans the owned stage and runtime lock', async () => {
  const f = await fixture();
  try {
    f.control.slow = true;
    const controller = new AbortController();
    const running = runInstanceSubhub({ storage: f.storage, hub: f.hub, operatorToken: OPERATOR, once: true, signal: controller.signal }, { heartbeatIntervalMs: 15 });
    await new Promise<void>((resolve, reject) => {
      const limit = setTimeout(() => { clearInterval(timer); reject(new Error('No independent heartbeat during transfer')); }, 3000);
      const timer = setInterval(() => { if (f.control.files && f.beats.length >= 3) { clearInterval(timer); clearTimeout(limit); resolve(); } }, 10);
    });
    assert.ok(f.beats.every(item => item.state === 'syncing'));
    await assert.rejects(f.run(), /running connection/);
    controller.abort(); await running;
    assert.deepEqual(new InstanceVault(f.storage).list(), []);
    assert.deepEqual(fs.readdirSync(path.join(f.storage + '.runtime', 'staging')), []);
    assert.equal(fs.existsSync(path.join(f.storage + '.runtime', '.writer.lock')), false);
    f.control.slow = false; await f.run({ operatorToken: undefined });
    assert.deepEqual(new InstanceVault(f.storage).list(), [f.captured]);
  } finally { await f.close(); }
});

test('unrelated runtime storage and filesystem links are never adopted', async t => {
  const f = await fixture();
  try {
    const runtime = f.storage + '.runtime'; fs.mkdirSync(runtime); put(runtime, 'keep', 'unrelated');
    await assert.rejects(f.run(), /private Sub-hub runtime storage/);
    assert.equal(fs.readFileSync(path.join(runtime, 'keep'), 'utf8'), 'unrelated');
    fs.rmSync(runtime, { recursive: true });
    const unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated);
    try { fs.symlinkSync(unrelated, runtime, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.diagnostic('link creation unavailable'); return; } throw error; }
    await assert.rejects(f.run(), /private Sub-hub runtime storage/);
    assert.deepEqual(fs.readdirSync(unrelated), []); assert.equal(f.registrations.length, 0);
  } finally { await f.close(); }
});

test('startup guard fails closed even with a dead owner and stale writer recovery releases its guard', async () => {
  const f = await fixture();
  try {
    f.control.empty = true; await f.run();
    const runtime = f.storage + '.runtime';
    const writer = path.join(runtime, '.writer.lock'), guard = path.join(runtime, '.writer.lock.guard');
    const deadOwner = JSON.stringify({ pid: 2147483647, nonce: '1'.repeat(32) });
    fs.writeFileSync(writer, deadOwner); fs.writeFileSync(guard, deadOwner);
    const requested = f.requests.length;
    await assert.rejects(f.run(), /startup guard.*inspect.*removing that guard/i);
    assert.equal(f.requests.length, requested);
    assert.equal(fs.readFileSync(writer, 'utf8'), deadOwner);
    assert.equal(fs.readFileSync(guard, 'utf8'), deadOwner);
    fs.unlinkSync(guard);
    await f.run({ operatorToken: undefined });
    assert.equal(f.beats.at(-1).state, 'waiting');
    assert.equal(fs.existsSync(writer), false); assert.equal(fs.existsSync(guard), false);
    assert.equal(f.registrations.length, 1);
  } finally { await f.close(); }
});
