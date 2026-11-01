// Optionally, the hub also keeps backups of itself on its own disk, with no
// downtime: on a schedule the web service copies the hub's data folder
// (SPACEHUB_DATA_ROOT, /data in the server image) while SpacetimeDB runs, and
// keeps the newest copies in a vault that connected sub-hubs copy too
// (instanceruntime.ts). Off by default: backups are kept off the hub, by
// sub-hubs that copy its data folder live (hubdata.ts).
//
// SpacetimeDB keeps each database as an append-only commit log beside its
// snapshots, so a copy taken while it writes is like the state after a
// crash: it starts from the last whole transaction. The commit logs are
// copied last, so they reach at least as far as the snapshots before them.
//
//   SPACEHUB_BACKUP_MINUTES  how often, in minutes (default 0: never)
//   SPACEHUB_BACKUP_KEEP     how many backups the hub keeps (default 3)
//   SPACEHUB_BACKUP_DIR      the vault (default <data root>/.spacehub/backups)
//
// A backup is hub.json plus data/, the data folder as it was: restored, that
// folder is the hub's /data again (run the same image with it mounted).
//
// Backups are incremental on disk: a file unchanged since the last backup is
// that backup's copy, shared (a hard link), so only what changed is copied
// and the hub needs room for that, not for its whole data again.
//
// The last attempt, and why it failed, is kept beside the vault
// (last-backup.json) and shown to operators in Settings, since a failure
// otherwise only reaches the server's log.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { COMMIT_LOG, MODULE_LOGS, SKIP } from './hubdata.ts';
import { canonicalPath, InstanceVault, MAX_INSTANCE_FILES, type ManifestFile, type ReusedFile, type Snapshot } from './instancevault.ts';

export interface HubBackupConfig {
  root: string; // the data folder
  vault: InstanceVault;
  everyMs: number;
  keep: number;
  source: string; // the hub, as backups name it
}

// What a backup leaves out is hubdata.ts's SKIP and MODULE_LOGS.
// What a backup leaves free on the hub's disk, for the hub itself.
const SPARE = 1024 ** 3;
// How long before the last backup began a file must have last changed for
// that backup's copy of it to be used again (coarse file times).
export const SETTLED_MS = 2_000;

export function hubBackupConfig(env: NodeJS.ProcessEnv = process.env, source = 'spacehub'): HubBackupConfig | null {
  const root = (env.SPACEHUB_DATA_ROOT ?? '').trim();
  const minutes = Number(env.SPACEHUB_BACKUP_MINUTES ?? 0);
  if (!root || minutes === 0) return null;
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 24 * 60) throw new Error('SPACEHUB_BACKUP_MINUTES must be 0 (off) or 5 to 10080');
  const keep = Number(env.SPACEHUB_BACKUP_KEEP ?? 3);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('SPACEHUB_BACKUP_KEEP must be 1 to 100');
  const data = canonicalPath(root);
  const vault = new InstanceVault(canonicalPath(env.SPACEHUB_BACKUP_DIR?.trim() || path.join(data, '.spacehub', 'backups')));
  return { root: data, vault, everyMs: minutes * 60_000, keep, source };
}

// The last backup, to take unchanged files from: a file whose size and mode
// are the same and that last changed before that backup began is the same.
interface Earlier { id: string; at: number; files: Map<string, ManifestFile> }

// One pass over (part of) the data folder: the folders, and for each file
// whether it is copied or taken from the earlier backup. Names of one file
// (SpacetimeDB links snapshot objects) are copied once and linked.
interface Plan { dirs: string[]; copy: { name: string; key: string }[]; reuse: ReusedFile[]; logs: string[]; bytes: number; copyBytes: number; seen: Set<string> }

async function plan(root: string, rel: string, earlier: Earlier | null, into: Plan) {
  for (const entry of await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP.has(name)) continue;
    if (entry.isDirectory()) {
      into.dirs.push(name);
      if (COMMIT_LOG.test(name)) into.logs.push(name);
      else if (!MODULE_LOGS.test(name)) await plan(root, name, earlier, into);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(path.join(root, ...name.split('/'))).catch(() => null);
      if (!stat) continue; // deleted as we looked
      const key = `${stat.dev}:${stat.ino}`;
      const first = !into.seen.has(key);
      into.seen.add(key);
      if (first) into.bytes += stat.size;
      const before = earlier?.files.get(`data/${name}`);
      const mode = stat.mode & 0o7777;
      if (before && before.size === stat.size && before.mode === mode && stat.mtimeMs < earlier!.at - SETTLED_MS) {
        into.reuse.push({ path: `data/${name}`, snapshot: earlier!.id, from: before.path, mode });
      } else {
        into.copy.push({ name, key });
        if (first) into.copyBytes += stat.size;
      }
    } else {
      throw new Error(`the hub's data folder holds something that is not a file or folder: ${name}`);
    }
  }
}
const newPlan = (): Plan => ({ dirs: [], copy: [], reuse: [], logs: [], bytes: 0, copyBytes: 0, seen: new Set() });

// Copy the planned files into the staging folder. A file SpacetimeDB deletes
// while we copy is left out; a second name of a copied file is a link to it.
async function copyPlanned(root: string, to: string, files: Plan['copy']) {
  const copied = new Map<string, string>();
  for (const { name, key } of files) {
    const source = path.join(root, ...name.split('/'));
    const target = path.join(to, ...name.split('/'));
    const first = copied.get(key);
    try {
      if (first) await fsp.link(first, target);
      else {
        await fsp.copyFile(source, target);
        copied.set(key, target);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * One backup now: copy what changed in the data folder since the last backup,
 * keep the rest as that backup has it, keep the result in the vault, then
 * drop the oldest past `keep`. `copied` is how much was copied.
 */
export async function backupHub(cfg: HubBackupConfig, now = Date.now()): Promise<Snapshot & { copied: number }> {
  cfg.vault.initialize();
  const last = cfg.vault.list().find(s => s.consistency === 'live-copy');
  const earlier: Earlier | null = last ? { id: last.id, at: last.createdAt, files: new Map(cfg.vault.describe(last.id, MAX_INSTANCE_FILES).files.map(f => [f.path, f])) } : null;
  // Everything but the commit logs, which are copied last so they reach at
  // least as far as the snapshots before them; measured now, with the logs.
  const body = newPlan();
  await plan(cfg.root, '', earlier, body);
  const estimate = newPlan();
  estimate.seen = new Set(body.seen);
  for (const name of body.logs) await plan(cfg.root, name, earlier, estimate);
  const bytes = body.bytes + estimate.bytes, copy = body.copyBytes + estimate.copyBytes;
  const stat = await fsp.statfs(cfg.vault.storageDir);
  const free = stat.bavail * stat.bsize;
  const mb = (n: number) => Math.ceil(n / 1024 ** 2);
  if (free < copy + SPARE) throw new Error(`not enough free disk: this backup copies ${mb(copy)} MB of the ${mb(bytes)} MB of data${earlier ? ' (the rest is unchanged since the last backup)' : ''} and leaves ${mb(SPARE)} MB spare, and ${mb(free)} MB is free`);
  const staging = path.join(path.dirname(cfg.vault.storageDir), `backup-staging-${now}`);
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true, mode: 0o700 });
  try {
    const data = path.join(staging, 'data');
    for (const name of body.dirs) await fsp.mkdir(path.join(data, ...name.split('/')), { mode: 0o700 });
    await copyPlanned(cfg.root, data, body.copy);
    const logs = newPlan();
    for (const name of body.logs) await plan(cfg.root, name, earlier, logs);
    for (const name of logs.dirs) await fsp.mkdir(path.join(data, ...name.split('/')), { mode: 0o700 });
    await copyPlanned(cfg.root, data, logs.copy);
    fs.writeFileSync(
      path.join(staging, 'hub.json'),
      JSON.stringify({ kind: 'spacehub-hub-data', version: 1, createdAt: now, source: cfg.source, restore: 'Mount data/ as /data and start the same spacehub server image.' }, null, 2) + '\n',
      { mode: 0o600 }
    );
    const snapshot = await cfg.vault.capture(staging, { source: cfg.source, services: ['spacehub'], consistency: 'live-copy', coverage: { data: true, runtime: false, configuration: false }, createdAt: now }, { adopt: true, reuse: [...body.reuse, ...logs.reuse] });
    const old = cfg.vault.list().filter(s => s.consistency === 'live-copy').slice(cfg.keep);
    for (const s of old) await cfg.vault.remove(s.id);
    return { ...snapshot, copied: body.copyBytes + logs.copyBytes };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

export interface HubBackupResult { at: number; ms: number; ok: boolean; snapshot?: string; bytes?: number; copied?: number; error?: string }
export interface HubBackupState { everyMinutes: number; keep: number; running: boolean; startedAt?: number; nextAt: number; last?: HubBackupResult }
export interface HubBackups { state(): HubBackupState; now(): boolean; stop(): void }

const FIRST_MS = 60_000;

function readLast(file: string): HubBackupResult | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value.at === 'number' && typeof value.ok === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Back up a minute after start, then every `everyMs`, one at a time; `now()`
 * starts one at once unless one is running. Each result is kept beside the
 * vault, so the last one is known after a restart too.
 */
export function startHubBackups(cfg: HubBackupConfig, log: (line: string) => void = line => process.stderr.write(`${line}\n`), firstMs = FIRST_MS): HubBackups {
  const lastFile = path.join(path.dirname(cfg.vault.storageDir), 'last-backup.json');
  let last = readLast(lastFile);
  let startedAt: number | undefined;
  const run = async () => {
    if (startedAt !== undefined) return;
    const at = (startedAt = Date.now());
    try {
      const s = await backupHub(cfg, at);
      last = { at, ms: Date.now() - at, ok: true, snapshot: s.id, bytes: s.bytes, copied: s.copied };
      log(`spacehub-web: backed up the hub: ${s.id} (${Math.ceil(s.bytes / 1024 ** 2)} MB, ${Math.ceil(s.copied / 1024 ** 2)} MB of it copied, keeping ${cfg.keep})`);
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      last = { at, ms: Date.now() - at, ok: false, error };
      log(`spacehub-web: hub backup failed, earlier backups are kept: ${error}`);
    } finally {
      startedAt = undefined;
      try {
        fs.writeFileSync(lastFile, JSON.stringify(last) + '\n', { mode: 0o600 });
      } catch (err) {
        log(`spacehub-web: could not keep the last backup's result: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  let nextAt = Date.now() + firstMs;
  const tick = () => {
    nextAt = Date.now() + cfg.everyMs;
    timer = setTimeout(tick, cfg.everyMs);
    timer.unref();
    void run();
  };
  let timer = setTimeout(tick, firstMs);
  timer.unref();
  return {
    state: () => ({ everyMinutes: cfg.everyMs / 60_000, keep: cfg.keep, running: startedAt !== undefined, ...(startedAt !== undefined ? { startedAt } : {}), nextAt, ...(last ? { last } : {}) }),
    now: () => {
      if (startedAt !== undefined) return false;
      void run();
      return true;
    },
    stop: () => clearTimeout(timer),
  };
}
