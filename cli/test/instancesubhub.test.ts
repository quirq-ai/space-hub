// Exercise the actual CLI and standalone recovery HTTP service. Fixture
// archives deliberately contain test bytes, never a production backup.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { InstanceVault } from '../src/instancevault.ts';

let compiled: string, cli: string, assets: string;
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'instance-cli-'));
function cleanup(directory: string) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('instance-cli-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
before(async () => {
  compiled = temporary(); cli = path.join(compiled, 'cli.mjs'); assets = path.join(compiled, 'app');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'app.js'), '/* recovery app fixture */');
  fs.writeFileSync(path.join(assets, 'app.css'), 'body{color:black}');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/cli.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
});
after(() => { if (compiled) cleanup(compiled); });
function run(args: string[]) {
  return new Promise<{ code: number | string | undefined; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [cli, ...args], { timeout: 10_000, windowsHide: true, encoding: 'utf8', env: { ...process.env, SPACEHUB_APP_DIR: assets } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}
async function fixture() {
  const root = temporary(), storage = path.join(root, 'vault'), source = path.join(root, 'source');
  for (const directory of ['images', 'containers', 'volumes']) fs.mkdirSync(path.join(source, directory), { recursive: true });
  fs.writeFileSync(path.join(source, 'deployment.json'), '{"fixture":true,"environment":["PRIVATE_KEY=test-only-secret"]}');
  fs.writeFileSync(path.join(source, 'images', 'runtime.tar'), 'fixture-runtime');
  fs.writeFileSync(path.join(source, 'containers', 'hub.tar'), 'fixture-rootfs');
  fs.writeFileSync(path.join(source, 'volumes', 'data.tar'), 'fixture-all-orgs-and-identities');
  const vault = new InstanceVault(storage); vault.initialize();
  const snapshot = await vault.capture(source, { source: 'integration-fixture', services: ['hub', 'proxy'], consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true } });
  return { root, storage, snapshot };
}

test('Sub-hubs and Nodes expose distinct CLI contracts; full backup refuses org filters', async () => {
  const subhub = await run(['subhub', 'help']), node = await run(['node', 'help']);
  assert.equal(subhub.code, 0, subhub.stderr); assert.equal(node.code, 0, node.stderr);
  assert.match(subhub.stdout, /subhub backup --container/);
  assert.match(subhub.stdout, /subhub restore <snapshot> <new-directory>/);
  assert.match(node.stdout, /spacehub node run --space/);
  assert.doesNotMatch(subhub.stdout, /subhub (?:work|run|register)/);
  const invalid = await run(['subhub', 'backup', '--container', 'hub', '--storage', path.join(compiled, 'invalid'), '--space', 'quirq']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Unknown Sub-hub arguments: --space quirq/);
});

test('CLI list, verify and new-directory restore retain the entire instance bundle', async () => {
  const f = await fixture();
  try {
    const listing = await run(['subhub', 'snapshots', '--storage', f.storage]);
    assert.equal(listing.code, 0, listing.stderr);
    assert.equal(JSON.parse(listing.stdout)[0].id, f.snapshot.id);
    assert.doesNotMatch(listing.stdout, /test-only-secret/);
    const verified = await run(['subhub', 'verify', f.snapshot.id, '--storage', f.storage]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).files, 4);
    const destination = path.join(f.root, 'recovered');
    const restored = await run(['subhub', 'restore', f.snapshot.id, destination, '--storage', f.storage]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(fs.readFileSync(path.join(destination, 'containers', 'hub.tar'), 'utf8'), 'fixture-rootfs');
    assert.match(fs.readFileSync(path.join(destination, 'deployment.json'), 'utf8'), /test-only-secret/);
    const duplicate = await run(['subhub', 'restore', f.snapshot.id, destination, '--storage', f.storage]);
    assert.notEqual(duplicate.code, 0);
    assert.equal(fs.readFileSync(path.join(destination, 'volumes', 'data.tar'), 'utf8'), 'fixture-all-orgs-and-identities');
  } finally { cleanup(f.root); }
});

test('standalone Sub-hub UI works without the main hub and protects restore from cross-origin requests', { timeout: 20_000 }, async () => {
  const f = await fixture();
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`, restoreRoot = path.join(f.root, 'restores'), tokenFile = path.join(f.root, 'private-token');
  const child = spawn(process.execPath, [cli, 'subhub', 'serve', '--storage', f.storage, '--restore-root', restoreRoot, '--listen', `127.0.0.1:${port}`, '--token-file', tokenFile], { windowsHide: true, env: { ...process.env, SPACEHUB_APP_DIR: assets }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Recovery service did not start')), 10_000);
      let stderr = '';
      child.stderr.on('data', part => { stderr += String(part); if (stderr.includes('Sub-hubs recovery UI:')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Recovery service exited ${code}: ${stderr}`)); });
      child.once('error', reject);
    });
    assert.equal((await fetch(base + '/-/api/instance-recovery/status')).status, 403);
    const page = await fetch(base + '/');
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    assert.match(page.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.match(await page.text(), /recovery-entry.js/);
    const status = await fetch(base + '/-/api/instance-recovery/status', { headers: { cookie } });
    assert.equal(status.status, 200); assert.equal((await status.json()).scope, 'instance');
    assert.match(await (await fetch(base + '/-/app/app.js')).text(), /recovery app fixture/);
    const route = base + `/-/api/instance-recovery/snapshots/${f.snapshot.id}/verify`;
    assert.equal((await fetch(route, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(route, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(route, { method: 'POST', headers: { cookie, origin: base } })).status, 200);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.equal((await fetch(route, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 200);
    const destination = path.join(restoreRoot, 'from-ui');
    const restored = await fetch(base + '/-/api/instance-recovery/restore', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: f.snapshot.id, directory: destination }) });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(fs.readFileSync(path.join(destination, 'images', 'runtime.tar'), 'utf8'), 'fixture-runtime');
    assert.equal((await fetch(base + '/-/api/instance-recovery/work', { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + '/-/api/chat')).status, 404);
    assert.equal((await fetch(base + '/-/api/view')).status, 503);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(base + '/-/api/instance-recovery/status', { headers: { cookie, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject);
    });
    assert.equal(foreignHost, 403);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
    cleanup(f.root);
  }
});
