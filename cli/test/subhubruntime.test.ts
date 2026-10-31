// Exercise the built CLI process against a local control-plane stand-in. A
// paused/drive node must never try to open a database or launch Git backups.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

const NODE_ID = 'runtime-node';
const NODE_TOKEN = 'private-node-token';
const OWNER_TOKEN = 'fake-owner-token';
const ADVERTISE = 'https://node.example';
const CAPACITY = 1024 * 1024 * 1024;
const CAPABILITIES = ['backup', 'queue', 'immutable-read', 'active-drive', 'activity', 'node-settings'];
let compiledDir: string;
let cli: string;

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'subhub-runtime-')); }
function removeTemporary(directory: string) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('subhub-runtime-')) throw new Error('Unsafe runtime-test cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
}

before(async () => {
  compiledDir = temporary();
  cli = path.join(compiledDir, 'spacehub.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/cli.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
});
after(() => { if (compiledDir) removeTemporary(compiledDir); });

async function fixture(options: { mode?: 'backup' | 'drive'; heartbeatFails?: boolean; capabilities?: string[] } = {}) {
  const root = temporary();
  const storage = path.join(root, 'node');
  fs.mkdirSync(storage);
  const requests: { method: string; path: string; authorization?: string; body: unknown }[] = [];
  const upgrades: string[] = [];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString('utf8');
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, body });
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const route = req.url?.replace('/-/api/subhubs', '');
    if (route === '/protocol' && req.method === 'GET') return send(200, { version: 1, capabilities: options.capabilities ?? CAPABILITIES });
    if (route === `/nodes/${NODE_ID}/heartbeat` && req.method === 'POST') {
      if (options.heartbeatFails) return send(503, { error: 'Parent temporarily offline' });
      return send(200, { node: { id: NODE_ID, mode: options.mode ?? 'drive', enabled: false } });
    }
    if (route === `/nodes/${NODE_ID}/work` && req.method === 'GET') return send(200, { work: [] });
    if (route === `/nodes/${NODE_ID}/receipt` && req.method === 'POST') return send(200, { work: [] });
    // An unexpected PATCH/registration or SDK HTTP call is observable and
    // fails quickly, so a regression cannot contact a real hub or database.
    return send(404, { error: `Unexpected runtime request: ${req.method} ${req.url}` });
  });
  server.on('upgrade', (req, socket) => { upgrades.push(req.url ?? ''); socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { id: NODE_ID, space: 'quirq', server: origin, token: NODE_TOKEN, url: ADVERTISE, capacityBytes: CAPACITY, standalone: false, mode: options.mode ?? 'drive', enabled: false };
  fs.writeFileSync(path.join(storage, '.spacehub-node.json'), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(storage, 'node.json'), JSON.stringify(saved));

  const run = (extra: string[] = [], group = 'subhub') => new Promise<{ code: string | number | undefined; killed: boolean; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [cli, group, 'run', '--space', 'quirq', '--id', NODE_ID, '--storage', storage, '--advertise', ADVERTISE, '--once', ...extra], {
      cwd: root, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, SPACEHUB_SERVER: origin, SPACEHUB_DB: 'runtime-test', SPACEHUB_TOKEN: OWNER_TOKEN, SPACEHUB_HOME: path.join(root, 'auth'), SPACEHUB_DEBUG: '' },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, killed: !!error?.killed, stdout, stderr }));
  });
  const status = () => JSON.parse(fs.readFileSync(path.join(storage, 'status.json'), 'utf8'));
  const config = () => JSON.parse(fs.readFileSync(path.join(storage, 'node.json'), 'utf8'));
  const assertNoDatabase = () => {
    assert.deepEqual(upgrades, [], 'the runtime attempted a database websocket');
    assert.deepEqual(requests.filter(request => !request.path.startsWith('/-/api/subhubs/')), [], 'the runtime attempted an SDK/database HTTP request');
    const caches = path.join(storage, 'backup', 'caches');
    if (fs.existsSync(caches)) assert.deepEqual(fs.readdirSync(caches), [], 'a backup Git cache was created');
  };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); removeTemporary(root); };
  return { storage, requests, saved, run, status, config, assertNoDatabase, close };
}

test('the node command runs with the same persisted storage and protocol as legacy commands', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await f.run([], 'node');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.status().mode, 'drive');
  assert.equal(f.status().enabled, false);
  f.assertNoDatabase();
});

test('restarting the original backup command preserves the parent-owned drive mode without PATCH', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await f.run(['--mode', 'backup']);
  assert.equal(result.killed, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.status().mode, 'drive');
  assert.equal(f.status().enabled, false);
  assert.equal(f.config().mode, 'drive');
  assert.equal(f.config().token, NODE_TOKEN);
  assert.equal(f.requests.some(request => request.method === 'PATCH' || request.path.endsWith('/nodes/register')), false);
  assert.ok(f.requests.some(request => request.path.endsWith('/heartbeat')));
  for (const request of f.requests.filter(request => request.path.endsWith('/heartbeat') || request.path.endsWith('/work'))) assert.equal(request.authorization, `Bearer ${NODE_TOKEN}`);
  f.assertNoDatabase();
  assert.equal(fs.existsSync(path.join(f.storage, '.node.lock')), false);
});

test('a persisted pause survives failed initial heartbeats without starting database connections or backups', async t => {
  for (const mode of ['drive', 'backup'] as const) await t.test(mode, async child => {
    const f = await fixture({ mode, heartbeatFails: true }); child.after(f.close);
    const result = await f.run();
    assert.equal(result.killed, false, result.stderr);
    assert.notEqual(result.code, 0, 'an unavailable parent should be reported');
    assert.match(result.stderr, /Parent temporarily offline/);
    const status = f.status();
    assert.equal(status.mode, mode);
    assert.equal(status.enabled, false);
    assert.equal(status.status, 'degraded');
    assert.equal(f.config().enabled, false);
    assert.equal(f.requests.some(request => request.path.endsWith('/work')), false);
    f.assertNoDatabase();
    assert.equal(fs.existsSync(path.join(f.storage, '.node.lock')), false);
  });
});

test('saved drive mode requires active-drive support even when --mode is omitted on restart', async t => {
  const f = await fixture({ capabilities: ['backup', 'queue', 'immutable-read'] }); t.after(f.close);
  const result = await f.run();
  assert.equal(result.killed, false, result.stderr);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /parent needs an update for active-drive/i);
  assert.equal(f.requests.filter(request => request.path.endsWith('/protocol')).length, 2);
  assert.equal(f.requests.some(request => request.path.endsWith('/heartbeat') || request.method === 'PATCH'), false);
  assert.equal(fs.existsSync(path.join(f.storage, 'status.json')), false);
  assert.deepEqual(f.config(), f.saved);
  f.assertNoDatabase();
  assert.equal(fs.existsSync(path.join(f.storage, '.node.lock')), false);
});
