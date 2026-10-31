import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { InstanceVault } from './instancevault.ts';
import { captureDeployment } from './instancecapture.ts';
import { handleInstanceRecovery } from './instancerecovery.ts';
import { APP_CSP, appDir, appPage, handleApp } from './app';
import { loadConfig } from './config';
import { runInstanceSubhub } from './instanceruntime.ts';
import { InstanceConnections } from './instanceconnections.ts';

const HELP = `spacehub subhub run --storage <folder> [--name <name>] [--interval <seconds>]
spacehub subhub backup --storage <folder>
spacehub subhub snapshots --storage <vault>
spacehub subhub verify <snapshot> --storage <vault>
spacehub subhub restore <snapshot> <new-directory> --storage <vault>
spacehub subhub serve --storage <vault>
    [--listen 127.0.0.1:4092] [--restore-root <directory>] [--source <hub-name>]
    [--token-file <private-file>]
spacehub subhub capture --container <spacehub> [--container <proxy>] --storage <vault> [--allow-stop]
spacehub subhub source --storage <vault> --capture-config <private-json> [--capture-every <seconds>]

run connects to your configured hub and automatically retains verified full-instance
backups. Sign in as a hub recovery operator before the first connection.
Settings shows connection, backup and offline status. backup runs one sync.
Capture/source are deployment-operator setup commands for producing complete
source backups. Restore writes a new directory without starting an instance.`;

function flag(args: string[], name: string) {
  const at = args.indexOf(name); if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(at, 2); return value;
}
function repeated(args: string[], name: string) { const values: string[] = []; let value: string | undefined; while ((value = flag(args, name)) !== undefined) values.push(value); return values; }
function yes(args: string[], name: string) { const at = args.indexOf(name); if (at < 0) return false; args.splice(at, 1); return true; }
function required(value: string | undefined, label: string) { if (!value) throw new Error(`${label} is required`); return value; }
function remaining(args: string[]) { if (args.length) throw new Error(`Unknown Sub-hub arguments: ${args.join(' ')}`); }
function print(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

async function serve(args: string[], sourceMode = false) {
  const storage = path.resolve(required(flag(args, '--storage'), '--storage'));
  const containers: string[] = [];
  const captureFile = flag(args, '--capture-config');
  const captureEvery = Number(flag(args, '--capture-every') ?? 3600);
  if (sourceMode && !captureFile) throw new Error('Source setup needs --capture-config with the deployment capture configuration');
  if (!Number.isSafeInteger(captureEvery) || captureEvery < 60 || captureEvery > 86400) throw new Error('--capture-every must be 60 to 86400 seconds');
  let captureConfig: { containers: string[]; allowStop: boolean } | undefined;
  if (captureFile) {
    const filename = path.resolve(captureFile), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid private capture configuration');
    const input = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!input || !Array.isArray(input.containers) || !input.containers.length || input.containers.length > 64 || input.containers.some((name: unknown) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) || typeof input.allowStop !== 'boolean') throw new Error('Capture configuration needs deployment containers and explicit allowStop');
    captureConfig = { containers: input.containers, allowStop: input.allowStop };
  }
  const source = flag(args, '--source') ?? 'Spacehub instance';
  const tokenFile = flag(args, '--token-file');
  const restoreRoot = path.resolve(flag(args, '--restore-root') ?? path.join(path.dirname(storage), 'spacehub-restores'));
  const listen = flag(args, '--listen') ?? '127.0.0.1:4092';
  const address = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(listen);
  if (!address || Number(address[2]) < 1 || Number(address[2]) > 65535) throw new Error('Recovery UI currently listens on loopback only (127.0.0.1:port)');
  remaining(args);
  const origin = `http://127.0.0.1:${Number(address[2])}`;
  const hosts = new Set([`127.0.0.1:${Number(address[2])}`, `localhost:${Number(address[2])}`]);
  const vault = new InstanceVault(storage); vault.initialize();
  const connections = new InstanceConnections(storage + '.connections'); connections.initialize();
  let token = crypto.randomBytes(32).toString('hex');
  if (tokenFile) {
    const filename = path.resolve(tokenFile);
    for (let at = filename; ; at = path.dirname(at)) { if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error('Recovery token file cannot use symlinks'); if (path.dirname(at) === at) break; }
    if (fs.existsSync(filename)) {
      if (!fs.lstatSync(filename).isFile() || fs.statSync(filename).size > 100) throw new Error('Invalid recovery token file');
      token = fs.readFileSync(filename, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Recovery token file must contain a generated 64-character key');
    } else fs.writeFileSync(filename, token + '\n', { flag: 'wx', mode: 0o600 });
  }
  const dir = appDir();
  if (!fs.existsSync(path.join(dir, 'app.js'))) throw new Error('Build the app before serving recovery UI: run npm run build in app/');
  const authorized = async (req: http.IncomingMessage) => {
    if (!hosts.has(req.headers.host ?? '')) return false;
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const cookie = /(?:^|;\s*)spacehub_recovery=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (bearer !== token && cookie !== token) return false;
    return req.method === 'GET' || req.method === 'HEAD' || bearer === token || req.headers.origin === `http://${req.headers.host}`;
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!hosts.has(req.headers.host ?? '')) { res.writeHead(403); res.end('Use the printed loopback URL'); return; }
      const url = new URL(req.url!, origin);
      if (await handleInstanceRecovery({ vault, connections, authorize: authorized, source, storage, containers, restoreRoot }, req, res, url)) return;
      if (url.pathname === '/-/recovery-entry.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end("if (!location.hash) history.replaceState(null, '', '/#/settings');"); return;
      }
      if (url.pathname === '/-/api/me') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"name":null,"recoveryOnly":true}'); return; }
      if (url.pathname === '/-/api/view') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"This standalone recovery UI does not load orgs or projects."}'); return; }
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': APP_CSP, 'cache-control': 'no-store', 'set-cookie': `spacehub_recovery=${token}; HttpOnly; SameSite=Strict; Path=/` });
        res.end(appPage(dir, 'Sub-hubs · Spacehub recovery').replace('</head>', '<script src="/-/recovery-entry.js"></script></head>')); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/-/app/') && await handleApp({ dir, internalHttp: '', db: '', sessionOf: async () => null,
        withConn: async () => { throw new Error('Recovery UI does not create database sessions'); },
      }, req, res, url)) return;
      res.writeHead(404); res.end('This service provides full-instance Sub-hubs only');
    })().catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('Recovery service request failed'); } else res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(address[2]), '127.0.0.1', resolve); });
  process.stderr.write(`Sub-hubs recovery UI: ${origin}/#/settings\nVault: ${storage}\n`);
  let captureActive: Promise<void> | undefined;
  const capture = () => {
    if (!captureConfig || captureActive) return;
    captureActive = captureDeployment({ ...captureConfig, storage }).then(snapshot => {
      process.stderr.write(`Full-instance source backup ready: ${snapshot.id}\n`);
    }).catch(() => { process.stderr.write('Full-instance source capture failed; retained backups remain available. Check the deployment configuration.\n'); }).finally(() => { captureActive = undefined; });
  };
  const captureTimer = captureConfig ? setInterval(capture, captureEvery * 1000) : undefined;
  capture();
  await new Promise<void>(resolve => {
    const stop = () => { clearInterval(captureTimer); server.closeAllConnections(); server.close(() => resolve()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
  await captureActive;
}

export async function instanceSubhubCommand(command: string | undefined, args: string[]) {
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP + '\n'); return; }
  if (command === 'serve') return serve(args);
  if (command === 'source') return serve(args, true);
  const storage = path.resolve(required(flag(args, '--storage'), '--storage'));
  if (command === 'run' || command === 'backup') {
    const name = flag(args, '--name') ?? os.hostname();
    const intervalSeconds = Number(flag(args, '--interval') ?? 60);
    const once = command === 'backup' || yes(args, '--once'); remaining(args);
    const config = loadConfig();
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (!once) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    try {
      await runInstanceSubhub({ storage, hub: config.server.replace(/^ws/, 'http'), operatorToken: config.token, name, intervalSeconds, once, signal: controller.signal,
        onStatus: status => process.stderr.write(`Sub-hub ${status.state}; ${status.snapshots} retained full-instance backups${status.error ? '. ' + status.error : ''}\n`),
      });
    } finally { if (!once) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } }
    return;
  }
  if (command === 'capture') {
    const containers = repeated(args, '--container');
    if (!containers.length) throw new Error('Choose every deployment service with --container, including the Spacehub server');
    const allowStop = yes(args, '--allow-stop'); remaining(args);
    print(await captureDeployment({ containers, storage, allowStop })); return;
  }
  const vault = new InstanceVault(storage); vault.initialize();
  if (command === 'snapshots' || command === 'list') { remaining(args); print(vault.list()); return; }
  if (command === 'verify') { const id = required(args.shift(), 'snapshot'); remaining(args); print(await vault.verify(id)); return; }
  if (command === 'restore') {
    const id = required(args.shift(), 'snapshot'), directory = path.resolve(required(args.shift(), 'new directory')); remaining(args);
    print(await vault.restore(id, directory)); return;
  }
  throw new Error(HELP);
}
