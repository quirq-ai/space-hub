import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InstanceVault } from '../src/instancevault.ts';
import { handleInstanceRecovery, recoveryRemote } from '../src/instancerecovery.ts';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-recovery-'));
  const vault = new InstanceVault(path.join(root, 'vault')); vault.initialize();
  const source = path.join(root, 'prepared'); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'volumes', 'data', 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'images'));
  fs.mkdirSync(path.join(source, 'containers'));
  fs.writeFileSync(path.join(source, 'volumes', 'data', 'config', 'signing.key'), 'private-instance-key');
  fs.writeFileSync(path.join(source, 'images', 'runtime.tar'), 'saved-runtime-image');
  fs.writeFileSync(path.join(source, 'containers', 'spacehub.tar'), 'saved-container-filesystem');
  fs.writeFileSync(path.join(source, 'deployment.json'), JSON.stringify({ environment: ['XO_KEY=private-value'], databases: ['all-orgs-and-builders'] }));
  const snapshot = await vault.capture(source, { source: 'test-entire-instance', services: ['spacehub', 'proxy'], consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true } });
  const restoreRoot = path.join(root, 'restores');
  const received: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => { received.push(req.headers); void handleInstanceRecovery({ vault, source: 'test-entire-instance', storage: path.join(root, 'vault'), containers: ['spacehub', 'proxy'], restoreRoot,
    authorize: async request => request.headers.authorization === 'Bearer hub-operator' && (!request.headers.origin || request.headers.origin === 'http://trusted.local'),
  }, req, res, new URL(req.url!, 'http://local')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/-/api/instance-recovery`;
  const ask = (route: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { authorization: 'Bearer hub-operator', ...Object.fromEntries(new Headers(init.headers)) } });
  return { root, vault, source, snapshot, restoreRoot, base, ask, received, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('full-instance API is global and excludes private backup contents from listings', async () => {
  const f = await fixture();
  try {
    const status = await (await f.ask('/status')).json();
    assert.equal(status.scope, 'instance');
    assert.equal(status.canManage, true);
    assert.deepEqual(status.cli.containers, ['spacehub', 'proxy']);
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
