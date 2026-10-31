// A connected Sub-hub copies already-complete instance snapshots. Creating a
// consistent source backup is a separate server concern, never a client guess.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { InstanceVault, MAX_INSTANCE_FILES, type Snapshot, type TransferManifest } from './instancevault.ts';

const PREFIX = '/-/api/instance-recovery';
const MARKER = '.spacehub-instance-runtime.json';
const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_JSON = 64 * 1024 ** 2;
const MAX_INDEX = 4 * 1024 ** 2;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export type InstanceRuntimeState = 'waiting' | 'syncing' | 'up-to-date' | 'error';
export interface InstanceRuntimeStatus { state: InstanceRuntimeState; snapshots: number; error?: string }
export interface InstanceRuntimeOptions {
  storage: string; hub: string; operatorToken?: string; name?: string; intervalSeconds?: number;
  once?: boolean; signal?: AbortSignal; onStatus?(status: InstanceRuntimeStatus): void;
}
export interface InstanceRuntimeDeps { fetch?: typeof fetch; heartbeatIntervalMs?: number }
interface Connection { version: 1; hub: string; storage: string; id: string; token: string; name: string; registered: boolean }
class RuntimeAccessError extends Error {}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const permissions = (value: unknown): value is number => integer(value) && value <= 0o7777;
function refuse(message: string): never { throw new Error(message); }
function exists(filename: string) { try { return fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function noLinks(filename: string) {
  for (let at = path.resolve(filename); ; at = path.dirname(at)) {
    if (exists(at)?.isSymbolicLink()) refuse('Sub-hub runtime storage cannot use links');
    if (path.dirname(at) === at) return;
  }
}
function syncDirectory(filename: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJson(filename: string, value: unknown) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateJson(filename: string, limit = 8192): unknown {
  noLinks(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > limit) refuse('Invalid private Sub-hub runtime state');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function hubAddress(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { return refuse('Choose an HTTPS hub URL or loopback HTTP URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) refuse('Choose an HTTPS hub URL or loopback HTTP URL without credentials or a path');
  return url.origin;
}
function bundlePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) refuse('The source returned an invalid instance manifest');
  return value;
}
function snapshot(value: unknown): Snapshot {
  if (!isObject(value) || !ID.test(String(value.id)) || !integer(value.createdAt) || value.scope !== 'instance' || value.consistency !== 'stopped-containers' || !isObject(value.coverage) || value.coverage.data !== true || value.coverage.runtime !== true || value.coverage.configuration !== true || typeof value.source !== 'string' || !value.source.trim() || value.source.length > 1024 || /[\x00-\x1f\x7f]/.test(value.source) || !Array.isArray(value.services) || !value.services.length || value.services.length > 256 || value.services.some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item)) || !integer(value.files) || value.files > MAX_INSTANCE_FILES || !integer(value.bytes) || !TOKEN.test(String(value.sha256))) refuse('The source returned invalid instance snapshot metadata');
  return { id: value.id as string, createdAt: value.createdAt, source: value.source, services: [...value.services] as string[], scope: 'instance', consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true }, files: value.files, bytes: value.bytes, sha256: value.sha256 as string };
}
function transferManifest(value: unknown, expected: Snapshot, quota: number): TransferManifest {
  if (!isObject(value) || value.version !== 1 || !permissions(value.rootMode) || !Array.isArray(value.directories) || value.directories.length > MAX_INSTANCE_FILES || !Array.isArray(value.files) || value.files.length > MAX_INSTANCE_FILES) refuse('The source returned an invalid instance manifest');
  const details = snapshot(value.snapshot);
  if (JSON.stringify(details) !== JSON.stringify(expected) || details.bytes > quota) refuse('The instance manifest does not match its advertised snapshot or storage limit');
  const paths = new Set<string>();
  const entryPath = (value: unknown) => { const valid = bundlePath(value); if (paths.has(valid)) refuse('The source returned duplicate instance paths'); paths.add(valid); return valid; };
  const directories = value.directories.map(item => {
    if (!isObject(item) || !permissions(item.mode)) return refuse('The source returned an invalid instance directory');
    return { path: entryPath(item.path), mode: item.mode };
  });
  let bytes = 0;
  const files = value.files.map(item => {
    if (!isObject(item) || !permissions(item.mode) || !integer(item.size) || !TOKEN.test(String(item.sha256))) return refuse('The source returned an invalid instance file');
    bytes += item.size;
    if (!Number.isSafeInteger(bytes) || bytes > quota) refuse('The source instance exceeds the storage limit');
    return { path: entryPath(item.path), mode: item.mode, size: item.size, sha256: item.sha256 as string };
  });
  const parents = new Set(directories.map(item => item.path));
  for (const item of [...directories, ...files]) {
    const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    if (parent && !parents.has(parent)) refuse('The source returned an incomplete instance directory tree');
  }
  if (files.length !== details.files || bytes !== details.bytes) refuse('The source returned inconsistent instance sizes');
  return { version: 1, snapshot: details, rootMode: value.rootMode, directories, files };
}
function runtimeDirectory(storage: string) {
  const root = storage + '.runtime'; noLinks(root);
  const stat = exists(root);
  if (stat && !stat.isDirectory()) refuse('Choose a dedicated private Sub-hub runtime directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, MARKER);
  if (!exists(marker)) {
    if (fs.readdirSync(root).length) refuse('Sub-hub runtime storage contains unrelated data');
    writeJson(marker, { kind: 'spacehub-instance-runtime', version: 1 });
  }
  const marked = privateJson(marker);
  if (!isObject(marked) || marked.kind !== 'spacehub-instance-runtime' || marked.version !== 1) refuse('Invalid Sub-hub runtime storage marker');
  for (const name of fs.readdirSync(root)) {
    if (![MARKER, 'connection.json', '.writer.lock', 'staging'].includes(name) && !/^\.connection-[a-f0-9]{32}\.tmp$/.test(name)) refuse('Sub-hub runtime storage contains unrelated data');
    noLinks(path.join(root, name));
  }
  const staging = path.join(root, 'staging');
  if (exists(staging) && !exists(staging)!.isDirectory()) refuse('Invalid private Sub-hub staging directory');
  fs.mkdirSync(staging, { mode: 0o700, recursive: true }); syncDirectory(root);
  return root;
}
function runtimeLock(root: string) {
  const filename = path.join(root, '.writer.lock');
  if (exists(filename)) {
    const previous = privateJson(filename);
    if (!isObject(previous) || !integer(previous.pid) || !previous.pid) refuse('Invalid Sub-hub runtime lock; inspect it before removal');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (alive) refuse('This Sub-hub storage already has a running connection');
    fs.unlinkSync(filename);
  }
  const nonce = crypto.randomBytes(16).toString('hex'); writeJson(filename, { pid: process.pid, nonce }); syncDirectory(root);
  return () => {
    const current = privateJson(filename);
    if (!isObject(current) || current.pid !== process.pid || current.nonce !== nonce) refuse('Sub-hub runtime lock ownership changed');
    fs.unlinkSync(filename); syncDirectory(root);
  };
}
function saveConnection(root: string, connection: Connection) {
  const temporary = path.join(root, `.connection-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try { writeJson(temporary, connection); fs.renameSync(temporary, path.join(root, 'connection.json')); syncDirectory(root); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function machineLabel(value: string) {
  const label = value.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(label)) refuse('Use a Sub-hub name of 1–80 letters, numbers, spaces, dots, underscores or hyphens');
  return label;
}
function connectionOf(root: string, hub: string, storage: string, name?: string): Connection {
  const filename = path.join(root, 'connection.json');
  if (exists(filename)) {
    const value = privateJson(filename);
    if (!isObject(value) || value.version !== 1 || typeof value.hub !== 'string' || typeof value.storage !== 'string' || !ID.test(String(value.id)) || !TOKEN.test(String(value.token)) || typeof value.name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(value.name) || typeof value.registered !== 'boolean') refuse('Invalid saved Sub-hub connection');
    if (value.hub !== hub || value.storage !== storage) refuse('This Sub-hub storage is already bound to another hub or storage location');
    return value as unknown as Connection;
  }
  const label = machineLabel(name ?? os.hostname());
  const made: Connection = { version: 1, hub, storage, name: label, id: crypto.randomBytes(16).toString('hex'), token: crypto.randomBytes(32).toString('hex'), registered: false };
  saveConnection(root, made); return made;
}
function wait(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runInstanceSubhub(options: InstanceRuntimeOptions, deps: InstanceRuntimeDeps = {}): Promise<void> {
  const hub = hubAddress(options.hub);
  if (options.name !== undefined) machineLabel(options.name);
  if (!path.isAbsolute(options.storage)) refuse('Choose an absolute dedicated Sub-hub storage directory');
  const storage = path.resolve(options.storage);
  const interval = options.intervalSeconds ?? 60;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86400) refuse('Sub-hub interval must be between 1 and 86400 seconds');
  const heartbeatInterval = deps.heartbeatIntervalMs ?? 10_000;
  if (!Number.isSafeInteger(heartbeatInterval) || heartbeatInterval < 1 || heartbeatInterval > 15_000) refuse('Invalid Sub-hub heartbeat interval');
  const vault = new InstanceVault(storage);
  let runtime: string, unlock: () => void, connection: Connection;
  try { runtime = runtimeDirectory(storage); unlock = runtimeLock(runtime); }
  catch { return refuse('Cannot open private Sub-hub runtime storage; check its dedicated directory and running connection'); }
  try { vault.initialize(); connection = connectionOf(runtime, hub, storage, options.name); }
  catch { unlock(); return refuse('Cannot open this Sub-hub storage or saved connection; check its hub binding and private state'); }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const stop = () => controller.abort();
  if (!options.signal) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const fetcher = deps.fetch ?? fetch;
  let local: Snapshot[] = [], status: InstanceRuntimeStatus = { state: 'waiting', snapshots: 0 }, announced = '';
  const verified = new Set<string>();
  let heartbeatPending: Promise<void> | undefined;
  let accessFailure: RuntimeAccessError | undefined;
  const announce = (state: InstanceRuntimeState, error?: string) => {
    status = { state, snapshots: local.length, ...(error ? { error } : {}) };
    const serialized = JSON.stringify(status);
    if (serialized !== announced) { announced = serialized; options.onStatus?.(structuredClone(status)); }
  };
  const request = (route: string, token: string, init: RequestInit = {}, timeout = 20_000) => fetcher(hub + PREFIX + route, {
    ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  const machineRequest = async (route: string, init: RequestInit = {}, timeout?: number) => {
    const response = await request(route, connection.token, init, timeout);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new RuntimeAccessError('The hub rejected this Sub-hub machine credential. Ask a hub recovery operator to check its access before restarting; its saved identity has been retained.');
    }
    return response;
  };
  const jsonResponse = async (response: Response, limit: number): Promise<unknown> => {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); refuse('The hub returned too much Sub-hub metadata'); }
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (response.body) for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > limit) refuse('The hub returned too much Sub-hub metadata');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return refuse('The hub returned invalid Sub-hub metadata'); }
  };
  const heartbeat = () => {
    if (!connection.registered || signal.aborted) return Promise.resolve();
    if (heartbeatPending) return heartbeatPending;
    const snapshots = local.slice(0, 256);
    while (Buffer.byteLength(JSON.stringify({ ...status, snapshots })) > 250 * 1024 && snapshots.length) snapshots.pop();
    heartbeatPending = (async () => {
      const response = await machineRequest(`/connections/${connection.id}/heartbeat`, { method: 'POST', body: JSON.stringify({ state: status.state, snapshots, ...(status.error ? { error: status.error } : {}) }) }, 8_000);
      await response.body?.cancel();
      if (!response.ok) refuse('The hub did not accept the Sub-hub heartbeat');
    })().catch(error => {
      if (error instanceof RuntimeAccessError) { accessFailure = error; announce('error', error.message); controller.abort(); }
    }).finally(() => { heartbeatPending = undefined; });
    return heartbeatPending;
  };
  const timer = setInterval(() => void heartbeat(), heartbeatInterval);
  const refreshLocal = async () => {
    const found: Snapshot[] = [];
    for (const entry of vault.list()) {
      const key = entry.id + ':' + entry.sha256;
      if (!verified.has(key)) { await vault.verify(entry.id); verified.add(key); }
      found.push(snapshot(entry));
    }
    local = found;
  };
  const download = async (id: string, file: TransferManifest['files'][number], destination: string) => {
    const response = await machineRequest(`/source/snapshots/${id}/file?path=${encodeURIComponent(file.path)}`, {}, 30 * 60_000);
    if (!response.ok || response.headers.get('x-spacehub-snapshot') !== id || response.headers.get('x-spacehub-sha256') !== file.sha256) { await response.body?.cancel(); refuse('The hub did not return the requested instance file'); }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) !== file.size)) { await response.body?.cancel(); refuse('The instance file size did not match its manifest'); }
    let output: fsp.FileHandle | undefined;
    let bytes = 0; const hash = crypto.createHash('sha256');
    try {
      output = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
      if (response.body) for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > file.size) refuse('The instance file exceeded its manifest size');
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) refuse('The instance file could not be saved');
          offset += bytesWritten;
        }
      }
      if (bytes !== file.size || hash.digest('hex') !== file.sha256) refuse('The instance file failed integrity verification');
      await output.sync();
    } finally { try { await output?.close(); } finally { await response.body?.cancel(); } }
  };
  const cycle = async () => {
    if (!connection.registered) {
      if (!options.operatorToken) throw new RuntimeAccessError('Sign in as a hub recovery operator to connect this Sub-hub, then run the command again.');
      const response = await request('/connections', options.operatorToken, { method: 'POST', body: JSON.stringify({ name: connection.name, id: connection.id, token: connection.token }) });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new RuntimeAccessError('Sign in as a hub recovery operator to connect this Sub-hub, then run the command again.'); }
      if (!response.ok) { await response.body?.cancel(); refuse('The hub did not authorize this Sub-hub connection'); }
      const registration = await jsonResponse(response, 8192);
      if (!isObject(registration) || registration.id !== connection.id || registration.token !== connection.token) refuse('The hub returned an invalid Sub-hub connection identity');
      connection.registered = true; saveConnection(runtime, connection);
    }
    announce('syncing'); void heartbeat();
    await refreshLocal();
    const response = await machineRequest('/source/snapshots');
    if (response.status === 503) { await response.body?.cancel(); announce('waiting'); return; }
    if (!response.ok) { await response.body?.cancel(); refuse('The hub full-instance backup source could not be reached'); }
    const index = await jsonResponse(response, MAX_INDEX);
    if (!isObject(index) || !Array.isArray(index.snapshots) || index.snapshots.length > 10_000) refuse('The hub returned an invalid instance snapshot index');
    const remote = index.snapshots.map(snapshot).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    if (new Set(remote.map(item => item.id)).size !== remote.length) refuse('The hub returned duplicate instance snapshots');
    if (!remote.length) { announce('waiting'); return; }
    for (const entry of remote) {
      if (signal.aborted) return;
      const known = local.find(item => item.id === entry.id);
      if (known) { if (JSON.stringify(known) !== JSON.stringify(entry)) refuse('A retained instance snapshot conflicts with the hub source'); continue; }
      const response = await machineRequest(`/source/snapshots/${entry.id}/manifest`);
      if (!response.ok) { await response.body?.cancel(); refuse('The hub full-instance manifest could not be reached'); }
      const manifest = transferManifest(await jsonResponse(response, MAX_JSON), entry, vault.maxBytes);
      const staging = path.join(runtime, 'staging'); noLinks(staging);
      const stage = path.join(staging, `${entry.id}-${crypto.randomBytes(16).toString('hex')}`);
      fs.mkdirSync(stage, { mode: 0o700 });
      try {
        for (const dir of manifest.directories.slice().sort((a, b) => a.path.length - b.path.length)) fs.mkdirSync(path.join(stage, ...dir.path.split('/')), { mode: 0o700 });
        for (const file of manifest.files) await download(entry.id, file, path.join(stage, ...file.path.split('/')));
        await vault.importSnapshot(stage, manifest);
        verified.add(entry.id + ':' + entry.sha256);
        await refreshLocal();
        announce('syncing');
      } finally {
        noLinks(stage);
        if (path.dirname(stage) !== staging) refuse('Invalid Sub-hub staging cleanup');
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
    announce('up-to-date');
  };
  try {
    announce('waiting');
    while (!signal.aborted) {
      let failed = false;
      try { await cycle(); }
      catch (error) {
        if (error instanceof RuntimeAccessError) { announce('error', error.message); throw error; }
        if (accessFailure) throw accessFailure;
        if (signal.aborted) break;
        failed = true; announce('error', 'The full-instance backup could not be synchronized. Check the hub connection, operator access and available private storage.');
      }
      await heartbeatPending; await heartbeat();
      if (options.once) { if (failed) refuse('The full-instance backup could not be synchronized'); break; }
      await wait(interval * 1000, signal);
    }
    if (accessFailure) throw accessFailure;
  } finally {
    clearInterval(timer); controller.abort(); await heartbeatPending;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    vault.close(); unlock();
  }
}
