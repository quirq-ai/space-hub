// Immutable full-deployment bundles. The capture adapter establishes cold
// consistency; this layer preserves and verifies every prepared private byte.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DEFAULT_INSTANCE_VAULT_BYTES = 100 * 1024 ** 3;
export const MAX_INSTANCE_FILES = 200_000;
const MARKER = '.spacehub-instance-vault.json';
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const METADATA_LIMIT = 64 * 1024 ** 2;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const randomId = () => crypto.randomBytes(16).toString('hex');

export class InstanceVaultError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new InstanceVaultError(status, message); }
export interface Coverage { data: boolean; runtime: boolean; configuration: boolean }
// How a backup was made: the whole Docker deployment captured while stopped
// (instancecapture.ts), or the hub's data folder copied while it runs
// (hubbackup.ts): its data only, the image and settings are the deployment's.
export type Consistency = 'stopped-containers' | 'live-copy';
export const COVERAGE: Record<Consistency, Coverage> = {
  'stopped-containers': { data: true, runtime: true, configuration: true },
  'live-copy': { data: true, runtime: false, configuration: false },
};
export interface CaptureInfo {
  source: string; services: string[]; consistency: Consistency; createdAt?: number; coverage: Coverage;
}
export interface Snapshot {
  id: string; createdAt: number; source: string; services: string[]; scope: 'instance';
  consistency: Consistency; coverage: Coverage; files: number; bytes: number; sha256: string;
}
/** The kind of a backup and the coverage that goes with it, or null when they do not match. */
export function backupKind(consistency: unknown, coverage: unknown): Consistency | null {
  if (consistency !== 'stopped-containers' && consistency !== 'live-copy') return null;
  const want = COVERAGE[consistency];
  return object(coverage) && coverage.data === want.data && coverage.runtime === want.runtime && coverage.configuration === want.configuration ? consistency : null;
}
export interface ManifestFile { path: string; size: number; sha256: string; mode: number }
export interface TransferManifest {
  version: 1; snapshot: Snapshot; rootMode: number;
  directories: { path: string; mode: number }[]; files: ManifestFile[];
}
interface ManifestDirectory { path: string; mode: number }
interface Manifest {
  version: 1; info: Omit<Snapshot, 'files' | 'bytes' | 'sha256'>; rootMode: number;
  directories: ManifestDirectory[]; files: ManifestFile[];
}
interface InventoryFile extends ManifestDirectory { size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
interface Inventory { rootMode: number; directories: ManifestDirectory[]; files: InventoryFile[]; bytes: number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);
const compare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const mode = (value: unknown) => integer(value) && (value as number) <= 0o7777;
function present(filename: string): fs.Stats | null {
  try { return fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function inside(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// A path given to the vault, with links above it resolved: the system's own
// (macOS /tmp and /var are links to /private) are not links inside a vault.
// The path itself and everything under it are checked as they are.
export function canonicalPath(filename: string): string {
  const full = path.resolve(filename);
  let at = path.dirname(full);
  const rest = [path.basename(full)];
  while (!fs.existsSync(at) && path.dirname(at) !== at) { rest.unshift(path.basename(at)); at = path.dirname(at); }
  return path.join(fs.realpathSync.native(at), ...rest);
}
function noLinks(filename: string) {
  for (let next = path.resolve(filename); ; next = path.dirname(next)) {
    if (present(next)?.isSymbolicLink()) fail(400, 'Instance paths must not contain symlinks or junctions');
    if (next === path.dirname(next)) return;
  }
}
function directory(filename: string) {
  noLinks(filename);
  if (!present(filename)?.isDirectory()) fail(400, 'Expected an instance directory');
}
function relativePath(value: unknown): string {
  // Prepared bundle names must round-trip on Windows too. Docker filesystem
  // names live inside opaque archives, where these restrictions do not apply.
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(400, 'Invalid instance manifest path');
  return value as string;
}
function joined(root: string, relative: string) {
  const filename = path.resolve(root, ...relativePath(relative).split('/'));
  if (!inside(root, filename) || filename === root) fail(400, 'Instance path escapes its directory');
  noLinks(filename);
  return filename;
}
function regular(filename: string) {
  noLinks(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(400, 'Instance files must be regular files');
  return stat;
}
function syncDirectory(filename: string) {
  if (process.platform === 'win32') return; // Node cannot portably fsync directory handles there.
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
  try { if (!fs.fstatSync(fd).isDirectory()) fail(400, 'Invalid instance directory'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function writePrivate(filename: string, value: unknown) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJson(filename: string, max = METADATA_LIMIT): unknown {
  const stat = regular(filename);
  if (stat.size > max) fail(400, 'Instance metadata is too large');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}
function sum(left: number, right: number) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail(400, 'Instance size exceeds the supported range');
  return result;
}
function inventory(root: string): Inventory {
  directory(root);
  const directories: ManifestDirectory[] = [], files: InventoryFile[] = [];
  const pending = [''];
  let bytes = 0;
  while (pending.length) {
    const base = pending.pop()!;
    const dir = base ? joined(root, base) : root;
    directory(dir);
    for (const name of fs.readdirSync(dir)) {
      const relative = relativePath(base ? `${base}/${name}` : name);
      const filename = joined(root, relative);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) fail(400, 'Instance bundles must not contain symbolic links');
      if (stat.isDirectory()) {
        directories.push({ path: relative, mode: stat.mode & 0o7777 }); pending.push(relative);
      } else if (stat.isFile()) {
        // SpacetimeDB snapshots can hardlink regular objects. Materialize
        // their bytes independently, without preserving a filesystem link.
        files.push({ path: relative, mode: stat.mode & 0o7777, size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
        bytes = sum(bytes, stat.size);
      } else fail(400, 'Instance bundles must not contain special files');
      if (files.length > MAX_INSTANCE_FILES || directories.length > MAX_INSTANCE_FILES) fail(413, 'Instance bundle contains too many filesystem entries');
    }
  }
  files.sort((a, b) => compare(a.path, b.path)); directories.sort((a, b) => compare(a.path, b.path));
  return { rootMode: fs.lstatSync(root).mode & 0o7777, directories, files, bytes };
}
function sameFile(stat: fs.Stats, file: InventoryFile) {
  return stat.isFile() && stat.size === file.size && stat.dev === file.dev && stat.ino === file.ino && stat.mtimeMs === file.mtimeMs && stat.ctimeMs === file.ctimeMs && (stat.mode & 0o7777) === file.mode;
}
async function copyAndHash(source: string, destination?: string, expected?: InventoryFile, expectedHash?: string, maxBytes = Number.MAX_SAFE_INTEGER) {
  regular(source);
  const input = await fsp.open(source, fs.constants.O_RDONLY | NO_FOLLOW);
  let output: fsp.FileHandle | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || (expected && !sameFile(before, expected))) fail(409, 'Instance source changed while being captured');
    if (destination) output = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size = sum(size, bytesRead);
      if (size > maxBytes) fail(413, 'Instance vault quota exceeded');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const result = await output.write(buffer, offset, bytesRead - offset, null);
          if (!result.bytesWritten) fail(500, 'Instance copy could not make progress');
          offset += result.bytesWritten;
        }
      }
    }
    const digest = hash.digest('hex');
    const after = await input.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || (expected && !sameFile(after, expected))) fail(409, 'Instance source changed during transfer');
    if (expectedHash && digest !== expectedHash) fail(409, 'Instance file failed SHA-256 verification');
    if (output) await output.sync();
    return { size, sha256: digest };
  } finally { try { await output?.close(); } finally { await input.close(); } }
}
function metadata(info: CaptureInfo, id: string): Manifest['info'] {
  const kind = object(info) ? backupKind(info.consistency, info.coverage) : null;
  if (!kind) fail(400, 'A backup is a stopped deployment with data, runtime and configuration, or a live copy of the hub data');
  if (typeof info.source !== 'string' || !info.source.trim() || info.source.length > 1024 || /[\x00-\x1f\x7f]/.test(info.source)) fail(400, 'Invalid instance source label');
  if (!Array.isArray(info.services) || !info.services.length || info.services.length > 256 || info.services.some(service => typeof service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service))) fail(400, 'Invalid instance service list');
  const createdAt = info.createdAt ?? Date.now();
  if (!integer(createdAt)) fail(400, 'Invalid instance creation time');
  // Labels are metadata, never a channel for copying credential-bearing URLs.
  const source = info.source.trim().replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]');
  return { id, createdAt, source, services: [...new Set(info.services)].sort(compare), scope: 'instance', consistency: kind, coverage: { ...COVERAGE[kind] } };
}
function canonical(manifest: Manifest) {
  return JSON.stringify({ version: 1, info: manifest.info, rootMode: manifest.rootMode, directories: manifest.directories.map(({ path, mode }) => ({ path, mode })), files: manifest.files.map(({ path, size, sha256, mode }) => ({ path, size, sha256, mode })) });
}
function completeBundle(files: { path: string }[], kind: Consistency) {
  if (kind === 'live-copy') {
    if (!files.some(file => file.path === 'hub.json') || !files.some(file => file.path.startsWith('data/'))) fail(400, 'A live copy of the hub needs hub.json and the data folder');
    return;
  }
  if (!files.some(file => file.path === 'deployment.json') || !files.some(file => file.path.startsWith('images/') && file.path.endsWith('.tar')) || !files.some(file => file.path.startsWith('containers/') && file.path.endsWith('.tar')) || !files.some(file => file.path.startsWith('volumes/'))) fail(400, 'Prepared instance bundle needs deployment.json, runtime images, container filesystem archives and persistent volume bytes');
}
function snapshotOf(manifest: Manifest): Snapshot {
  return { ...clone(manifest.info), files: manifest.files.length, bytes: manifest.files.reduce((total, file) => sum(total, file.size), 0), sha256: crypto.createHash('sha256').update(canonical(manifest)).digest('hex') };
}
function validateManifest(value: unknown, id: string): Manifest {
  if (!object(value) || value.version !== 1 || !object(value.info) || value.info.id !== id || value.info.scope !== 'instance' || !mode(value.rootMode) || !Array.isArray(value.files) || !Array.isArray(value.directories) || value.files.length > MAX_INSTANCE_FILES || value.directories.length > MAX_INSTANCE_FILES) fail(400, 'Invalid instance manifest');
  const raw = value as unknown as Manifest;
  const info = metadata(raw.info, id);
  const paths = new Set<string>();
  const addPath = (name: unknown) => { const valid = relativePath(name); if (paths.has(valid)) fail(400, 'Duplicate instance manifest path'); paths.add(valid); return valid; };
  const directories = raw.directories.map(item => {
    if (!object(item) || !mode(item.mode)) fail(400, 'Invalid instance directory mode');
    return { path: addPath(item.path), mode: item.mode };
  }).sort((a, b) => compare(a.path, b.path));
  const files = raw.files.map(item => {
    if (!object(item) || !integer(item.size) || !mode(item.mode) || typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) fail(400, 'Invalid instance file manifest');
    return { path: addPath(item.path), size: item.size, sha256: item.sha256, mode: item.mode };
  }).sort((a, b) => compare(a.path, b.path));
  const directoryPaths = new Set(directories.map(item => item.path));
  for (const item of [...directories, ...files]) {
    const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    if (parent && !directoryPaths.has(parent)) fail(400, 'Instance manifest is missing a parent directory');
  }
  return { version: 1, info, rootMode: raw.rootMode, directories, files };
}

export class InstanceVault {
  readonly storageDir: string;
  readonly maxBytes: number;
  private initialized = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(storageDir: string, options: { maxBytes?: number } = {}) {
    if (!path.isAbsolute(storageDir)) fail(400, 'Instance storage must be an absolute dedicated directory');
    this.storageDir = canonicalPath(storageDir);
    if (this.storageDir === path.parse(this.storageDir).root || this.storageDir === path.resolve(os.homedir())) fail(400, 'A filesystem root or home directory cannot be an instance vault');
    this.maxBytes = options.maxBytes ?? DEFAULT_INSTANCE_VAULT_BYTES;
    if (!integer(this.maxBytes) || this.maxBytes <= 0) fail(400, 'maxBytes must be a positive safe integer');
  }
  initialize(): void {
    noLinks(this.storageDir);
    const existing = present(this.storageDir);
    if (existing && !existing.isDirectory()) fail(400, 'Instance storage must be a directory');
    if (!existing) fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    const marker = path.join(this.storageDir, MARKER);
    if (!present(marker)) {
      if (fs.readdirSync(this.storageDir).length) fail(400, 'Instance vault contains unrelated data');
      try { writePrivate(marker, { kind: 'spacehub-instance-vault', version: 1 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const sentinel = readJson(marker, 4096);
    if (!object(sentinel) || sentinel.kind !== 'spacehub-instance-vault' || sentinel.version !== 1) fail(400, 'Invalid instance vault marker');
    for (const name of fs.readdirSync(this.storageDir)) {
      if (![MARKER, 'snapshots', 'staging', '.writer.lock', '.writer.lock.guard'].includes(name)) fail(400, 'Instance vault contains unrelated data');
      noLinks(path.join(this.storageDir, name));
    }
    for (const name of ['snapshots', 'staging']) {
      const filename = path.join(this.storageDir, name);
      if (present(filename) && !present(filename)!.isDirectory()) fail(400, 'Invalid instance vault layout');
      fs.mkdirSync(filename, { recursive: true, mode: 0o700 });
    }
    syncDirectory(this.storageDir);
    this.initialized = true;
  }
  close(): void { /* No lifetime lock: readers and host capture processes coexist. */ }
  private ready() { if (!this.initialized) this.initialize(); noLinks(this.storageDir); }
  private lock() {
    const filename = path.join(this.storageDir, '.writer.lock');
    const nonce = randomId();
    // Serialize stale recovery and ordinary acquisition together. Without
    // this guard, two stale reapers could unlink a replacement active lock.
    const guard = filename + '.guard';
    let guardFd: number;
    try { guardFd = fs.openSync(guard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'Instance lock acquisition is busy; inspect an abandoned lock guard before removal'); throw error; }
    try {
      fs.writeFileSync(guardFd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(guardFd);
      if (present(filename)) {
        const previous = readJson(filename, 4096) as { pid?: number };
        if (!object(previous) || !integer(previous.pid) || !previous.pid) fail(409, 'Invalid instance writer lock; inspect it before removal');
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) fail(409, 'Instance vault already has a writer');
        fs.unlinkSync(filename);
      }
      try { writePrivate(filename, { pid: process.pid, nonce }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'Instance vault already has a writer'); throw error; }
      syncDirectory(this.storageDir);
    } finally { fs.closeSync(guardFd); fs.unlinkSync(guard); syncDirectory(this.storageDir); }
    return () => {
      const current = readJson(filename, 4096) as { pid?: number; nonce?: string };
      if (current.pid !== process.pid || current.nonce !== nonce) fail(409, 'Instance writer lock ownership changed');
      fs.unlinkSync(filename); syncDirectory(this.storageDir);
    };
  }
  private measuredBytes() {
    let total = 0;
    const pending = [this.storageDir];
    while (pending.length) {
      const entry = pending.pop()!;
      noLinks(entry);
      const stat = fs.lstatSync(entry);
      if (stat.isFile()) total = sum(total, stat.size);
      else if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) pending.push(path.join(entry, name));
      else fail(400, 'Instance vault contains an unsupported filesystem entry');
    }
    return total;
  }
  private load(id: string) {
    this.ready();
    if (!ID.test(id)) fail(400, 'Invalid instance snapshot id');
    const root = joined(path.join(this.storageDir, 'snapshots'), id);
    directory(root);
    const manifest = validateManifest(readJson(joined(root, 'manifest.json')), id);
    const snapshot = snapshotOf(manifest);
    const saved = readJson(joined(root, 'snapshot.json'));
    if (!object(saved) || JSON.stringify(saved) !== JSON.stringify(snapshot)) fail(409, 'Instance catalog and manifest do not match');
    const expected = new Set(['manifest.json', 'snapshot.json', 'payload']);
    if (fs.readdirSync(root).some(name => !expected.has(name))) fail(409, 'Unexpected instance snapshot contents');
    return { root, manifest, snapshot };
  }
  list(): Snapshot[] {
    this.ready();
    const directoryName = path.join(this.storageDir, 'snapshots');
    return fs.readdirSync(directoryName).map(id => {
      if (!ID.test(id)) return fail(400, 'Unrecognized instance snapshot directory');
      return this.load(id).snapshot;
    }).sort((a, b) => b.createdAt - a.createdAt || compare(a.id, b.id));
  }
  async capture(sourceDir: string, info: CaptureInfo): Promise<Snapshot> {
    const run = this.tail.then(() => this.captureOne(sourceDir, info));
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async captureOne(sourceDir: string, info: CaptureInfo): Promise<Snapshot> {
    this.ready();
    if (!path.isAbsolute(sourceDir)) fail(400, 'Instance source must be an absolute prepared bundle');
    const source = canonicalPath(sourceDir);
    if (inside(this.storageDir, source) || inside(source, this.storageDir)) fail(400, 'Instance source and vault must not overlap');
    const id = randomId(), details = metadata(info, id);
    const release = this.lock();
    const stage = path.join(this.storageDir, 'staging', `${id}.tmp`);
    let staged = false;
    try {
      const tree = inventory(source);
      completeBundle(tree.files, details.consistency);
      const used = this.measuredBytes();
      if (sum(used, tree.bytes) > this.maxBytes) fail(413, 'Instance vault quota exceeded');
      fs.mkdirSync(stage, { mode: 0o700 }); staged = true;
      const payload = path.join(stage, 'payload'); fs.mkdirSync(payload, { mode: 0o700 });
      for (const dir of tree.directories) fs.mkdirSync(joined(payload, dir.path), { mode: 0o700 });
      const files: ManifestFile[] = [];
      let transferred = 0;
      for (const file of tree.files) {
        const saved = await copyAndHash(joined(source, file.path), joined(payload, file.path), file, undefined, this.maxBytes - used - transferred);
        transferred = sum(transferred, saved.size);
        files.push({ path: file.path, size: saved.size, sha256: saved.sha256, mode: file.mode });
      }
      if (JSON.stringify(inventory(source)) !== JSON.stringify(tree)) fail(409, 'Instance source tree changed while being captured');
      const manifest: Manifest = { version: 1, info: details, rootMode: tree.rootMode, directories: tree.directories, files };
      if (Buffer.byteLength(canonical(manifest)) > METADATA_LIMIT) fail(413, 'Instance manifest is too large');
      const snapshot = snapshotOf(manifest);
      writePrivate(path.join(stage, 'manifest.json'), manifest); writePrivate(path.join(stage, 'snapshot.json'), snapshot);
      if (this.measuredBytes() > this.maxBytes) fail(413, 'Instance vault quota exceeded');
      for (const dir of tree.directories.slice().sort((a, b) => b.path.length - a.path.length)) syncDirectory(joined(payload, dir.path));
      syncDirectory(payload); syncDirectory(stage);
      const target = path.join(this.storageDir, 'snapshots', id);
      if (present(target)) fail(409, 'Instance snapshot id already exists');
      fs.renameSync(stage, target); staged = false;
      syncDirectory(path.join(this.storageDir, 'snapshots')); syncDirectory(path.join(this.storageDir, 'staging'));
      return clone(snapshot);
    } finally {
      try {
        if (staged && present(stage)) { noLinks(stage); if (!inside(path.join(this.storageDir, 'staging'), stage)) fail(400, 'Invalid staging cleanup path'); fs.rmSync(stage, { recursive: true, force: true }); }
      } finally { release(); }
    }
  }
  /** Delete a backup for good (the hub's own retention, a sub-hub's --keep). */
  async remove(id: string): Promise<void> {
    const run = this.tail.then(() => {
      const { root } = this.load(id);
      const release = this.lock();
      try {
        noLinks(root);
        if (!inside(path.join(this.storageDir, 'snapshots'), root)) fail(400, 'Invalid instance snapshot path');
        fs.rmSync(root, { recursive: true, force: true });
        syncDirectory(path.join(this.storageDir, 'snapshots'));
      } finally { release(); }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
  async verify(id: string) {
    const { root, manifest, snapshot } = this.load(id);
    const payload = joined(root, 'payload');
    const tree = inventory(payload);
    if (tree.files.length !== manifest.files.length || tree.bytes !== snapshot.bytes || JSON.stringify(tree.files.map(file => file.path)) !== JSON.stringify(manifest.files.map(file => file.path)) || JSON.stringify(tree.directories.map(dir => dir.path)) !== JSON.stringify(manifest.directories.map(dir => dir.path))) fail(409, 'Instance payload does not match its manifest');
    for (const file of manifest.files) {
      const result = await copyAndHash(joined(payload, file.path), undefined, undefined, file.sha256, file.size);
      if (result.size !== file.size) fail(409, 'Instance file size does not match its manifest');
    }
    return { snapshot: clone(snapshot), files: snapshot.files, bytes: snapshot.bytes, verifiedAt: Date.now() };
  }
  async exportManifest(id: string): Promise<TransferManifest> {
    await this.verify(id);
    const { manifest, snapshot } = this.load(id);
    return clone({ version: 1, snapshot, rootMode: manifest.rootMode, directories: manifest.directories, files: manifest.files });
  }
  async openPayload(id: string, relative: string): Promise<{ stream: fs.ReadStream; size: number; sha256: string }> {
    const { root, manifest } = this.load(id);
    const file = manifest.files.find(item => item.path === relativePath(relative));
    if (!file) fail(404, 'No such instance backup file');
    const filename = joined(root, `payload/${file.path}`);
    regular(filename);
    const handle = await fsp.open(filename, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.size) fail(409, 'Instance backup file changed');
      return { stream: handle.createReadStream({ autoClose: true }), size: file.size, sha256: file.sha256 };
    } catch (error) { await handle.close(); throw error; }
  }
  async importSnapshot(sourceDir: string, transfer: TransferManifest): Promise<Snapshot> {
    const run = this.tail.then(() => this.importOne(sourceDir, transfer));
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async importOne(sourceDir: string, transfer: TransferManifest): Promise<Snapshot> {
    this.ready();
    if (!object(transfer) || transfer.version !== 1 || !object(transfer.snapshot) || typeof transfer.snapshot.id !== 'string' || !ID.test(transfer.snapshot.id)) fail(400, 'Invalid instance transfer manifest');
    const id = transfer.snapshot.id;
    const manifest = validateManifest({ version: 1, info: transfer.snapshot, rootMode: transfer.rootMode, directories: transfer.directories, files: transfer.files }, id);
    completeBundle(manifest.files, manifest.info.consistency);
    if (Buffer.byteLength(canonical(manifest)) > METADATA_LIMIT) fail(413, 'Instance manifest is too large');
    const snapshot = snapshotOf(manifest);
    if (snapshot.sha256 !== transfer.snapshot.sha256 || snapshot.files !== transfer.snapshot.files || snapshot.bytes !== transfer.snapshot.bytes) fail(409, 'Instance transfer manifest failed integrity verification');
    const target = joined(path.join(this.storageDir, 'snapshots'), id);
    if (present(target)) {
      const existing = await this.verify(id);
      if (existing.snapshot.sha256 !== snapshot.sha256) fail(409, 'Instance snapshot ID already has different content');
      return clone(existing.snapshot);
    }
    if (!path.isAbsolute(sourceDir)) fail(400, 'Instance transfer source must be absolute');
    const source = canonicalPath(sourceDir);
    if (inside(this.storageDir, source) || inside(source, this.storageDir)) fail(400, 'Instance source and vault must not overlap');
    const release = this.lock();
    const stage = path.join(this.storageDir, 'staging', `${id}.${randomId()}.tmp`);
    let staged = false;
    try {
      const tree = inventory(source);
      if (tree.files.length !== manifest.files.length || tree.bytes !== snapshot.bytes || JSON.stringify(tree.files.map(file => file.path)) !== JSON.stringify(manifest.files.map(file => file.path)) || JSON.stringify(tree.directories.map(dir => dir.path)) !== JSON.stringify(manifest.directories.map(dir => dir.path))) fail(409, 'Transferred instance files do not match their manifest');
      const used = this.measuredBytes();
      if (sum(used, snapshot.bytes) > this.maxBytes) fail(413, 'Instance vault quota exceeded');
      fs.mkdirSync(stage, { mode: 0o700 }); staged = true;
      const payload = path.join(stage, 'payload'); fs.mkdirSync(payload, { mode: 0o700 });
      for (const dir of manifest.directories) fs.mkdirSync(joined(payload, dir.path), { mode: 0o700 });
      let transferred = 0;
      const sourceFiles = new Map(tree.files.map(file => [file.path, file]));
      for (const file of manifest.files) {
        const original = sourceFiles.get(file.path)!;
        const saved = await copyAndHash(joined(source, file.path), joined(payload, file.path), original, file.sha256, Math.min(file.size, this.maxBytes - used - transferred));
        if (saved.size !== file.size) fail(409, 'Transferred instance file size changed');
        transferred = sum(transferred, saved.size);
      }
      if (JSON.stringify(inventory(source)) !== JSON.stringify(tree)) fail(409, 'Instance transfer source changed');
      writePrivate(path.join(stage, 'manifest.json'), manifest); writePrivate(path.join(stage, 'snapshot.json'), snapshot);
      if (this.measuredBytes() > this.maxBytes) fail(413, 'Instance vault quota exceeded');
      for (const dir of manifest.directories.slice().sort((a, b) => b.path.length - a.path.length)) syncDirectory(joined(payload, dir.path));
      syncDirectory(payload); syncDirectory(stage);
      if (present(target)) fail(409, 'Instance snapshot already exists');
      fs.renameSync(stage, target); staged = false;
      syncDirectory(path.join(this.storageDir, 'snapshots')); syncDirectory(path.join(this.storageDir, 'staging'));
      return clone(snapshot);
    } finally {
      try { if (staged && present(stage)) { noLinks(stage); if (!inside(path.join(this.storageDir, 'staging'), stage)) fail(400, 'Invalid instance staging directory'); fs.rmSync(stage, { recursive: true, force: true }); } }
      finally { release(); }
    }
  }
  async restore(id: string, newDest: string) {
    await this.verify(id);
    const { root, manifest, snapshot } = this.load(id);
    if (!path.isAbsolute(newDest)) fail(400, 'Instance restore destination must be an absolute new directory');
    const destination = canonicalPath(newDest);
    if (inside(this.storageDir, destination) || inside(destination, this.storageDir)) fail(400, 'Instance restore destination must be outside the vault');
    noLinks(destination); directory(path.dirname(destination));
    if (present(destination)) fail(409, 'Instance restore destination already exists');
    fs.mkdirSync(destination, { mode: 0o700 });
    const ownership = fs.lstatSync(destination);
    let complete = false;
    try {
      for (const dir of manifest.directories) fs.mkdirSync(joined(destination, dir.path), { mode: 0o700 });
      for (const file of manifest.files) {
        const target = joined(destination, file.path);
        const result = await copyAndHash(joined(root, `payload/${file.path}`), target, undefined, file.sha256, file.size);
        if (result.size !== file.size) fail(409, 'Instance file size changed during restore');
        const fd = fs.openSync(target, fs.constants.O_RDWR | NO_FOLLOW);
        try { fs.fchmodSync(fd, file.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      for (const dir of manifest.directories.slice().sort((a, b) => b.path.length - a.path.length)) { const target = joined(destination, dir.path); syncDirectory(target); fs.chmodSync(target, dir.mode); }
      syncDirectory(destination); fs.chmodSync(destination, manifest.rootMode); syncDirectory(path.dirname(destination));
      complete = true;
      return { directory: destination, snapshot: clone(snapshot), files: snapshot.files, bytes: snapshot.bytes };
    } finally {
      if (!complete && present(destination)) {
        noLinks(destination);
        const current = fs.lstatSync(destination);
        if (current.isDirectory() && current.dev === ownership.dev && current.ino === ownership.ino) fs.rmSync(destination, { recursive: true, force: true });
      }
    }
  }
}
