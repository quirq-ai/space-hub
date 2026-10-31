import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { connectTo, snapshot, tables, projectsIn, findProject } from './conn';
import { loadConfig } from './config';
import { hubUrl } from './url';
import { BackupStore } from './subhubbackup.ts';
import { NodeWorkSpool, createSubhubServer } from './subhubserver.ts';
import { SubhubClient, parentWeb } from './subhubclient.ts';
import { DriveStore } from './subhubdrive.ts';

const HELP = `spacehub subhub run --space <space> --storage <directory>
    [--id <node>] [--listen 127.0.0.1:4080] [--advertise https://node.example]
    [--mode backup|drive]
    [--interval 30] [--max-storage-mb 1024] [--max-project-mb 128]
    [--project <space/project>] [--once] [--standalone]
spacehub subhub status|snapshots [project] --storage <directory>
spacehub subhub restore <snapshot> <new-directory> --storage <directory>
spacehub subhub nodes --space <space>
spacehub subhub work submit --space <space> --project <project> --title <text> --text <text> --key <id>
spacehub subhub work list --space <space>
spacehub subhub work claim <id> [--lease 60]
spacehub subhub work complete <id> --fence <number> --result <text>
spacehub subhub work release <id> --fence <number>

Work is stored and queued; this command never executes it.
The parent needs the updated server for registration, queues and routing.
--standalone keeps local backups without parent registration.`;

function flag(args: string[], name: string, fallback?: string) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2); return value;
}
function yes(args: string[], name: string) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
function required(value: string | undefined, label: string) { if (!value) throw new Error(`${label} is required`); return value; }
function number(value: string | undefined, label: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const n = Number(value); if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`Invalid ${label}`); return n;
}
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
function save(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
function nodeRoot(directory: string) {
  const root = path.resolve(directory);
  if (root === path.parse(root).root) throw new Error('Choose a dedicated node storage directory');
  for (let current = root; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Node storage cannot use symlinks/junctions');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, '.spacehub-node.json');
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw new Error('Refusing an unrelated non-empty node storage directory');
    save(marker, { version: 1 });
  }
  if (fs.lstatSync(marker).isSymbolicLink() || JSON.parse(fs.readFileSync(marker, 'utf8')).version !== 1) throw new Error('Invalid node storage marker');
  return root;
}
function nodeLock(root: string) {
  const filename = path.join(root, '.node.lock');
  const nonce = crypto.randomUUID();
  try { fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('Node storage is locked. Ensure its previous process is stopped before removing .node.lock'); }
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename); } catch { /* Never remove another process lock. */ }
  };
  process.once('exit', release);
  return () => { release(); process.removeListener('exit', release); };
}
function usedBytes(root: string): number {
  let used = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in node storage');
    used += entry.isDirectory() ? usedBytes(file) : fs.statSync(file).size;
  }
  return used;
}

async function runNode(args: string[]) {
  const storage = required(flag(args, '--storage'), '--storage');
  const space = required(flag(args, '--space'), '--space').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(space)) throw new Error('Invalid space');
  const id = flag(args, '--id', os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63))!;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid node id');
  const listen = flag(args, '--listen', '127.0.0.1:4080')!;
  const address = /^([^:]+):(\d+)$/.exec(listen);
  if (!address) throw new Error('--listen must be host:port');
  const port = number(address[2], 'port', 1, 65535);
  const advertise = flag(args, '--advertise');
  const requestedMode = flag(args, '--mode');
  if (requestedMode !== undefined && requestedMode !== 'backup' && requestedMode !== 'drive') throw new Error('--mode must be backup or drive');
  const interval = number(flag(args, '--interval', '30'), 'interval', 5, 3600) * 1000;
  const maxBytes = number(flag(args, '--max-storage-mb', '1024'), 'storage limit') * 1024 * 1024;
  const maxProjectBytes = number(flag(args, '--max-project-mb', '128'), 'project limit') * 1024 * 1024;
  const project = flag(args, '--project');
  if (project && (!project.startsWith(space + '/') || project.split('/').length !== 2)) throw new Error('--project must belong to --space');
  const once = yes(args, '--once');
  const standalone = yes(args, '--standalone');
  if (args.length) throw new Error(`Unknown sub-hub arguments: ${args.join(' ')}`);
  const cfg = loadConfig();
  const owner = new SubhubClient(cfg.server, cfg.token ?? '');
  if (!standalone) {
    if (!cfg.token) throw new Error('Run spacehub auth login before registering a sub-hub');
    await owner.protocol(requestedMode === 'drive' ? 'active-drive' : undefined);
  }
  const root = nodeRoot(storage);
  const releaseLock = nodeLock(root);
  const configPath = path.join(root, 'node.json');
  let config: { id: string; space: string; server: string; token: string; url?: string; capacityBytes: number; standalone: boolean; mode?: 'backup' | 'drive'; enabled?: boolean };
  if (fs.existsSync(configPath)) {
    if (fs.lstatSync(configPath).isSymbolicLink()) throw new Error('Node configuration must be a regular file');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.id !== id || config.space !== space || config.server !== parentWeb(cfg.server) || config.url !== advertise || config.capacityBytes !== maxBytes || config.standalone !== standalone) throw new Error('Existing node configuration differs; use original flags/mode or a new storage directory');
  } else {
    const registered = standalone ? { token: crypto.randomBytes(32).toString('hex') } : await owner.request('POST', '/nodes/register', { id, space, url: advertise, capacityBytes: maxBytes, mode: requestedMode ?? 'backup' });
    config = { id, space, server: parentWeb(cfg.server), token: registered.token, url: advertise, capacityBytes: maxBytes, standalone,
      mode: registered.node?.mode ?? requestedMode ?? 'backup', enabled: registered.node?.enabled !== false };
    save(configPath, config);
  }
  let mode: 'backup' | 'drive' = config.mode ?? 'backup';
  let enabled = config.enabled !== false;
  if (standalone && requestedMode) mode = requestedMode;
  // For existing registered nodes the parent owns mode and pause settings.
  // Reusing the original startup command must not revert UI changes.
  if (!standalone && mode === 'drive') await owner.protocol('active-drive');
  const client = new SubhubClient(cfg.server, config.token);
  const available = () => {
    const disk = fs.statfsSync(root);
    return Math.max(0, Math.min(maxBytes - usedBytes(root), Number(disk.bavail) * Number(disk.bsize)));
  };
  const backupDir = path.join(root, 'backup');
  const backup = new BackupStore(backupDir, { maxBytes, maxProjectBytes, externalUsageBytes: () => Math.max(0, usedBytes(root) - usedBytes(backupDir)) });
  backup.initialize();
  const drive = new DriveStore(path.join(root, 'drive'), { availableBytes: available });
  drive.initialize();
  const spool = new NodeWorkSpool(path.join(root, 'work'));
  const server = createSubhubServer({ nodeId: id, space, token: config.token, storageDir: path.join(root, 'work'), backupRoot: backupDir, backup, availableBytes: available, drive, mode: () => enabled ? mode : 'backup' });
  let conn: Awaited<ReturnType<typeof connectTo>>['conn'] | null = null;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (!once) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, address[1], resolve); });
  const statusPath = path.join(root, 'status.json');
  const log = (text: string) => process.stderr.write(`subhub ${id}: ${text}\n`);
  let polling = false;
  let parentError: string | null = null;
  let backupErrors: string[] = [];
  const syncParent = async () => {
    if (standalone || stopping || polling) return;
    polling = true;
    try {
      // Keep the catalog below the parent's 256 KiB JSON body limit even
      // with maximum-length project names. Unadvertised snapshots stay local.
      const heartbeat = await client.request('POST', `/nodes/${id}/heartbeat`, { freeBytes: available(), backups: backup.list().filter(s => !!s.oid).slice(0, 500).map(s => ({ project: s.project, oid: s.oid, snapshot: s.id, bytes: s.bytes })), drive: drive.stats(), status: backupErrors.length ? 'degraded' : 'ready', errors: backupErrors.slice(0, 10).map(error => error.slice(0, 500)) });
      if (heartbeat.node.mode === 'backup' || heartbeat.node.mode === 'drive') mode = heartbeat.node.mode;
      enabled = heartbeat.node.enabled !== false;
      if (config.mode !== mode || config.enabled !== enabled) { config.mode = mode; config.enabled = enabled; save(configPath, config); }
      const assignments = await client.request('GET', `/nodes/${id}/work`);
      const ids: string[] = [];
      let remaining = available();
      for (const work of assignments.work) {
        const input = { id: work.id, space: work.space, project: work.project, title: work.title, text: work.text, actor: work.actor, createdAt: work.createdAt, idempotencyKey: work.idempotencyKey };
        const needed = Buffer.byteLength(JSON.stringify(input)) * 2 + 1024;
        if (!spool.get(work.id) && needed > remaining) break;
        if (!spool.get(work.id)) remaining -= needed;
        spool.put(input); ids.push(work.id);
      }
      for (let index = 0; index < ids.length; index += 1000) await client.request('POST', `/nodes/${id}/receipt`, { ids: ids.slice(index, index + 1000) });
      parentError = null;
    } catch (error: any) { parentError = error.message; log(`parent: ${parentError}`); }
    finally { polling = false; }
  };
  await syncParent();
  const parentTimer = setInterval(() => { void syncParent(); }, 20_000);
  try {
    log(`storage ${root}${once ? '' : `; listening at http://${listen}`}${standalone ? '; standalone' : '; parent registered'}`);
    while (!stopping) {
      const errors: string[] = [];
      try {
        if (enabled && mode === 'backup') {
          if (!conn?.isActive) conn = (await connectTo(cfg.server, cfg.database, cfg.token, { reconnect: true })).conn;
          const rows = (await projectsIn(conn!, space)).filter(row => !project || row.fullName === project);
          if (project && rows.length === 0) throw new Error(`No project named ${project}`);
          const sizes = await snapshot(conn!, tables.projectSize, () => new Map([...conn!.db.projectSize.iter()].map(row => [row.projectId.toString(), Number(row.bytes)])));
          for (const row of rows) {
            if (stopping || !enabled || mode !== 'backup') break;
            try {
              await backup.backup({
                fullName: row.fullName, id: row.id, createdAt: new Date(Number(row.createdAt.microsSinceUnixEpoch / 1000n)).toISOString(), defaultBranch: row.defaultBranch,
                sourceUrl: hubUrl(cfg.server, row.fullName), estimatedBytes: sizes.get(row.id.toString()),
                verifyIdentity: async () => { const current = await findProject(conn!, row.fullName); return !!current && current.id === row.id && current.createdAt.microsSinceUnixEpoch === row.createdAt.microsSinceUnixEpoch; },
              }, { SPACEHUB_SERVER: cfg.server, SPACEHUB_DB: cfg.database, ...(cfg.token ? { SPACEHUB_TOKEN: cfg.token } : {}) });
            } catch (error: any) { errors.push(`${row.fullName}: ${error.message}`); }
          }
        }
      } catch (error: any) { errors.push(error.message); }
      backupErrors = errors.slice();
      await syncParent();
      if (parentError) errors.push(`parent: ${parentError}`);
      save(statusPath, { id, space, mode, enabled, drive: drive.stats(), status: errors.length ? 'degraded' : 'ready', checkedAt: new Date().toISOString(), snapshots: backup.list().length, queuedCopies: spool.list().length, standalone, serving: server.listening, pid: process.pid, listen, errors });
      for (const error of errors) log(error);
      if (once) { if (errors.length) throw new Error('Some backups failed; see status. Retained snapshots are preserved.'); break; }
      const until = Date.now() + interval;
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    clearInterval(parentTimer);
    stopping = true;
    while (polling) await new Promise(resolve => setTimeout(resolve, 50));
    conn?.disconnect();
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    releaseLock();
  }
}

export async function subhubCommand(command: string | undefined, args: string[]) {
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP + '\n'); return; }
  if (command === 'run') return runNode(args);
  if (['status', 'snapshots', 'restore'].includes(command)) {
    const root = path.resolve(required(flag(args, '--storage'), '--storage'));
    if (!fs.existsSync(path.join(root, '.spacehub-node.json'))) throw new Error('No sub-hub storage at this location');
    if (command === 'status') { print(JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'))); return; }
    const backups = new BackupStore(path.join(root, 'backup'));
    if (command === 'snapshots') { print(backups.list(args[0])); return; }
    print(await backups.restore(required(args[0], 'snapshot'), path.resolve(required(args[1], 'new directory')))); return;
  }
  const cfg = loadConfig();
  if (!cfg.token) throw new Error('Run spacehub auth login first');
  const client = new SubhubClient(cfg.server, cfg.token);
  if (command === 'nodes') { print(await client.request('GET', '/nodes?' + new URLSearchParams({ space: required(flag(args, '--space'), '--space') }))); return; }
  if (command === 'work') {
    const action = args.shift();
    if (action === 'submit') {
      const input = { space: required(flag(args, '--space'), '--space'), project: required(flag(args, '--project'), '--project'), title: required(flag(args, '--title'), '--title'), text: required(flag(args, '--text'), '--text') };
      print(await client.request('POST', '/work', input, required(flag(args, '--key'), '--key'))); return;
    }
    if (action === 'list') { print(await client.request('GET', '/work?' + new URLSearchParams({ space: required(flag(args, '--space'), '--space') }))); return; }
    const lease = flag(args, '--lease', '60');
    const fence = flag(args, '--fence');
    const result = flag(args, '--result', '');
    const id = required(args.shift(), 'work id');
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('Invalid work id');
    if (action === 'claim') { print(await client.request('POST', `/work/${id}/claim`, { leaseSeconds: number(lease, 'lease', 1, 300) })); return; }
    if (action === 'complete' || action === 'release') { print(await client.request('POST', `/work/${id}/${action}`, { fence: number(fence, 'fence'), result })); return; }
  }
  throw new Error(HELP);
}
