// The hub's data folder (SPACEHUB_DATA_ROOT, /data in the server image), read
// live while SpacetimeDB runs, for backups kept off the hub: a sub-hub lists
// it and downloads what changed (instanceruntime.ts), so the hub needs no
// disk for copies of its own.
//
// SpacetimeDB keeps each database as an append-only commit log beside its
// snapshots, so a copy taken while it writes is like the state after a
// crash: it starts from the last whole transaction. The commit logs are
// listed and copied last, so they reach at least as far as the snapshots
// before them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

// Not part of a backup: the vault and sub-hub state, logs and caches, the
// running server's pid file, and a volume's own lost+found. A database's
// module logs (what `spacetime logs` shows) are left out too; their folders
// are kept, empty.
export const SKIP = new Set(['.spacehub', 'data/logs', 'data/cache', 'data/spacetime.pid', 'lost+found']);
export const COMMIT_LOG = /^data\/replicas\/[^/]+\/clog$/;
export const MODULE_LOGS = /^data\/replicas\/[^/]+\/module_logs$/;

// `same` names one file for all its names (SpacetimeDB links a snapshot's
// objects into the snapshots after it), so it is copied once.
export interface HubDataFile { path: string; size: number; mode: number; mtimeMs: number; same?: string }
const file = (name: string, stat: fs.Stats): HubDataFile => ({ path: name, size: stat.size, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs, ...(stat.nlink > 1 ? { same: `${stat.dev}:${stat.ino}` } : {}) });
// One part of the data folder as it is now (`at`, the hub's clock): the body
// (everything but the commit logs' files) or the commit logs.
export interface HubDataList { at: number; rootMode: number; directories: { path: string; mode: number }[]; files: HubDataFile[] }

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }

export async function listHubData(root: string, part: 'body' | 'logs'): Promise<HubDataList> {
  const at = Date.now();
  const list: HubDataList = { at, rootMode: (await fsp.lstat(root)).mode & 0o7777, directories: [], files: [] };
  const logs: string[] = [];
  const walk = async (rel: string, take: boolean) => {
    for (const entry of await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP.has(name)) continue;
      if (entry.isDirectory()) {
        const stat = await fsp.lstat(path.join(root, ...name.split('/'))).catch(() => null);
        if (!stat) continue; // deleted as we looked
        if (take) list.directories.push({ path: name, mode: stat.mode & 0o7777 });
        if (COMMIT_LOG.test(name)) logs.push(name);
        else if (!MODULE_LOGS.test(name)) await walk(name, take);
      } else if (entry.isFile()) {
        if (!take) continue;
        const stat = await fsp.lstat(path.join(root, ...name.split('/'))).catch(() => null);
        if (!stat) continue;
        list.files.push(file(name, stat));
      } else {
        fail(409, `the hub's data folder holds something that is not a file or folder: ${name}`);
      }
    }
  };
  await walk('', part === 'body');
  if (part === 'logs') {
    for (const name of logs) {
      for (const entry of await fsp.readdir(path.join(root, ...name.split('/')), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile()) continue;
        const stat = await fsp.lstat(path.join(root, ...name.split('/'), entry.name)).catch(() => null);
        if (stat) list.files.push(file(`${name}/${entry.name}`, stat));
      }
    }
  }
  return list;
}

// One file of the data folder, opened as it is now. A file SpacetimeDB is
// appending to is read up to its size when opened. Only what listHubData
// lists can be opened: no skipped folders, links or special files.
export async function openHubFile(root: string, relative: string): Promise<{ size: number; mtimeMs: number; stream: Readable }> {
  const parts = relative.split('/');
  if (relative.length > 4096 || relative.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) fail(400, 'Choose a file the hub listed');
  for (let i = 1; i <= parts.length; i++) {
    const name = parts.slice(0, i).join('/');
    if (SKIP.has(name) || (i < parts.length && MODULE_LOGS.test(name))) fail(404, 'That file is not part of the hub\'s data');
    const stat = await fsp.lstat(path.join(root, ...parts.slice(0, i))).catch(() => null);
    if (!stat || stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) fail(404, 'No such file in the hub\'s data');
  }
  const handle = await fsp.open(path.join(root, ...parts), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(404, 'No such file in the hub\'s data');
    if (stat.size === 0) { await handle.close(); return { size: 0, mtimeMs: stat.mtimeMs, stream: Readable.from([]) }; }
    return { size: stat.size, mtimeMs: stat.mtimeMs, stream: handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true }) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
