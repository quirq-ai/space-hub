import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { InstanceVault } from './instancevault.ts';
import { captureDeployment } from './instancecapture.ts';
import { handleInstanceRecovery } from './instancerecovery.ts';
import { APP_CSP, appDir, appPage, handleApp } from './app';

const HELP = `spacehub subhub backup --container <spacehub> [--container <proxy>] --storage <vault> [--allow-stop]
spacehub subhub snapshots --storage <vault>
spacehub subhub verify <snapshot> --storage <vault>
spacehub subhub restore <snapshot> <new-directory> --storage <vault>
spacehub subhub serve --storage <vault> [--container <spacehub>] [--container <proxy>]
    [--listen 127.0.0.1:4092] [--restore-root <directory>] [--source <hub-name>]
    [--token-file <private-file>]

Sub-hubs back up an entire Spacehub deployment: persistent data, identities,
private configuration, and exact runtime images. Include every service in
the deployment, including its TLS proxy. No --space or project filter.
--allow-stop permits a cold backup's maintenance window; initially running
containers are restarted afterward. Restore writes a new directory only;
it never replaces or starts the running instance.`;

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

async function serve(args: string[]) {
  const storage = path.resolve(required(flag(args, '--storage'), '--storage'));
  const containers = repeated(args, '--container');
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
      if (await handleInstanceRecovery({ vault, authorize: authorized, source, storage, containers, restoreRoot }, req, res, url)) return;
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
  await new Promise<void>(resolve => {
    const stop = () => { server.closeAllConnections(); server.close(() => resolve()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

export async function instanceSubhubCommand(command: string | undefined, args: string[]) {
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP + '\n'); return; }
  if (command === 'serve') return serve(args);
  const storage = path.resolve(required(flag(args, '--storage'), '--storage'));
  if (command === 'backup') {
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
