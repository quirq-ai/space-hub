// Disk-backed, append-only Git snapshots for a subhub. Fetches only change
// disposable mirrors; published bundles remain usable without the upstream.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BackupProject {
  fullName: string;
  id: string | number | bigint;
  createdAt: string;
  defaultBranch: string;
  sourceUrl: string;
  estimatedBytes?: number;
  /** Recheck the upstream generation immediately before publishing. */
  verifyIdentity?: () => Promise<boolean>;
}

export interface BackupSnapshot {
  id: string;
  project: string;
  projectId: string;
  projectCreatedAt: string;
  defaultBranch: string;
  sourceUrl: string;
  oid: string;
  refs: Record<string, string>;
  createdAt: string;
  bytes: number;
  bundle?: string;
  sha256?: string;
}

export interface BackupOptions {
  maxBytes?: number;
  maxProjectBytes?: number;
  /** Bytes sharing this node's quota outside the dedicated backup store. */
  externalUsageBytes?: () => number;
}

const SENTINEL = '.spacehub-backup.json';
const ROOT_ENTRIES = new Set([SENTINEL, 'caches', 'staging', 'snapshots', 'readcache', '.writer.lock']);
const HEX_ID = /^[a-f0-9]{32}$/;
const OID = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const BUNDLE = 'repository.bundle';
const MANIFEST = 'manifest.json';
const MiB = 1024 * 1024;
const newId = () => randomBytes(16).toString('hex');

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function present(file: string) {
  try { return fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// Check existing ancestors as well: a Windows junction is a symbolic link
// to lstat, even when the requested final directory does not exist yet.
function noLinks(target: string) {
  for (let next = path.resolve(target); ; next = path.dirname(next)) {
    const stat = present(next);
    if (stat?.isSymbolicLink()) throw new Error(`Backup paths must not contain a symlink or junction: ${next}`);
    if (path.dirname(next) === next) return;
  }
}

function readJson(file: string, limit = 2 * MiB): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid backup metadata file');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRef(ref: string) {
  return ref.startsWith('refs/') && ref.length <= 255 && !/[\x00-\x20\x7f~^:?*[\\]/.test(ref) &&
    !ref.endsWith('/') && !ref.endsWith('.') && !ref.endsWith('.lock') && !ref.includes('..') && !ref.includes('//') &&
    !ref.includes('@{') && !ref.split('/').some(part => !part || part.startsWith('.'));
}

function validProject(fullName: string) {
  const parts = fullName.split('/');
  return parts.length === 2 && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(parts[0]) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) && !['.', '..'].includes(parts[1]) && !parts[1].endsWith('.git');
}

function sourceUrl(value: string) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid backup source URL');
  if (path.isAbsolute(value)) return path.resolve(value);
  if (value.includes(' ')) throw new Error('Invalid backup source URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Backup source must be an absolute local path or URL'); }
  if (!['quirq:', 'spacehub:', 'file:', 'https:', 'http:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) throw new Error('Backup source URLs must omit credentials, query strings and fragments');
  return url.toString();
}

function positive(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive safe integer`);
  return result;
}

function hashFile(file: string) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Backup bundle is not a regular file');
    const buffer = Buffer.alloc(64 * 1024);
    for (let count; (count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function syncFile(file: string) {
  // O_RDWR also permits FlushFileBuffers on Windows; opening an existing
  // file this way does not change its contents or truncate it.
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Backup durability target is not a regular file');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory: string) {
  // Node cannot portably open directories for fsync on Windows. File data
  // is still flushed there; directory-entry durability remains OS-managed.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) throw new Error('Backup durability target is not a directory');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function bytesIn(directory: string): number {
  noLinks(directory);
  const stat = present(directory);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('Backup storage contains an unsupported filesystem entry');
  let total = 0;
  for (const name of fs.readdirSync(directory)) total += bytesIn(path.join(directory, name));
  if (!Number.isSafeInteger(total)) throw new Error('Backup storage size exceeds the supported range');
  return total;
}

export class BackupStore {
  readonly storageDir: string;
  readonly maxBytes: number;
  readonly maxProjectBytes: number;
  private readonly externalUsageBytes: () => number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(storageDir: string, options: BackupOptions = {}) {
    if (!path.isAbsolute(storageDir)) throw new Error('Backup storage must be an absolute dedicated directory');
    this.storageDir = path.resolve(storageDir);
    if (this.storageDir === path.parse(this.storageDir).root || this.storageDir === path.resolve(os.homedir())) {
      throw new Error('A filesystem root or home directory cannot be backup storage');
    }
    this.maxBytes = positive(options.maxBytes, 10 * 1024 * MiB, 'maxBytes');
    this.maxProjectBytes = positive(options.maxProjectBytes, 256 * MiB, 'maxProjectBytes');
    if (options.externalUsageBytes !== undefined && typeof options.externalUsageBytes !== 'function') {
      throw new Error('externalUsageBytes must be a function');
    }
    this.externalUsageBytes = options.externalUsageBytes ?? (() => 0);
  }

  initialize(): void {
    noLinks(this.storageDir);
    const existing = present(this.storageDir);
    if (existing && !existing.isDirectory()) throw new Error('Backup storage must be a directory');
    if (!existing) fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    const marker = path.join(this.storageDir, SENTINEL);
    if (!present(marker)) {
      if (fs.readdirSync(this.storageDir).length) throw new Error('Backup storage contains unrelated data; choose a dedicated empty directory');
      fs.writeFileSync(marker, `${JSON.stringify({ kind: 'spacehub-backup', version: 1, id: newId() })}\n`, { flag: 'wx', mode: 0o600 });
    }
    const sentinel = readJson(marker, 4096);
    if (!record(sentinel) || sentinel.kind !== 'spacehub-backup' || sentinel.version !== 1 || typeof sentinel.id !== 'string' || !HEX_ID.test(sentinel.id)) {
      throw new Error('Backup storage marker is invalid or uses an unsupported version');
    }
    for (const name of fs.readdirSync(this.storageDir)) {
      if (!ROOT_ENTRIES.has(name)) throw new Error('Backup storage contains unrelated data');
      this.safe(path.join(this.storageDir, name));
    }
    for (const name of ['caches', 'staging', 'snapshots', 'readcache']) {
      const directory = this.safe(path.join(this.storageDir, name));
      if (present(directory) && !fs.lstatSync(directory).isDirectory()) throw new Error('Invalid backup storage layout');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.mkdirSync(this.safe(path.join(this.storageDir, 'staging', '.hooks')), { recursive: true });
  }

  private safe(target: string) {
    const resolved = path.resolve(target);
    if (!inside(this.storageDir, resolved)) throw new Error('Backup path escapes its storage root');
    noLinks(resolved);
    return resolved;
  }

  private remove(target: string) {
    const checked = this.safe(target);
    if (checked === this.storageDir) throw new Error('Refusing to remove the backup storage root');
    fs.rmSync(checked, { recursive: true, force: true });
  }

  private syncSnapshot(directory: string, snapshot: BackupSnapshot) {
    if (snapshot.bundle) syncFile(this.safe(path.join(directory, snapshot.bundle)));
    syncFile(this.safe(path.join(directory, MANIFEST)));
    syncDirectory(this.safe(directory));
  }

  private syncSnapshotParents() {
    syncDirectory(this.safe(path.join(this.storageDir, 'snapshots')));
    syncDirectory(this.safe(path.join(this.storageDir, 'staging')));
    // Persist the managed parents' links as well on the first generation.
    syncDirectory(this.safe(this.storageDir));
  }

  private room(extra = 0) {
    const used = bytesIn(this.storageDir);
    const external = this.externalUsageBytes();
    if (!Number.isSafeInteger(external) || external < 0) throw new Error('externalUsageBytes must return a non-negative safe integer');
    if (used + external + extra > this.maxBytes) throw new Error('Backup storage quota exceeded; retained snapshots were kept');
    const disk = fs.statfsSync(this.storageDir);
    if (Number(disk.bavail) * Number(disk.bsize) < Math.max(extra, 64 * 1024)) throw new Error('Insufficient free space for another backup');
  }

  private async writer<T>(work: () => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await preceding;
    let descriptor: number | undefined;
    const lock = path.join(this.storageDir, '.writer.lock');
    try {
      this.initialize();
      try { descriptor = fs.openSync(this.safe(lock), 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Backup storage has a writer lock; inspect any stale lock before removing it');
        throw error;
      }
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return await work();
    } finally {
      try { if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(this.safe(lock)); } }
      finally { release(); }
    }
  }

  private git(repo: string, args: string[], env: Record<string, string> = {}, maxOutput = 2 * MiB): Promise<Buffer> {
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const key of Object.keys(gitEnv)) {
      if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|TRACE.*|TEMPLATE_DIR|EXTERNAL_DIFF|PROXY_COMMAND|SSH_COMMAND)$/.test(key)) delete gitEnv[key];
    }
    delete gitEnv.SPACEHUB_DEBUG;
    Object.assign(gitEnv, { GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
    const secretValues = Object.entries(gitEnv).filter(([key, value]) => value && /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key)).map(([, value]) => value!);
    const redact = (text: string) => secretValues.reduce((result, secret) => result.split(secret).join('[redacted]'), text);
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', repo, '-c', `core.hooksPath=${path.join(this.storageDir, 'staging', '.hooks')}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
        env: gitEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let failure: Error | undefined;
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      };
      const timeout = setTimeout(() => { failure = new Error('Backup Git operation timed out'); kill(); }, 5 * 60_000);
      child.stdout.on('data', (data: Buffer) => {
        size += data.length;
        if (size > maxOutput) { failure = new Error('Backup Git output exceeds its size limit'); kill(); }
        else out.push(data);
      });
      child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-64 * 1024); });
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Backup git ${args[0]} failed: ${redact(stderr.trim().split('\n').slice(-3).join(' ')) || code}`));
        else resolve(Buffer.concat(out));
      });
    });
  }

  private async refs(repo: string) {
    const text = (await this.git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).toString('utf8');
    const refs: Record<string, string> = {};
    for (const line of text.split('\n').filter(Boolean)) {
      const [ref, oid] = line.trim().split(' ');
      if (!validRef(ref) || !OID.test(oid)) throw new Error('Git returned invalid backup refs');
      refs[ref] = oid;
    }
    return Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)));
  }

  private snapshot(id: string, verifyBundle = false): BackupSnapshot {
    if (!HEX_ID.test(id)) throw new Error('Invalid backup snapshot ID');
    const directory = this.safe(path.join(this.storageDir, 'snapshots', id));
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid backup snapshot directory');
    const value = readJson(this.safe(path.join(directory, MANIFEST)));
    if (!record(value) || value.id !== id || typeof value.project !== 'string' || !validProject(value.project) ||
        typeof value.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.projectId) ||
        typeof value.projectCreatedAt !== 'string' || Number.isNaN(Date.parse(value.projectCreatedAt)) ||
        typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) ||
        typeof value.defaultBranch !== 'string' || !validRef(`refs/heads/${value.defaultBranch}`) ||
        typeof value.sourceUrl !== 'string' || typeof value.oid !== 'string' || (value.oid !== '' && !OID.test(value.oid)) ||
        typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !record(value.refs)) throw new Error('Invalid backup snapshot manifest');
    const refs: Record<string, string> = {};
    for (const [ref, oid] of Object.entries(value.refs)) {
      if (!validRef(ref) || typeof oid !== 'string' || !OID.test(oid)) throw new Error('Invalid backup snapshot refs');
      refs[ref] = oid;
    }
    if ((refs[`refs/heads/${value.defaultBranch}`] ?? '') !== value.oid) throw new Error('Backup snapshot HEAD does not match its refs');
    const result: BackupSnapshot = {
      id, project: value.project, projectId: value.projectId, projectCreatedAt: value.projectCreatedAt,
      defaultBranch: value.defaultBranch, sourceUrl: sourceUrl(value.sourceUrl), oid: value.oid, refs,
      createdAt: value.createdAt, bytes: value.bytes,
    };
    if (Object.keys(refs).length) {
      if (value.bundle !== BUNDLE || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) throw new Error('Invalid backup bundle metadata');
      const file = this.safe(path.join(directory, BUNDLE));
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > value.bytes) throw new Error('Invalid backup bundle');
      if (verifyBundle && hashFile(file) !== value.sha256) throw new Error('Backup bundle checksum mismatch');
      result.bundle = BUNDLE;
      result.sha256 = value.sha256;
    } else if (value.bundle !== undefined || value.sha256 !== undefined) throw new Error('An empty snapshot cannot have a bundle');
    return result;
  }

  list(project?: string): BackupSnapshot[] {
    this.initialize();
    if (project !== undefined && !validProject(project)) throw new Error('Invalid backup project name');
    const snapshots: BackupSnapshot[] = [];
    for (const id of fs.readdirSync(path.join(this.storageDir, 'snapshots'))) {
      if (!HEX_ID.test(id)) continue;
      try { const value = this.snapshot(id, true); if (!project || value.project === project) snapshots.push(value); }
      catch { /* Incomplete or corrupt generations are never advertised. */ }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async backup(input: BackupProject, env: Record<string, string> = {}): Promise<BackupSnapshot> {
    if (!validProject(input.fullName) || !validRef(`refs/heads/${input.defaultBranch}`) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(String(input.id)) || Number.isNaN(Date.parse(input.createdAt))) throw new Error('Invalid backup project metadata');
    const source = sourceUrl(input.sourceUrl);
    if (input.estimatedBytes !== undefined && (!Number.isSafeInteger(input.estimatedBytes) || input.estimatedBytes < 0 || input.estimatedBytes > this.maxProjectBytes)) {
      throw new Error('Project exceeds the backup project size limit');
    }
    const identity = { project: input.fullName, projectId: String(input.id), projectCreatedAt: new Date(input.createdAt).toISOString(), defaultBranch: input.defaultBranch, sourceUrl: source };
    const key = createHash('sha256').update(JSON.stringify([source, identity.project, identity.projectId, identity.projectCreatedAt])).digest('hex');
    return this.writer(async () => {
      const cache = this.safe(path.join(this.storageDir, 'caches', `${key}.git`));
      let stage: string | undefined;
      try {
        // This is a conservative preflight and post-operation accounting,
        // not an OS-enforced disk quota. The remote helper buffers packs.
        this.room(input.estimatedBytes ?? 0);
        if (!present(cache)) await this.git(path.dirname(cache), ['clone', '--mirror', '--no-hardlinks', '--template=', source, cache], env);
        else {
          bytesIn(cache);
          await this.git(cache, ['fetch', '--prune', '--no-recurse-submodules', 'origin'], env);
        }
        await this.git(cache, ['symbolic-ref', 'HEAD', `refs/heads/${input.defaultBranch}`]);
        await this.git(cache, ['fsck', '--full', '--no-reflogs']);
        if (bytesIn(cache) > this.maxProjectBytes) throw new Error('Project exceeds the backup project size limit');
        this.room();
        const refs = await this.refs(cache);
        const latest = this.list(input.fullName).find(snapshot => snapshot.projectId === identity.projectId && snapshot.projectCreatedAt === identity.projectCreatedAt && snapshot.sourceUrl === source);
        if (latest && latest.defaultBranch === input.defaultBranch && JSON.stringify(latest.refs) === JSON.stringify(refs)) {
          this.snapshot(latest.id, true);
          if (input.verifyIdentity && !(await input.verifyIdentity())) throw new Error('Upstream project identity changed during backup');
          this.room();
          this.syncSnapshot(path.join(this.storageDir, 'snapshots', latest.id), latest);
          this.syncSnapshotParents();
          return latest;
        }
        const id = newId();
        stage = this.safe(path.join(this.storageDir, 'staging', id));
        fs.mkdirSync(stage, { mode: 0o700 });
        const newest = this.list()[0];
        const createdAt = new Date(Math.max(Date.now(), newest ? Date.parse(newest.createdAt) + 1 : 0)).toISOString();
        const snapshot: BackupSnapshot = { id, ...identity, oid: refs[`refs/heads/${input.defaultBranch}`] ?? '', refs, createdAt, bytes: 0 };
        let bundleBytes = 0;
        if (Object.keys(refs).length) {
          const bundle = this.safe(path.join(stage, BUNDLE));
          await this.git(cache, ['bundle', 'create', bundle, '--all']);
          await this.git(cache, ['bundle', 'verify', bundle]);
          bundleBytes = fs.statSync(bundle).size;
          if (bundleBytes > this.maxProjectBytes) throw new Error('Project exceeds the backup project size limit');
          snapshot.bundle = BUNDLE;
          snapshot.sha256 = hashFile(bundle);
        }
        // Include manifest bytes without leaving a self-size discrepancy.
        let body = '';
        for (let attempt = 0; attempt < 10; attempt++) {
          body = `${JSON.stringify(snapshot, null, 2)}\n`;
          const size = bundleBytes + Buffer.byteLength(body);
          if (snapshot.bytes === size) break;
          snapshot.bytes = size;
        }
        fs.writeFileSync(this.safe(path.join(stage, MANIFEST)), body, { flag: 'wx', mode: 0o600 });
        if (input.verifyIdentity && !(await input.verifyIdentity())) throw new Error('Upstream project identity changed during backup');
        this.room();
        this.safe(stage);
        this.syncSnapshot(stage, snapshot);
        fs.renameSync(stage, this.safe(path.join(this.storageDir, 'snapshots', id)));
        stage = undefined;
        this.syncSnapshotParents();
        return snapshot;
      } catch (error) {
        // A failed cache is disposable. Published generations are never
        // deleted, even when the upstream disappeared or force-pushed.
        if (present(cache)) this.remove(cache);
        throw error;
      } finally { if (stage && present(stage)) this.remove(stage); }
    });
  }

  bundlePath(id: string): string | undefined {
    this.initialize();
    const snapshot = this.snapshot(id, true);
    return snapshot.bundle ? this.safe(path.join(this.storageDir, 'snapshots', id, snapshot.bundle)) : undefined;
  }

  private async populate(snapshot: BackupSnapshot, destination: string) {
    if (snapshot.bundle) await this.git(path.dirname(destination), ['clone', '--mirror', '--no-hardlinks', '--template=', this.bundlePath(snapshot.id)!, destination]);
    else await this.git(path.dirname(destination), ['init', '--bare', '--template=', destination]);
    if (snapshot.bundle) await this.git(destination, ['config', '--remove-section', 'remote.origin']);
    await this.git(destination, ['symbolic-ref', 'HEAD', `refs/heads/${snapshot.defaultBranch}`]);
    await this.git(destination, ['fsck', '--full', '--no-reflogs']);
    if (JSON.stringify(await this.refs(destination)) !== JSON.stringify(snapshot.refs)) throw new Error('Restored backup refs do not match the snapshot');
  }

  async restore(id: string, newDestination: string): Promise<{ directory: string; snapshot: BackupSnapshot }> {
    this.initialize();
    const snapshot = this.snapshot(id, true);
    if (!path.isAbsolute(newDestination)) throw new Error('Restore destination must be an absolute new directory');
    const destination = path.resolve(newDestination);
    if (inside(this.storageDir, destination) || inside(destination, this.storageDir) || destination === path.parse(destination).root) throw new Error('Restore destination must be outside backup storage');
    noLinks(destination);
    if (present(destination)) throw new Error('Restore destination already exists');
    if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error('Restore destination parent must exist');
    fs.mkdirSync(destination, { mode: 0o700 });
    const owned = fs.lstatSync(destination);
    try {
      await this.populate(snapshot, destination);
      return { directory: destination, snapshot };
    } catch (error) {
      noLinks(destination);
      const now = present(destination);
      if (now?.isDirectory() && now.dev === owned.dev && now.ino === owned.ino && now.birthtimeMs === owned.birthtimeMs) fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  private async readable(snapshot: BackupSnapshot) {
    const cache = this.safe(path.join(this.storageDir, 'readcache', `${snapshot.id}.git`));
    if (!present(cache)) {
      await this.writer(async () => {
        if (present(cache)) return;
        this.room(snapshot.bytes);
        const stage = this.safe(path.join(this.storageDir, 'staging', newId()));
        fs.mkdirSync(stage, { mode: 0o700 });
        try {
          const repo = path.join(stage, 'repo.git');
          await this.populate(snapshot, repo);
          fs.writeFileSync(path.join(repo, '.spacehub-readcache.json'), `${JSON.stringify({ snapshot: snapshot.id, sha256: snapshot.sha256 })}\n`);
          this.room();
          fs.renameSync(this.safe(repo), cache);
        } finally { this.remove(stage); }
      });
    }
    const marker = readJson(this.safe(path.join(cache, '.spacehub-readcache.json')), 4096);
    if (!record(marker) || marker.snapshot !== snapshot.id || marker.sha256 !== snapshot.sha256) throw new Error('Invalid backup read cache');
    bytesIn(cache);
    if (JSON.stringify(await this.refs(cache)) !== JSON.stringify(snapshot.refs)) throw new Error('Backup read cache refs changed');
    await this.git(cache, ['fsck', '--full', '--no-reflogs']);
    return cache;
  }

  async readFile(id: string, oid: string, filePath: string, maxBytes = 8 * MiB): Promise<Uint8Array> {
    this.initialize();
    if (!OID.test(oid)) throw new Error('Invalid backup object ID');
    if (!filePath || filePath.length > 4096 || /[\\\x00-\x1f\x7f]/.test(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid backup file path');
    positive(maxBytes, 8 * MiB, 'maxBytes');
    const snapshot = this.snapshot(id, true);
    if (!snapshot.bundle) throw new Error('An empty snapshot has no files');
    const repo = await this.readable(snapshot);
    if ((await this.git(repo, ['cat-file', '-t', oid])).toString().trim() !== 'commit') throw new Error('Backup file revision must be a commit');
    const reachable = (await this.git(repo, ['for-each-ref', '--contains', oid, '--count=1', '--format=%(refname)'])).toString().trim();
    if (!reachable) throw new Error('Object is not reachable from this backup snapshot');
    const object = `${oid}:${filePath}`;
    if ((await this.git(repo, ['cat-file', '-t', object])).toString().trim() !== 'blob') throw new Error('Backup path is not a file');
    const size = Number((await this.git(repo, ['cat-file', '-s', object])).toString().trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('Backup file exceeds its size limit');
    return new Uint8Array(await this.git(repo, ['cat-file', 'blob', object], {}, maxBytes));
  }
}
