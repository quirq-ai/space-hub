// Global full-instance backup machines. Credentials are private hashes;
// reports cannot confer org, project, session or execution authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Snapshot } from './instancevault.ts';

export type ConnectionState = 'waiting' | 'syncing' | 'up-to-date' | 'error';
export interface ConnectionReport { state: ConnectionState; snapshots: Snapshot[]; error?: string }
export interface InstanceConnection extends ConnectionReport { id: string; name: string; connectedAt: number; lastSeen: number; online: boolean }
interface SavedConnection extends ConnectionReport { id: string; name: string; connectedAt: number; lastSeen: number; tokenHash: string }
interface Registry { version: 1; connections: SavedConnection[] }
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const MARKER = '.spacehub-instance-connections.json';
const MAX_BYTES = 8 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function noLinks(filename: string) {
  for (let at = path.resolve(filename); ; at = path.dirname(at)) {
    try { if (fs.lstatSync(at).isSymbolicLink()) fail(400, 'Connection storage cannot use symlinks or junctions'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(at) === at) return;
  }
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writePrivate(filename: string, text: string) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readPrivate(filename: string): unknown {
  noLinks(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail(409, 'Invalid connection registry');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { fail(409, 'Invalid connection registry'); } finally { fs.closeSync(fd); }
}
function machineName(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'Choose a machine name');
  const name = value.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name)) fail(400, 'Use a short machine name with letters, numbers, spaces, dots, underscores or hyphens');
  return name;
}
function label(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'Invalid full-instance snapshot label');
  if (/(?:token|secret|password|credential|authorization|key)\s*[:=]|\bBearer\s+|https?:\/\/[^\s/]+@/i.test(value)) return '[redacted]';
  return value.replace(/[<>]/g, '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]') || '[redacted]';
}
function snapshot(value: unknown): Snapshot {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id) || !integer(value.createdAt) || value.scope !== 'instance' || value.consistency !== 'stopped-containers' || !object(value.coverage) || value.coverage.data !== true || value.coverage.runtime !== true || value.coverage.configuration !== true || !integer(value.files) || !integer(value.bytes) || typeof value.sha256 !== 'string' || !HASH.test(value.sha256) || !Array.isArray(value.services) || !value.services.length || value.services.length > 256) fail(400, 'Report complete full-instance snapshots only');
  return { id: value.id, createdAt: value.createdAt, source: label(value.source, 1024), services: value.services.map(item => label(item, 128)), scope: 'instance', consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true }, files: value.files, bytes: value.bytes, sha256: value.sha256 };
}
function report(value: unknown): ConnectionReport {
  if (!object(value) || !['waiting', 'syncing', 'up-to-date', 'error'].includes(String(value.state)) || !Array.isArray(value.snapshots) || value.snapshots.length > 256 || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 1000))) fail(400, 'Invalid full-instance machine report');
  const snapshots = value.snapshots.map(snapshot);
  if (new Set(snapshots.map(item => item.id)).size !== snapshots.length) fail(400, 'Duplicate snapshot in machine report');
  const state = value.state as ConnectionState;
  return { state, snapshots, ...(value.error ? { error: state === 'waiting' ? 'Full-instance backup source is unavailable. The Sub-hub will retry automatically.' : 'Automatic full-instance backup failed. Check the Sub-hub CLI.' } : {}) };
}
function registry(value: unknown): Registry {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 4096) fail(409, 'Invalid connection registry');
  const connections: SavedConnection[] = value.connections.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.tokenHash !== 'string' || !HASH.test(item.tokenHash) || !integer(item.connectedAt) || !integer(item.lastSeen)) fail(409, 'Invalid connection registry');
    return { id: item.id, name: machineName(item.name), connectedAt: item.connectedAt, lastSeen: item.lastSeen, tokenHash: item.tokenHash, ...report(item) };
  });
  if (new Set(connections.map(item => item.id)).size !== connections.length || new Set(connections.map(item => item.tokenHash)).size !== connections.length) fail(409, 'Duplicate connection registry entry');
  return { version: 1, connections };
}
const digest = (token: string) => crypto.createHash('sha256').update(token).digest();
function matches(saved: SavedConnection, token: string) { return typeof token === 'string' && HASH.test(token) && crypto.timingSafeEqual(Buffer.from(saved.tokenHash, 'hex'), digest(token)); }

export class InstanceConnections {
  readonly storageDir: string;
  private initialized = false;
  private now: () => number;
  constructor(storageDir: string, options: { now?: () => number } = {}) { this.storageDir = path.resolve(storageDir); this.now = options.now ?? Date.now; }
  initialize() {
    noLinks(this.storageDir);
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.storageDir).isDirectory()) fail(400, 'Connection storage must be a dedicated directory');
    const marker = path.join(this.storageDir, MARKER);
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(this.storageDir).length) fail(400, 'Connection storage must be an empty dedicated directory');
      writePrivate(path.join(this.storageDir, 'connections.json'), '{"version":1,"connections":[]}\n');
      writePrivate(marker, '{"version":1}\n'); syncDirectory(this.storageDir);
    } else {
      const value = readPrivate(marker);
      if (!object(value) || value.version !== 1) fail(409, 'Invalid connection storage marker');
    }
    for (const filename of fs.readdirSync(this.storageDir)) if (![MARKER, 'connections.json', '.writer.lock', '.writer.lock.guard'].includes(filename) && !/^\.connections-[a-f0-9]{32}\.tmp$/.test(filename)) fail(409, 'Unexpected file in connection storage');
    registry(readPrivate(path.join(this.storageDir, 'connections.json'))); this.initialized = true;
  }
  private ready() { if (!this.initialized) this.initialize(); noLinks(this.storageDir); }
  private read() { this.ready(); return registry(readPrivate(path.join(this.storageDir, 'connections.json'))); }
  private public(item: SavedConnection): InstanceConnection {
    const { tokenHash: _, ...value } = structuredClone(item);
    return { ...value, online: this.now() - item.lastSeen <= 45_000 && this.now() >= item.lastSeen };
  }
  private lock(): () => void {
    const filename = path.join(this.storageDir, '.writer.lock');
    const guard = filename + '.guard';
    // Every contender must hold this guard from stale detection through new
    // writer creation. An abandoned guard is never automatically reclaimed.
    try { writePrivate(guard, JSON.stringify({ pid: process.pid }) + '\n'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'Connection lock guard is active or stale; inspect .writer.lock.guard before removal'); throw error; }
    const read = () => {
      noLinks(filename);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size > 4096) fail(409, 'Invalid connection writer lock; inspect it before removal');
      const value = readPrivate(filename);
      if (!object(value) || !integer(value.pid) || !value.pid || (value.nonce !== undefined && (typeof value.nonce !== 'string' || !ID.test(value.nonce)))) fail(409, 'Invalid connection writer lock; inspect it before removal');
      return { stat, pid: value.pid, nonce: value.nonce };
    };
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      if (fs.existsSync(filename)) {
        const previous = read();
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) fail(409, 'Another connection registry writer is active');
        const current = read();
        if (current.pid !== previous.pid || current.nonce !== previous.nonce || current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino || current.stat.mtimeMs !== previous.stat.mtimeMs) fail(409, 'Connection writer lock changed while recovering a stopped writer');
        fs.unlinkSync(filename); syncDirectory(this.storageDir);
      }
      try { writePrivate(filename, JSON.stringify({ pid: process.pid, nonce }) + '\n'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'Another connection registry writer is active'); throw error; }
      syncDirectory(this.storageDir);
    } finally { fs.unlinkSync(guard); syncDirectory(this.storageDir); }
    return () => {
      const current = read();
      if (current.pid !== process.pid || current.nonce !== nonce) fail(409, 'Connection writer lock ownership changed');
      fs.unlinkSync(filename); syncDirectory(this.storageDir);
    };
  }
  private mutate<T>(change: (value: Registry) => T): T {
    this.ready();
    const release = this.lock();
    const temporary = path.join(this.storageDir, `.connections-${crypto.randomBytes(16).toString('hex')}.tmp`);
    try {
      const value = this.read(), result = change(value), text = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(text) > MAX_BYTES) fail(413, 'Connection registry capacity exceeded');
      writePrivate(temporary, text); fs.renameSync(temporary, path.join(this.storageDir, 'connections.json')); syncDirectory(this.storageDir);
      return result;
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      finally { release(); }
    }
  }
  list(): InstanceConnection[] { return this.read().connections.map(item => this.public(item)).sort((left, right) => right.connectedAt - left.connectedAt || left.id.localeCompare(right.id)); }
  register(name: string, enrollment?: { id: string; token: string }): { id: string; token: string } {
    const clean = machineName(name);
    if (enrollment && (!ID.test(enrollment.id) || !HASH.test(enrollment.token))) fail(400, 'Invalid Sub-hub enrollment');
    return this.mutate(value => {
      if (enrollment) {
        const existing = value.connections.find(item => item.id === enrollment.id);
        if (existing) {
          if (existing.name !== clean || !matches(existing, enrollment.token)) fail(409, 'Sub-hub enrollment conflicts with an existing machine');
          return { ...enrollment };
        }
        if (value.connections.some(item => matches(item, enrollment.token))) fail(409, 'Sub-hub enrollment credential is already registered');
      }
      if (value.connections.length >= 4096) fail(413, 'Connection registry capacity exceeded');
      const id = enrollment?.id ?? crypto.randomBytes(16).toString('hex'), token = enrollment?.token ?? crypto.randomBytes(32).toString('hex'), now = this.now();
      value.connections.push({ id, tokenHash: digest(token).toString('hex'), name: clean, connectedAt: now, lastSeen: now, state: 'waiting', snapshots: [] });
      return { id, token };
    });
  }
  authorize(token: string): boolean { return this.read().connections.some(item => matches(item, token)); }
  heartbeat(id: string, token: string, input: unknown): InstanceConnection {
    if (!ID.test(id)) fail(403, 'Invalid Sub-hub machine credential');
    const update = report(input);
    return this.mutate(value => {
      const item = value.connections.find(entry => entry.id === id);
      if (!item || !matches(item, token)) fail(403, 'Invalid Sub-hub machine credential');
      Object.assign(item, update, { lastSeen: this.now() });
      if (!update.error) delete item.error;
      return this.public(item);
    });
  }
}
