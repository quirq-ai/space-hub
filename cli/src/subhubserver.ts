// A backup node serves fixed, authenticated read endpoints and stores assigned
// work durably. It deliberately has no work runner, claim, or execution API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DriveError, DRIVE_MAX_FILE_BYTES, type DriveFile, type DriveStats } from './subhubdrive.ts';

const BODY_BYTES = 256 * 1024;
const FILE_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SPACE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const PROJECT = /^[A-Za-z0-9._-]{1,100}$/;
const SNAPSHOT = /^[a-f0-9]{32}$/;
const OID = /^[a-f0-9]{40}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

class NodeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface NodeWork {
  id: string;
  space: string;
  project: string;
  [key: string]: unknown;
}

export interface NodeBackupSnapshot {
  id: string;
  project: string;
  oid: string;
  refs?: Record<string, string>;
}

export interface NodeBackup {
  list(project?: string): NodeBackupSnapshot[];
  readFile(snapshotId: string, oid: string, filename: string, maxBytes: number): Promise<Uint8Array>;
  bundlePath(id: string): string | undefined;
}
export interface NodeDrive {
  list(prefix?: string): DriveFile[];
  stats(): DriveStats;
  read(filename: string): { metadata: DriveFile; data: Buffer };
  write(filename: string, data: Buffer, expectedVersion: string | null): DriveFile;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function projectSpace(project: unknown): string | null {
  if (typeof project !== 'string') return null;
  const parts = project.split('/');
  if (parts.length !== 2 || !SPACE.test(parts[0]) || !PROJECT.test(parts[1]) || parts[1] === '.' || parts[1] === '..' || parts[1].endsWith('.git')) return null;
  return parts[0];
}

/** Only JSON data is accepted; stable key order makes duplicate deliveries safe. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new NodeError(400, 'Work is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (object(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new NodeError(400, 'Work must contain JSON data.');
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  throw new NodeError(400, 'Work must contain JSON data.');
}

function workRecord(value: unknown): { work: NodeWork; json: string } {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id)) throw new NodeError(400, 'Work needs a safe ID of at most 128 characters.');
  if (typeof value.space !== 'string' || !SPACE.test(value.space) || projectSpace(value.project) !== value.space) throw new NodeError(400, 'Work needs a project in its space.');
  const json = JSON.stringify(canonical(value)) + '\n';
  if (Buffer.byteLength(json) > BODY_BYTES) throw new NodeError(413, 'Work is larger than 256 KiB.');
  return { work: JSON.parse(json) as NodeWork, json };
}

/** Reject symlinks/junctions anywhere in the storage path, including parents. */
function directory(dir: string, create: boolean) {
  const absolute = path.resolve(dir);
  const root = path.parse(absolute).root;
  let at = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (create && !fs.existsSync(at)) {
      try { fs.mkdirSync(at, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new NodeError(409, 'Storage must use ordinary directories.');
  }
  return absolute;
}

function regular(filename: string): fs.Stats {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new NodeError(409, 'Stored data must be a regular file.');
  return stat;
}

function syncDirectory(dir: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not permit opening a directory this way. Files are still
    // fsynced before the atomic rename; POSIX additionally syncs its directory.
    if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A private append-only work spool. put() is synchronous, so HTTP handlers
 * and the node's assignment poller cannot race each other in this process. */
export class NodeWorkSpool {
  readonly dir: string;

  constructor(storageDir: string) {
    const root = directory(storageDir, true);
    this.dir = directory(path.join(root, 'work'), true);
  }

  private filename(id: string) {
    if (!ID.test(id)) throw new NodeError(400, 'Invalid work ID.');
    directory(this.dir, false);
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string): NodeWork | undefined {
    const filename = this.filename(id);
    let fd: number | undefined;
    try {
      regular(filename);
      fd = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
      if (fs.fstatSync(fd).size > BODY_BYTES) throw new NodeError(409, 'Stored work is invalid.');
      const record = workRecord(JSON.parse(fs.readFileSync(fd, 'utf8')));
      if (record.work.id !== id) throw new NodeError(409, 'Stored work has a different ID.');
      return record.work;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  put(value: unknown): NodeWork {
    const { work, json } = workRecord(value);
    const filename = this.filename(work.id);
    const existing = this.get(work.id);
    if (existing) {
      if (workRecord(existing).json !== json) throw new NodeError(409, 'This work ID already contains different work.');
      return existing;
    }
    const temporary = path.join(this.dir, `.pending-${crypto.randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // The destination was checked above, and synchronous puts are serialized.
      // An incomplete temporary file is never returned by list() after a crash.
      fs.renameSync(temporary, filename);
      syncDirectory(this.dir);
      return work;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  list(): NodeWork[] {
    directory(this.dir, false);
    return fs.readdirSync(this.dir).filter(name => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name)).sort()
      .map(name => this.get(name.slice(0, -5))).filter((work): work is NodeWork => !!work);
  }
}

function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new NodeError(415, 'Send JSON.');
  if (Number(req.headers['content-length']) > BODY_BYTES) { req.resume(); throw new NodeError(413, 'Work is larger than 256 KiB.'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_BYTES) { settled = true; chunks.length = 0; reject(new NodeError(413, 'Work is larger than 256 KiB.')); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new NodeError(400, 'Send valid JSON.')); }
    });
    req.on('error', error => { if (!settled) { settled = true; reject(error); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new NodeError(400, 'The request was interrupted.')); } });
  });
}

function parameter(url: URL, name: string): string {
  if (url.searchParams.getAll(name).length !== 1) throw new NodeError(400, `Supply one ${name}.`);
  return url.searchParams.get(name)!;
}

function readDriveBytes(req: http.IncomingMessage): Promise<Buffer> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new NodeError(415, 'Send application/octet-stream bytes.');
  if (Number(req.headers['content-length']) > DRIVE_MAX_FILE_BYTES) { req.resume(); throw new NodeError(413, 'Drive files are limited to 16 MiB.'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > DRIVE_MAX_FILE_BYTES) { settled = true; chunks.length = 0; reject(new NodeError(413, 'Drive files are limited to 16 MiB.')); }
      else chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', error => { if (!settled) { settled = true; reject(error); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new NodeError(400, 'The request was interrupted.')); } });
  });
}

function filePath(filename: string) {
  if (!filename || filename.length > 4096 || filename.startsWith('/') || /[\\\0:]/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..')) throw new NodeError(400, 'Use a relative file path inside the project.');
}

export interface SubhubServerOptions {
  nodeId: string;
  space: string;
  token: string;
  storageDir: string;
  /** BackupStore may keep bundles beside, rather than inside, the spool. */
  backupRoot?: string;
  /** Remaining capacity across both retained backups and queued work. */
  availableBytes?: () => number;
  backup: NodeBackup;
  drive?: NodeDrive;
  mode?: () => 'backup' | 'drive';
}

export function createSubhubServer(options: SubhubServerOptions): http.Server {
  const { nodeId, space, token, backup } = options;
  if (!ID.test(nodeId) || !SPACE.test(space) || !token) throw new Error('Configure a node ID, space and nonempty node token.');
  const root = directory(options.storageDir, true);
  const backupRoot = path.resolve(options.backupRoot ?? root);
  const spool = new NodeWorkSpool(root);
  const expected = crypto.createHash('sha256').update(token).digest();
  const snapshots = (project?: string) => backup.list(project).filter(item => projectSpace(item.project) === space);
  const snapshot = (id: string) => {
    if (!SNAPSHOT.test(id)) throw new NodeError(400, 'Invalid snapshot ID.');
    const found = snapshots().find(item => item.id === id);
    if (!found) throw new NodeError(404, 'Snapshot not found.');
    return found;
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new NodeError(400, 'Use a local API path.');
    const url = new URL(req.url, 'http://subhub.local');
    const route = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (route === '/healthz') {
      if (!read) throw new NodeError(405, 'Read health with GET.');
      return json(req, res, 200, { ok: true, nodeId, version: 1 });
    }
    if (route !== '/v1' && !route.startsWith('/v1/')) throw new NodeError(404, 'No such route.');
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const supplied = crypto.createHash('sha256').update(bearer ?? '').digest();
    if (!crypto.timingSafeEqual(expected, supplied) || !bearer) throw new NodeError(401, 'A node bearer token is required.');
    if (!read && req.headers.origin !== undefined) throw new NodeError(403, 'Browser writes are not accepted.');

    if (route === '/v1/drive/files' || route === '/v1/drive/file') {
      if (options.mode?.() !== 'drive') throw new NodeError(409, 'The node is not in drive mode.');
      if (!options.drive) throw new NodeError(503, 'Drive storage is unavailable.');
      const drive = options.drive;
      const allowed = route.endsWith('/files') ? 'prefix' : 'path';
      for (const key of url.searchParams.keys()) if (key !== allowed || url.searchParams.getAll(key).length !== 1) throw new NodeError(400, 'Unsupported drive parameters.');
      if (route === '/v1/drive/files') {
        if (!read) throw new NodeError(405, 'Read drive files with GET.');
        const payload = { files: drive.list(url.searchParams.get('prefix') ?? ''), stats: drive.stats() };
        if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024) throw new NodeError(413, 'Narrow the drive listing with a prefix.');
        return json(req, res, 200, payload);
      }
      const filename = parameter(url, 'path');
      if (read) {
        const { metadata, data } = drive.read(filename);
        if (data.length > DRIVE_MAX_FILE_BYTES) throw new NodeError(413, 'Drive files are limited to 16 MiB.');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, etag: `"${metadata.sha256}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      }
      if (req.method !== 'PUT') throw new NodeError(405, 'Write drive files with PUT.');
      const match = req.headers['if-match'];
      const none = req.headers['if-none-match'];
      let expected: string | null;
      if (match !== undefined && none !== undefined) throw new NodeError(400, 'Use one drive write precondition.');
      if (none === '*') expected = null;
      else if (none !== undefined) throw new NodeError(400, 'Create drive files with If-None-Match: *.');
      else if (match !== undefined) {
        const version = /^(?:"([a-f0-9]{64})"|([a-f0-9]{64}))$/.exec(match);
        if (!version) throw new NodeError(400, 'Use the file SHA-256 as If-Match.');
        expected = version[1] ?? version[2];
      } else throw new NodeError(428, 'If-Match or If-None-Match is required.');
      const data = await readDriveBytes(req);
      // Mode can change while a client uploads a file.
      if (options.mode?.() !== 'drive') throw new NodeError(409, 'The node is not in drive mode.');
      const metadata = drive.write(filename, data, expected);
      res.setHeader('etag', `"${metadata.sha256}"`);
      return json(req, res, 200, { file: metadata });
    }

    if (route === '/v1/snapshots') {
      if (!read) throw new NodeError(405, 'Read snapshots with GET.');
      const project = url.searchParams.has('project') ? parameter(url, 'project') : undefined;
      if (project !== undefined && projectSpace(project) !== space) throw new NodeError(403, 'The project is outside this node\'s space.');
      return json(req, res, 200, { snapshots: snapshots(project) });
    }
    if (route === '/v1/file') {
      if (!read) throw new NodeError(405, 'Read files with GET.');
      const project = parameter(url, 'project');
      if (projectSpace(project) !== space) throw new NodeError(403, 'The project is outside this node\'s space.');
      const id = parameter(url, 'snapshot');
      const oid = parameter(url, 'oid');
      const filename = parameter(url, 'path');
      if (!OID.test(oid)) throw new NodeError(400, 'Invalid commit ID.');
      filePath(filename);
      const manifest = snapshot(id);
      if (manifest.project !== project || (manifest.oid !== oid && !Object.values(manifest.refs ?? {}).includes(oid))) throw new NodeError(404, 'This snapshot does not contain the requested project and commit.');
      const data = await backup.readFile(id, oid, filename, FILE_BYTES);
      if (!(data instanceof Uint8Array) || data.byteLength > FILE_BYTES) throw new NodeError(413, 'The file is larger than 8 MiB.');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-oid': oid, 'x-spacehub-snapshot': id });
      res.end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    const bundle = /^\/v1\/snapshots\/([^/]+)\/bundle$/.exec(route);
    if (bundle) {
      if (!read) throw new NodeError(405, 'Read bundles with GET.');
      const manifest = snapshot(bundle[1]);
      const filename = backup.bundlePath(manifest.id);
      if (!filename) throw new NodeError(404, 'No bundle is available.');
      directory(backupRoot, false);
      const relative = path.relative(backupRoot, path.resolve(filename));
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || path.basename(filename) !== 'repository.bundle') throw new NodeError(409, 'The backup bundle is outside node storage.');
      directory(path.dirname(filename), false);
      regular(filename);
      let fd: number | undefined = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new NodeError(409, 'Stored data must be a regular file.');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size, 'content-disposition': 'attachment; filename="repository.bundle"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-snapshot': manifest.id });
        if (req.method === 'HEAD') res.end();
        else {
          const stream = fs.createReadStream(filename, { fd, autoClose: true });
          fd = undefined;
          await pipeline(stream, res);
        }
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      return;
    }
    if (route === '/v1/work') {
      if (!read) throw new NodeError(405, 'Read queued work with GET.');
      return json(req, res, 200, { work: spool.list().filter(item => item.space === space) });
    }
    const work = /^\/v1\/work\/([^/]+)$/.exec(route);
    if (work) {
      if (!ID.test(work[1])) throw new NodeError(400, 'Invalid work ID.');
      if (read) {
        const stored = spool.get(work[1]);
        if (!stored || stored.space !== space) throw new NodeError(404, 'Work not found.');
        return json(req, res, 200, { work: stored });
      }
      if (req.method !== 'PUT') throw new NodeError(405, 'Store assigned work with PUT.');
      const input = await readJson(req);
      if (!object(input) || input.id !== work[1]) throw new NodeError(400, 'The work ID must match its URL.');
      if (input.space !== space || projectSpace(input.project) !== space || (input.nodeId !== undefined && input.nodeId !== nodeId)) throw new NodeError(403, 'Work is assigned outside this node\'s scope.');
      // Already stored deliveries must remain retryable when the node is full.
      // put() below still rejects a conflicting payload for an existing ID.
      if (!spool.get(work[1]) && options.availableBytes) {
        const { json: durable } = workRecord(input);
        const available = options.availableBytes();
        if (!Number.isSafeInteger(available) || available < 0) throw new NodeError(503, 'Node capacity is unavailable.');
        const needed = Buffer.byteLength(durable) * 2 + 1024;
        if (needed > available) throw new NodeError(507, 'The node has insufficient capacity for this work.');
      }
      return json(req, res, 200, { ok: true, work: spool.put(input) });
    }
    throw new NodeError(404, 'No such route.');
  }

  return http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000 }, (req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof NodeError ? error.status : error && typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      json(req, res, status, { error: error instanceof NodeError || error instanceof DriveError ? error.message : status === 404 ? 'Stored data not found.' : 'Node storage request failed.' });
    });
  });
}
