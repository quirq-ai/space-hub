// The hub backs itself up, with no downtime: on a schedule the web service
// copies the hub's data folder (SPACEHUB_DATA_ROOT, /data in the server
// image) while SpacetimeDB runs, and keeps the newest copies in a vault that
// connected sub-hubs copy off the machine (instanceruntime.ts).
//
// SpacetimeDB keeps each database as an append-only commit log beside its
// snapshots, so a copy taken while it writes is like the state after a
// crash: it starts from the last whole transaction. The commit logs are
// copied last, so they reach at least as far as the snapshots before them.
//
//   SPACEHUB_BACKUP_MINUTES  how often, in minutes (default 60; 0: never)
//   SPACEHUB_BACKUP_KEEP     how many backups the hub keeps (default 3)
//   SPACEHUB_BACKUP_DIR      the vault (default <data root>/.spacehub/backups)
//
// A backup is hub.json plus data/, the data folder as it was: restored, that
// folder is the hub's /data again (run the same image with it mounted).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, InstanceVault, type Snapshot } from './instancevault.ts';

export interface HubBackupConfig {
  root: string; // the data folder
  vault: InstanceVault;
  everyMs: number;
  keep: number;
  source: string; // the hub, as backups name it
}

// Not part of a backup: the vault and sub-hub state, logs and caches, and
// the running server's pid file.
const SKIP = new Set(['.spacehub', 'data/logs', 'data/cache', 'data/spacetime.pid']);
const COMMIT_LOG = /^data\/replicas\/[^/]+\/clog$/;

export function hubBackupConfig(env: NodeJS.ProcessEnv = process.env, source = 'spacehub'): HubBackupConfig | null {
  const root = (env.SPACEHUB_DATA_ROOT ?? '').trim();
  const minutes = Number(env.SPACEHUB_BACKUP_MINUTES ?? 60);
  if (!root || minutes === 0) return null;
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 24 * 60) throw new Error('SPACEHUB_BACKUP_MINUTES must be 0 (off) or 5 to 10080');
  const keep = Number(env.SPACEHUB_BACKUP_KEEP ?? 3);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('SPACEHUB_BACKUP_KEEP must be 1 to 100');
  const data = canonicalPath(root);
  const vault = new InstanceVault(canonicalPath(env.SPACEHUB_BACKUP_DIR?.trim() || path.join(data, '.spacehub', 'backups')));
  return { root: data, vault, everyMs: minutes * 60_000, keep, source };
}

// Copy `from` into `to`, deferring each commit log until everything else is
// copied. A file SpacetimeDB deletes while we copy is left out. Asynchronous,
// so the web service keeps answering while a big folder copies.
async function copyTree(from: string, to: string, rel: string, logs: string[]) {
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP.has(name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (COMMIT_LOG.test(name)) {
        logs.push(name);
        continue;
      }
      await fsp.mkdir(target, { mode: 0o700 });
      await copyTree(source, target, name, logs);
    } else if (entry.isFile()) {
      try {
        await fsp.copyFile(source, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } else {
      throw new Error(`the hub's data folder holds something that is not a file or folder: ${name}`);
    }
  }
}

async function bytesOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await bytesOf(at);
    else if (entry.isFile()) total += (await fsp.stat(at).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** One backup now: copy the data folder, keep it in the vault, then drop the oldest past `keep`. */
export async function backupHub(cfg: HubBackupConfig, now = Date.now()): Promise<Snapshot> {
  cfg.vault.initialize();
  // Room for the copy and its place in the vault, with some to spare.
  const need = (await bytesOf(cfg.root)) * 2 + 256 * 1024 ** 2;
  const free = await fsp.statfs(cfg.vault.storageDir);
  if (free.bavail * free.bsize < need) throw new Error(`not enough free disk for a backup (${Math.ceil(need / 1024 ** 2)} MB needed)`);
  const staging = path.join(path.dirname(cfg.vault.storageDir), `backup-staging-${now}`);
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true, mode: 0o700 });
  try {
    const logs: string[] = [];
    await copyTree(cfg.root, path.join(staging, 'data'), '', logs);
    for (const name of logs) {
      const target = path.join(staging, 'data', ...name.split('/'));
      await fsp.mkdir(target, { mode: 0o700 });
      await copyTree(path.join(cfg.root, ...name.split('/')), target, name, []);
    }
    fs.writeFileSync(
      path.join(staging, 'hub.json'),
      JSON.stringify({ kind: 'spacehub-hub-data', version: 1, createdAt: now, source: cfg.source, restore: 'Mount data/ as /data and start the same spacehub server image.' }, null, 2) + '\n',
      { mode: 0o600 }
    );
    const snapshot = await cfg.vault.capture(staging, { source: cfg.source, services: ['spacehub'], consistency: 'live-copy', coverage: { data: true, runtime: false, configuration: false }, createdAt: now });
    const old = cfg.vault.list().filter(s => s.consistency === 'live-copy').slice(cfg.keep);
    for (const s of old) await cfg.vault.remove(s.id);
    return snapshot;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/** Back up a minute after start, then every `everyMs`, one at a time. Returns a stop function. */
export function startHubBackups(cfg: HubBackupConfig, log: (line: string) => void = line => process.stderr.write(`${line}\n`)) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const s = await backupHub(cfg);
      log(`spacehub-web: backed up the hub: ${s.id} (${Math.ceil(s.bytes / 1024 ** 2)} MB, keeping ${cfg.keep})`);
    } catch (err) {
      log(`spacehub-web: hub backup failed, earlier backups are kept: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, cfg.everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
