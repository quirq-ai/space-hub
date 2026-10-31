import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { InstanceVault } from '../src/instancevault.ts';
import { handleInstanceRecovery, recoveryRemote } from '../src/instancerecovery.ts';
import { InstanceConnections } from '../src/instanceconnections.ts';

async function fixture(options: { noSource?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-recovery-'));
  const vault = new InstanceVault(path.join(root, 'vault')); vault.initialize();
  const source = path.join(root, 'prepared'); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'volumes', 'data', 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'images'));
  fs.mkdirSync(path.join(source, 'containers'));
  fs.writeFileSync(path.join(source, 'volumes', 'data', 'config', 'signing.key'), 'private-instance-key');
  fs.writeFileSync(path.join(source, 'images', 'runtime.tar'), 'saved-runtime-image');
  fs.writeFileSync(path.join(source, 'containers', 'spacehub.tar'), 'saved-container-filesystem');
  const binary = Buffer.from([0, 255, 254, 128, 13, 10, 0, 240]);
  fs.writeFileSync(path.join(source, 'volumes', 'binary.tar'), binary);
  fs.writeFileSync(path.join(source, 'deployment.json'), JSON.stringify({ environment: ['XO_KEY=private-value'], databases: ['all-orgs-and-builders'] }));
  const snapshot = await vault.capture(source, { source: 'test-entire-instance', services: ['spacehub', 'proxy'], consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true } });
  const restoreRoot = path.join(root, 'restores');
  const received: http.IncomingHttpHeaders[] = [];
  const connections = new InstanceConnections(path.join(root, 'connections')); connections.initialize();
  const server = http.createServer((req, res) => { received.push(req.headers); void handleInstanceRecovery({ vault: options.noSource ? null : vault, connections, machineName: 'recovery-fixture', source: 'test-entire-instance', storage: path.join(root, 'vault'), containers: ['spacehub', 'proxy'], restoreRoot,
    authorize: async request => request.headers.authorization === 'Bearer hub-operator' && (!request.headers.origin || request.headers.origin === 'http://trusted.local'),
  }, req, res, new URL(req.url!, 'http://local')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/-/api/instance-recovery`;
  const ask = (route: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { authorization: 'Bearer hub-operator', ...Object.fromEntries(new Headers(init.headers)) } });
  return { root, vault, source, snapshot, restoreRoot, base, ask, received, connections, binary, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('instance-recovery-')); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('full-instance API is global and excludes private backup contents from listings', async () => {
  const f = await fixture();
  try {
    const status = await (await f.ask('/status')).json();
    assert.equal(status.scope, 'instance');
    assert.equal(status.canManage, true);
    assert.equal(status.machineName, 'recovery-fixture'); assert.equal(status.sourceAvailable, true);
    assert.equal('containers' in status.cli, false);
    const listing = await (await f.ask('/snapshots')).json();
    assert.equal(listing.snapshots[0].scope, 'instance');
    assert.equal(JSON.stringify(listing).includes('private-instance-key'), false);
    assert.equal(JSON.stringify(listing).includes('private-value'), false);
    assert.equal((await f.ask('/status', { headers: { authorization: 'Bearer org-owner' } })).status, 403);
    assert.equal((await f.ask('/snapshots', { headers: { authorization: '' } })).status, 403);
    for (const section of ['/work', '/sessions', '/drive/files']) assert.equal((await f.ask(section)).status, 404);
  } finally { await f.close(); }
});

test('a separate Sub-hub service receives its own credential and remains independent of org APIs', async () => {
  const f = await fixture();
  const proxy = http.createServer((req, res) => { void handleInstanceRecovery({ vault: null, source: 'parent-hub', storage: '', containers: [], restoreRoot: '',
    remote: { url: new URL(f.base).origin, token: 'hub-operator' }, authorize: async request => request.headers.authorization === 'Bearer parent-operator',
  }, req, res, new URL(req.url!, 'http://parent')); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/-/api/instance-recovery`;
    const request = (route: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { authorization: 'Bearer parent-operator', cookie: 'spacehub_session=private-human-credential', ...Object.fromEntries(new Headers(init.headers)) } });
    assert.equal((await request('/status')).status, 200);
    assert.equal((await request(`/snapshots/${f.snapshot.id}/verify`, { method: 'POST' })).status, 200);
    assert.ok(f.received.every(headers => headers.authorization === 'Bearer hub-operator' && headers.cookie === undefined));
    const destination = path.join(f.restoreRoot, 'remote-recovery');
    assert.equal((await request('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.snapshot.id, directory: destination }) })).status, 200);
    assert.equal(fs.readFileSync(path.join(destination, 'images', 'runtime.tar'), 'utf8'), 'saved-runtime-image');
    assert.equal((await request('/work')).status, 404);
    assert.equal((await request('/status', { headers: { authorization: 'Bearer org-owner' } })).status, 403);
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await f.close(); }
});

test('recovery service configuration accepts private HTTPS or loopback endpoints without URL credentials', () => {
  assert.equal(recoveryRemote(undefined, undefined), null);
  assert.equal(recoveryRemote('https://vault.example/recovery/', 'x'.repeat(64))?.url, 'https://vault.example/recovery');
  for (const url of ['http://untrusted.example', 'https://user:secret@vault.example', 'file:///backup', 'https://vault.example/?token=secret']) assert.throws(() => recoveryRemote(url, 'x'.repeat(64)));
  assert.throws(() => recoveryRemote('https://vault.example', 'short'));
});

test('verify and restore retain all deployment components, without starting or overwriting an instance', async () => {
  const f = await fixture();
  try {
    const verified = await f.ask(`/snapshots/${f.snapshot.id}/verify`, { method: 'POST' });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).snapshot.id, f.snapshot.id);
    const directory = path.join(f.restoreRoot, 'recovered-spacehub');
    const restore = (requested: string) => f.ask('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.snapshot.id, directory: requested }) });
    assert.equal((await restore(directory)).status, 200);
    assert.equal(fs.readFileSync(path.join(directory, 'volumes', 'data', 'config', 'signing.key'), 'utf8'), 'private-instance-key');
    assert.equal(fs.readFileSync(path.join(directory, 'images', 'runtime.tar'), 'utf8'), 'saved-runtime-image');
    assert.match(fs.readFileSync(path.join(directory, 'deployment.json'), 'utf8'), /private-value/);
    assert.notEqual((await restore(directory)).status, 200);
    assert.equal((await restore(path.join(f.root, 'outside-policy'))).status, 400);
    assert.equal((await restore(f.restoreRoot)).status, 400);
    assert.equal((await f.ask('/restore', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ id: f.snapshot.id, directory: path.join(f.restoreRoot, 'evil') }) })).status, 403);
  } finally { await f.close(); }
});

test('only global operators enroll machines; credentials grant their own heartbeat and source reads only', async () => {
  const f = await fixture();
  try {
    const enrollment = { id: '1'.repeat(32), token: '2'.repeat(64), name: 'Recovery laptop' };
    const register = (headers = {}) => f.ask('/connections', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(enrollment) });
    assert.equal((await register({ authorization: 'Bearer org-owner' })).status, 403);
    const registration = await register(); assert.equal(registration.status, 200);
    assert.deepEqual(await registration.json(), { id: enrollment.id, token: enrollment.token });
    assert.equal((await register()).status, 200); assert.equal(f.connections.list().length, 1);
    const other = f.connections.register('Other machine');
    const beat = (token: string, extra = {}, headers = {}) => f.ask(`/connections/${enrollment.id}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ state: 'syncing', snapshots: [f.snapshot], lastSeen: 0, ...extra }) });
    assert.equal((await beat(other.token)).status, 403);
    assert.equal((await beat(enrollment.token, {}, { origin: 'https://foreign.example' })).status, 403);
    const update = await beat(enrollment.token); assert.equal(update.status, 200);
    const publicStatus = await update.json(); assert.equal(publicStatus.state, 'syncing'); assert.equal(publicStatus.online, true); assert.ok(publicStatus.lastSeen > 0);
    for (const route of ['/connections', '/snapshots', '/status']) assert.equal((await f.ask(route, { headers: { authorization: `Bearer ${enrollment.token}` } })).status, 403);
    assert.equal((await f.ask(`/snapshots/${f.snapshot.id}/verify`, { method: 'POST', headers: { authorization: `Bearer ${enrollment.token}` } })).status, 403);
    const listing = JSON.stringify(await (await f.ask('/connections')).json());
    assert.ok(listing.includes('Recovery laptop')); assert.ok(!listing.includes(enrollment.token)); assert.ok(!listing.includes('tokenHash')); assert.ok(!listing.includes('private-value'));
    const reopened = new InstanceConnections(path.join(f.root, 'connections')); assert.equal(reopened.authorize(enrollment.token), true);
    const oversized = await f.ask(`/connections/${enrollment.id}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${enrollment.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'error', snapshots: [], error: 'x'.repeat(256 * 1024) }) });
    assert.equal(oversized.status, 413);
  } finally { await f.close(); }
});

test('source routes transfer only authenticated manifest-listed full-instance bytes, with hashes and no extraction', async () => {
  const f = await fixture();
  try {
    const machine = f.connections.register('Receiver');
    const request = (route: string, init: RequestInit = {}) => f.ask('/source' + route, { ...init, headers: { authorization: `Bearer ${machine.token}`, ...Object.fromEntries(new Headers(init.headers)) } });
    assert.equal((await request('/snapshots', { headers: { authorization: 'Bearer unregistered' } })).status, 403);
    assert.equal((await request('/snapshots', { headers: { origin: 'http://trusted.local' } })).status, 403);
    const catalog = await (await request('/snapshots')).json(); assert.deepEqual(catalog.snapshots, [f.snapshot]); assert.ok(!JSON.stringify(catalog).includes('private-value'));
    const manifest = await (await request(`/snapshots/${f.snapshot.id}/manifest`)).json();
    assert.deepEqual(manifest.snapshot, f.snapshot); assert.equal(manifest.version, 1); assert.ok(manifest.files.some((file: any) => file.path === 'deployment.json'));
    const file = await request(`/snapshots/${f.snapshot.id}/file?path=volumes%2Fbinary.tar`);
    assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'application/octet-stream'); assert.equal(file.headers.get('content-length'), String(f.binary.length));
    assert.equal(file.headers.get('x-spacehub-snapshot'), f.snapshot.id); assert.equal(file.headers.get('x-spacehub-sha256'), crypto.createHash('sha256').update(f.binary).digest('hex'));
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), f.binary); assert.equal(file.headers.get('set-cookie'), null); assert.equal(file.headers.get('location'), null);
    const deployment = await request(`/snapshots/${f.snapshot.id}/file?path=deployment.json`); assert.match(await deployment.text(), /private-value/);
    for (const invalid of ['../connections/connections.json', '/etc/passwd', 'volumes\\binary.tar', 'https://external.example/private']) assert.equal((await request(`/snapshots/${f.snapshot.id}/file?path=${encodeURIComponent(invalid)}`)).status, 400);
    assert.equal((await request(`/snapshots/${f.snapshot.id}/file?path=manifest.json`)).status, 404);
    assert.equal((await request('/work')).status, 404);
    assert.equal((await request('/snapshots', { method: 'POST' })).status, 404);
    fs.writeFileSync(path.join(f.source, 'deployment.json'), 'source mutation does not change the retained immutable backup');
    const retained = await request(`/snapshots/${f.snapshot.id}/file?path=deployment.json`); assert.match(await retained.text(), /private-value/);
    fs.writeFileSync(path.join(f.vault.storageDir, 'snapshots', f.snapshot.id, 'payload', 'volumes', 'binary.tar'), Buffer.alloc(f.binary.length, 3));
    assert.equal((await request(`/snapshots/${f.snapshot.id}/manifest`)).status, 409);
  } finally { await f.close(); }
});

test('connections work while a full-instance source is unconfigured and source reports unavailable', async () => {
  const f = await fixture({ noSource: true });
  try {
    const registered = await f.ask('/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Waiting receiver' }) });
    const machine = await registered.json(); assert.match(machine.id, /^[a-f0-9]{32}$/);
    const status = await (await f.ask('/status')).json(); assert.equal(status.available, false); assert.equal(status.sourceAvailable, false); assert.match(status.sourceError, /wait and retry automatically/);
    const unavailable = await f.ask('/source/snapshots', { headers: { authorization: `Bearer ${machine.token}` } }); assert.equal(unavailable.status, 503); assert.match((await unavailable.json()).error, /No full-instance backup source/);
    const heartbeat = await f.ask(`/connections/${machine.id}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'waiting', snapshots: [], error: 'PRIVATE_TOKEN=local-private-value' }) });
    assert.equal(heartbeat.status, 200); const summary = await heartbeat.json(); assert.equal(summary.state, 'waiting'); assert.equal(summary.online, true); assert.ok(!JSON.stringify(summary).includes('local-private-value'));
    assert.equal((await f.ask('/connections')).status, 200);
  } finally { await f.close(); }
});

test('source proxy authenticates local machines and forwards only the private source credential and fixed file path', async () => {
  const f = await fixture(), connections = new InstanceConnections(path.join(f.root, 'parent-connections')); connections.initialize();
  const proxy = http.createServer((req, res) => { void handleInstanceRecovery({ vault: null, connections, source: 'parent-hub', storage: '', containers: [], restoreRoot: '', remote: { url: new URL(f.base).origin, token: 'hub-operator' }, authorize: async request => request.headers.authorization === 'Bearer parent-operator' }, req, res, new URL(req.url!, 'http://parent')); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/-/api/instance-recovery`;
  try {
    const registration = await fetch(base + '/connections', { method: 'POST', headers: { authorization: 'Bearer parent-operator', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Parent receiver' }) });
    const machine = await registration.json(); assert.equal(connections.list().length, 1); assert.equal(f.connections.list().length, 0);
    const headers = { authorization: `Bearer ${machine.token}`, cookie: 'spacehub_session=private-human-session' };
    assert.equal((await fetch(base + '/source/snapshots', { headers })).status, 200);
    assert.equal((await fetch(base + `/source/snapshots/${f.snapshot.id}/manifest`, { headers })).status, 200);
    const file = await fetch(base + `/source/snapshots/${f.snapshot.id}/file?path=volumes%2Fbinary.tar`, { headers }); assert.equal(file.status, 200); assert.deepEqual(Buffer.from(await file.arrayBuffer()), f.binary);
    assert.equal(file.headers.get('x-spacehub-snapshot'), f.snapshot.id); assert.equal(file.headers.get('x-spacehub-sha256'), crypto.createHash('sha256').update(f.binary).digest('hex'));
    assert.ok(f.received.every(request => request.authorization === 'Bearer hub-operator' && request.cookie === undefined && request.origin === undefined));
    assert.equal((await fetch(base + '/source/work', { headers })).status, 404);
    assert.equal((await fetch(base + '/source/snapshots', { headers: { authorization: 'Bearer org-owner' } })).status, 403);
    assert.equal((await fetch(base + '/connections', { headers })).status, 403);
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await f.close(); }
});

test('source proxy refuses redirects before any credential can reach a different endpoint', async () => {
  const f = await fixture(), machine = f.connections.register('Receiver'); let redirectsFollowed = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/leak') { redirectsFollowed++; res.end('unexpected redirect'); return; }
    assert.equal(req.headers.authorization, 'Bearer private-source-key'); assert.equal(req.headers.cookie, undefined);
    res.writeHead(302, { location: '/leak', 'set-cookie': 'private_remote_cookie=never-forward' }); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((req, res) => { void handleInstanceRecovery({ vault: null, connections: f.connections, source: 'parent', storage: '', containers: [], restoreRoot: '', remote: { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token: 'private-source-key' }, authorize: async () => false }, req, res, new URL(req.url!, 'http://local')); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/-/api/instance-recovery/source/snapshots`, { headers: { authorization: `Bearer ${machine.token}`, cookie: 'human_cookie=private' } });
    assert.equal(response.status, 502); assert.equal(redirectsFollowed, 0); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('location'), null);
    assert.ok(!JSON.stringify(await response.json()).includes('private-source-key'));
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]); await f.close(); }
});
