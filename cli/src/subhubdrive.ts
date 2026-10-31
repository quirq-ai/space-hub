// A node's active drive: immutable SHA-256 blobs plus an atomic path index.
// Mutations are synchronous and take a writer lock; the runtime also owns its
// node-root lifetime lock. Old blobs are retained, never silently pruned.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DRIVE_MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const MARKER = '.spacehub-drive';
const MARKER_TEXT = 'spacehub-drive-v1\n';
const HASH = /^[a-f0-9]{64}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'DriveError'; this.status = status; }
}
export interface DriveFile { path: string; sha256: string; size: number; updatedAt: number }
export interface DriveStats { files: number; bytes: number; updatedAt: number | null }
interface StoredFile { sha256: string; size: number; updatedAt: number }
interface DriveIndex { version: 1; files: Record<string, StoredFile> }
export interface DriveOptions { availableBytes?: () => number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function drivePath(value: string, prefix = false): string {
  if (typeof value !== 'string') throw new DriveError(400, 'A drive path is required.');
  if (prefix && value === '') return value;
  const checked = prefix && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!checked || Buffer.byteLength(checked) > 4096 || checked.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(checked) || checked.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) throw new DriveError(400, 'Use a safe relative drive path.');
  return value;
}

function directory(filename: string, create = false) {
  const absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (create && !fs.existsSync(current)) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DriveError(409, 'Drive storage must use ordinary directories.');
  }
  return absolute;
}
function regular(filename: string) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new DriveError(409, 'Drive storage must use regular files.');
  return stat;
}
function syncDirectory(filename: string) {
  let descriptor: number | undefined;
  try { descriptor = fs.openSync(filename, 'r'); fs.fsyncSync(descriptor); }
  catch (error) {
    if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL', 'EBADF', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function writeSynced(filename: string, data: string | Buffer) {
  const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function indexBody(files: Record<string, StoredFile>) {
  return JSON.stringify({ version: 1, files: Object.fromEntries(Object.keys(files).sort().map(filename => [filename, files[filename]])) }) + '\n';
}

export class DriveStore {
  readonly storageDir: string;
  private options: DriveOptions;

  constructor(storageDir: string, options: DriveOptions = {}) {
    this.storageDir = path.resolve(storageDir);
    if (this.storageDir === path.parse(this.storageDir).root) throw new DriveError(400, 'Choose a dedicated drive directory.');
    this.options = options;
    this.initialize();
  }

  initialize() {
    directory(this.storageDir, true);
    const marker = path.join(this.storageDir, MARKER);
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(this.storageDir).length) throw new DriveError(409, 'Refusing an unrelated nonempty drive directory.');
      writeSynced(marker, MARKER_TEXT);
      syncDirectory(this.storageDir);
    }
    regular(marker);
    if (fs.readFileSync(marker, 'utf8') !== MARKER_TEXT) throw new DriveError(409, 'Invalid drive storage marker.');
    for (const entry of fs.readdirSync(this.storageDir)) {
      if (entry === 'blobs') { directory(path.join(this.storageDir, entry)); continue; }
      if (![MARKER, 'index.json', '.writer.lock'].includes(entry) && !/^\.index-[a-f0-9-]{36}\.tmp$/.test(entry)) throw new DriveError(409, 'Unrelated files were found in drive storage.');
      regular(path.join(this.storageDir, entry));
    }
    directory(path.join(this.storageDir, 'blobs'), true);
    const filename = path.join(this.storageDir, 'index.json');
    if (!fs.existsSync(filename)) this.publishIndex(indexBody({}));
    this.index();
  }

  private index(): DriveIndex {
    directory(this.storageDir);
    const filename = path.join(this.storageDir, 'index.json');
    if (regular(filename).size > MAX_INDEX_BYTES) throw new DriveError(409, 'The drive index is too large.');
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new DriveError(409, 'The drive index is invalid.'); }
    if (!object(value) || value.version !== 1 || !object(value.files) || Object.keys(value.files).length > MAX_FILES) throw new DriveError(409, 'The drive index is invalid.');
    const files: Record<string, StoredFile> = Object.create(null);
    for (const [filename, metadata] of Object.entries(value.files)) {
      drivePath(filename);
      if (!object(metadata) || typeof metadata.sha256 !== 'string' || !HASH.test(metadata.sha256) || !Number.isSafeInteger(metadata.size) || Number(metadata.size) < 0 || Number(metadata.size) > DRIVE_MAX_FILE_BYTES || !Number.isSafeInteger(metadata.updatedAt) || Number(metadata.updatedAt) < 0) throw new DriveError(409, 'The drive index contains invalid metadata.');
      files[filename] = { sha256: metadata.sha256, size: Number(metadata.size), updatedAt: Number(metadata.updatedAt) };
    }
    return { version: 1, files };
  }

  private blob(sha256: string) {
    directory(path.join(this.storageDir, 'blobs'));
    if (!HASH.test(sha256)) throw new DriveError(409, 'Invalid drive blob ID.');
    return path.join(this.storageDir, 'blobs', sha256);
  }
  private readBlob(metadata: StoredFile): Buffer {
    const filename = this.blob(metadata.sha256);
    if (regular(filename).size !== metadata.size) throw new DriveError(409, 'Drive blob size does not match its index.');
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
    let data: Buffer;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size !== metadata.size || stat.size > DRIVE_MAX_FILE_BYTES) throw new DriveError(409, 'Invalid drive blob.');
      data = fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (crypto.createHash('sha256').update(data).digest('hex') !== metadata.sha256) throw new DriveError(409, 'Drive blob checksum does not match its index.');
    return data;
  }
  private publishIndex(body: string) {
    const destination = path.join(this.storageDir, 'index.json');
    if (fs.existsSync(destination)) regular(destination);
    const temporary = path.join(this.storageDir, `.index-${crypto.randomUUID()}.tmp`);
    try {
      writeSynced(temporary, body);
      fs.renameSync(temporary, destination);
      syncDirectory(this.storageDir);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  private locked<T>(work: () => T): T {
    directory(this.storageDir);
    const filename = path.join(this.storageDir, '.writer.lock');
    let descriptor: number;
    try { descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DriveError(409, 'The drive already has a writer; inspect any stale lock.'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); return work(); }
    finally { fs.closeSync(descriptor); fs.unlinkSync(filename); }
  }

  list(prefix = ''): DriveFile[] {
    drivePath(prefix, true);
    return Object.entries(this.index().files).filter(([filename]) => filename.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      .map(([filename, metadata]) => ({ path: filename, ...metadata }));
  }
  stats(): DriveStats {
    const files = Object.values(this.index().files);
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), updatedAt: files.length ? Math.max(...files.map(file => file.updatedAt)) : null };
  }
  read(filename: string): { metadata: DriveFile; data: Buffer } {
    drivePath(filename);
    const index = this.index();
    const metadata = Object.hasOwn(index.files, filename) ? index.files[filename] : undefined;
    if (!metadata) throw new DriveError(404, 'Drive file not found.');
    return { metadata: { path: filename, ...metadata }, data: this.readBlob(metadata) };
  }
  write(filename: string, data: Buffer, expectedVersion: string | null): DriveFile {
    drivePath(filename);
    if (!Buffer.isBuffer(data)) throw new DriveError(400, 'Drive content must be bytes.');
    if (data.length > DRIVE_MAX_FILE_BYTES) throw new DriveError(413, 'Drive files are limited to 16 MiB.');
    if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !HASH.test(expectedVersion))) throw new DriveError(400, 'A valid drive file version is required.');
    return this.locked(() => {
      const index = this.index();
      const previous = Object.hasOwn(index.files, filename) ? index.files[filename] : undefined;
      if ((expectedVersion === null && previous) || (expectedVersion !== null && previous?.sha256 !== expectedVersion)) throw new DriveError(412, 'The drive file changed; refresh before writing again.');
      if (Object.keys(index.files).some(other => other !== filename && (other.startsWith(filename + '/') || filename.startsWith(other + '/')))) throw new DriveError(409, 'A file cannot also be a drive folder.');
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      if (previous?.sha256 === sha256) { this.readBlob(previous); return { path: filename, ...previous }; }
      const metadata: StoredFile = { sha256, size: data.length, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
      const files: Record<string, StoredFile> = Object.assign(Object.create(null), index.files, { [filename]: metadata });
      const body = indexBody(files);
      if (Object.keys(files).length > MAX_FILES || Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new DriveError(507, 'The drive file index has reached its limit.');
      const destination = this.blob(sha256);
      const exists = fs.existsSync(destination);
      if (exists) this.readBlob(metadata);
      if (this.options.availableBytes) {
        const available = this.options.availableBytes();
        if (!Number.isSafeInteger(available) || available < 0) throw new DriveError(503, 'Drive capacity is unavailable.');
        const needed = (exists ? 0 : data.length) + Buffer.byteLength(body) * 2 + 4096;
        if (needed > available) throw new DriveError(507, 'The node has insufficient capacity for this drive file.');
      }
      if (!exists) {
        const temporary = path.join(this.storageDir, 'blobs', `.pending-${crypto.randomUUID()}`);
        try { writeSynced(temporary, data); fs.renameSync(temporary, destination); syncDirectory(path.dirname(destination)); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      this.publishIndex(body);
      return { path: filename, ...metadata };
    });
  }
}
