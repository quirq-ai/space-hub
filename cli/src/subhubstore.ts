// Private, single-writer control state for sub-hubs. No hub credentials live
// here: node tokens authorize only delivery/heartbeat, never project writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NODE_STALE_MS = 90_000;
export const ACTIVITY_LIMIT = 1000;
const MARKER = '.subhub-store';
const MARKER_TEXT = 'spacehub-subhub-store-v1\n';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SPACE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OID = /^[a-f0-9]{40}$/;
const SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SubhubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, message: string): never => { throw new SubhubError(status, message); };
const copy = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: number, name: string, positive = false) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail(400, `${name} must be ${positive ? 'a positive' : 'a non-negative'} safe integer`);
  return value;
};
export function nodeId(value: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(400, 'invalid node id');
  return value;
}
export function nodeUrl(value?: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return fail(400, 'node URL must be an https address'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) fail(400, 'node URL must use https (or local http), without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}
function spaceName(value: string) {
  if (typeof value !== 'string' || !SPACE.test(value)) fail(400, 'invalid space');
  return value;
}
function projectName(space: string, value: string) {
  if (typeof value !== 'string') return fail(400, 'invalid project');
  const full = value.includes('/') ? value : `${space}/${value}`;
  const parts = full.split('/');
  if (parts.length !== 2 || parts[0] !== space || !NAME.test(parts[1]) || ['.', '..'].includes(parts[1]) || parts[1].endsWith('.git')) fail(400, 'project must belong to the node/work space');
  return full;
}
function actorName(value: string) {
  if (typeof value !== 'string' || !SPACE.test(value)) fail(400, 'invalid owner or worker');
  return value;
}

export interface Backup { project: string; oid: string; snapshot: string; bytes: number }
export type NodeMode = 'backup' | 'drive';
/** Logical manifest totals; repeated content may share physical storage. */
export interface DriveSummary { files: number; bytes: number; updatedAt: number | null }
export interface NodeSettings { mode?: NodeMode; enabled?: boolean; label?: string }
export interface HeartbeatInput {
  freeBytes: number; backups: Backup[]; status?: 'ready' | 'degraded'; errors?: string[]; drive?: DriveSummary;
}
export interface PublicNode {
  id: string; space: string; owner: string; url?: string; capacityBytes: number;
  freeBytes: number; backups: Backup[]; createdAt: number; seenAt: number | null; healthy: boolean;
  mode: NodeMode; enabled: boolean; label: string; drive: DriveSummary; status: 'ready' | 'degraded'; errors: string[];
}
interface StoredNode extends Omit<PublicNode, 'healthy'> { token: string; online: boolean }
export interface WorkItem {
  id: string; space: string; project: string; title: string; text: string; actor: string;
  idempotencyKey: string; createdAt: number; updatedAt: number; status: 'queued' | 'claimed' | 'completed';
  assignedNode: string | null; assignedAt: number | null; receivedAt: number | null;
  worker: string | null; fence: number; leaseUntil: number | null; result: string | null;
}
export type ActivityKind = 'node_registered' | 'node_settings' | 'node_online' | 'node_reconnected' | 'node_offline' | 'node_status' | 'backup_changed' | 'drive_changed' | 'work_enqueued' | 'work_assigned' | 'work_received' | 'work_claimed' | 'work_completed' | 'work_released';
export interface SubhubActivity {
  id: string; at: number; space: string; nodeId: string | null; kind: ActivityKind; subject: string; text: string; actor?: string;
}
interface State { version: 1; nodes: Record<string, StoredNode>; work: Record<string, WorkItem>; activity: SubhubActivity[] }
export interface Route extends Backup { nodeId: string; url: string }
export interface RegisterInput extends NodeSettings { id: string; space: string; url?: string; capacityBytes: number }
export interface EnqueueInput { space: string; project: string; title: string; text: string; idempotencyKey: string }

function settings(input: NodeSettings): NodeSettings {
  if (!record(input)) return fail(400, 'invalid node settings');
  for (const key of Object.keys(input)) if (!['mode', 'enabled', 'label'].includes(key)) fail(400, 'unsupported node setting');
  const out: NodeSettings = {};
  if (input.mode !== undefined) {
    if (input.mode !== 'backup' && input.mode !== 'drive') return fail(400, 'node mode must be backup or drive');
    out.mode = input.mode;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return fail(400, 'enabled must be a boolean');
    out.enabled = input.enabled;
  }
  if (input.label !== undefined) {
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120) return fail(400, 'node label must contain 1 to 120 characters');
    out.label = input.label.trim();
  }
  return out;
}
function driveSummary(value: DriveSummary): DriveSummary {
  if (!record(value)) return fail(400, 'invalid drive summary');
  bytes(value.files, 'drive files'); bytes(value.bytes, 'drive bytes');
  if (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) fail(400, 'invalid drive update time');
  return { files: value.files, bytes: value.bytes, updatedAt: value.updatedAt };
}
function runtimeErrors(value: string[], token: string): string[] {
  if (!Array.isArray(value) || value.length > 10 || value.some(error => typeof error !== 'string' || error.length > 500)) return fail(400, 'errors must be at most 10 strings of up to 500 characters');
  return [...new Set(value.map(error => error.trim().replaceAll(token, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')).filter(Boolean))].sort();
}

// Never adopt an unrelated directory, nor follow a symlink/junction to it.
function noSymlinks(filename: string) {
  const resolved = path.resolve(filename);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(400, 'sub-hub storage must not contain symlinks'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function regularFile(filename: string) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) fail(400, 'sub-hub state must be a regular file');
}
function fsyncDir(dir: string) {
  let fd: number | undefined;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (error) {
    // Windows does not support opening/fsyncing directory handles through fs.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EBADF', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeSynced(filename: string, body: string) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class SubhubStore {
  private dir: string;
  private now: () => number;
  private state: State;
  private lockNonce = crypto.randomBytes(16).toString('hex');
  private closed = false;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = path.resolve(dir);
    this.now = now;
    if (this.dir === path.parse(this.dir).root) fail(400, 'choose a dedicated sub-hub storage directory');
    noSymlinks(this.dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    noSymlinks(this.dir);
    const marker = path.join(this.dir, MARKER);
    const entries = fs.readdirSync(this.dir);
    if (!entries.includes(MARKER)) {
      if (entries.length) fail(400, 'refusing unrelated non-empty sub-hub storage directory');
      writeSynced(marker, MARKER_TEXT);
      fsyncDir(this.dir);
    }
    regularFile(marker);
    if (fs.readFileSync(marker, 'utf8') !== MARKER_TEXT) fail(400, 'unrecognized sub-hub storage directory');
    for (const entry of fs.readdirSync(this.dir)) {
      if (![MARKER, 'state.json', '.writer.lock'].includes(entry) && !/^\.state-[0-9]+-[a-f0-9]{32}\.tmp$/.test(entry)) fail(400, 'refusing unrelated files in sub-hub storage');
      regularFile(path.join(this.dir, entry));
    }
    this.acquireLock();
    try {
      const filename = path.join(this.dir, 'state.json');
      this.state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { version: 1, nodes: {}, work: {}, activity: [] };
      if (!record(this.state) || this.state.version !== 1 || !record(this.state.nodes) || !record(this.state.work)) fail(500, 'invalid sub-hub state; refusing to overwrite it');
      // Version-one files written before settings/activity remain readable.
      // Defaults are persisted with the next ordinary state change.
      this.state.activity ??= [];
      if (!Array.isArray(this.state.activity)) fail(500, 'invalid stored sub-hub activity');
      this.state.activity = this.state.activity.slice(-ACTIVITY_LIMIT);
      for (const [id, node] of Object.entries(this.state.nodes)) {
        if (!record(node) || node.id !== id || typeof node.token !== 'string' || !Array.isArray(node.backups)) fail(500, 'invalid stored sub-hub node');
        node.mode ??= 'backup'; node.enabled ??= true; node.label ??= id;
        node.drive ??= { files: 0, bytes: 0, updatedAt: null };
        node.status ??= 'ready'; node.errors ??= []; node.online ??= node.seenAt !== null;
        try {
          settings({ mode: node.mode, enabled: node.enabled, label: node.label });
          driveSummary(node.drive);
          node.errors = runtimeErrors(node.errors, node.token);
          if (!['ready', 'degraded'].includes(node.status) || typeof node.online !== 'boolean') fail(400, 'invalid status');
        } catch { fail(500, 'invalid stored node settings or status'); }
      }
      for (const [id, work] of Object.entries(this.state.work)) {
        if (!record(work) || work.id !== id || !['queued', 'claimed', 'completed'].includes(work.status)) fail(500, 'invalid stored work item');
      }
      if (!fs.existsSync(filename)) this.persist(this.state);
    } catch (error) { this.close(); throw error; }
  }

  private acquireLock() {
    const filename = path.join(this.dir, '.writer.lock');
    if (fs.existsSync(filename)) {
      regularFile(filename);
      let lock: { pid?: number };
      try { lock = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return fail(409, 'invalid sub-hub writer lock; inspect it before removal'); }
      if (!Number.isSafeInteger(lock.pid) || (lock.pid ?? 0) <= 0) fail(409, 'invalid sub-hub writer lock');
      let alive = true;
      try { process.kill(lock.pid!, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) fail(409, 'sub-hub storage already has a writer');
      fs.unlinkSync(filename);
    }
    try { writeSynced(filename, JSON.stringify({ pid: process.pid, nonce: this.lockNonce }) + '\n'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'sub-hub storage already has a writer'); throw error; }
    fsyncDir(this.dir);
  }
  private open() { if (this.closed) fail(503, 'sub-hub store is closed'); }
  private persist(next: State) {
    this.open();
    noSymlinks(this.dir);
    const filename = path.join(this.dir, 'state.json');
    if (fs.existsSync(filename)) regularFile(filename);
    const temporary = path.join(this.dir, `.state-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
    try {
      writeSynced(temporary, JSON.stringify(next) + '\n');
      fs.renameSync(temporary, filename);
      this.state = next;
      fsyncDir(this.dir);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  private change<T>(fn: (next: State) => T): T {
    this.open();
    const next = copy(this.state);
    const result = fn(next);
    this.persist(next);
    return copy(result);
  }
  private event(next: State, event: Omit<SubhubActivity, 'id' | 'at'>) {
    next.activity.push({ id: `event-${crypto.randomUUID()}`, at: this.now(), ...event });
    if (next.activity.length > ACTIVITY_LIMIT) next.activity.splice(0, next.activity.length - ACTIVITY_LIMIT);
  }
  private healthy(node: StoredNode) { return node.seenAt !== null && this.now() - node.seenAt < NODE_STALE_MS && node.seenAt <= this.now(); }
  private sweep() {
    this.open();
    if (!Object.values(this.state.nodes).some(node => node.online && !this.healthy(node))) return;
    this.change(next => {
      for (const node of Object.values(next.nodes)) {
        if (!node.online || this.healthy(node)) continue;
        node.online = false;
        this.event(next, { space: node.space, nodeId: node.id, kind: 'node_offline', subject: node.id, text: 'Heartbeat expired; node is offline' });
      }
    });
  }
  private publicNode(node: StoredNode): PublicNode {
    const { token: _token, online: _online, ...value } = node;
    return copy({ ...value, healthy: this.healthy(node) });
  }
  private nodeIn(state: State, id: string, token: string) {
    const node = Object.hasOwn(state.nodes, id) ? state.nodes[id] : null;
    const supplied = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
    const expected = Buffer.from(node?.token ?? '');
    if (!node || !supplied.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return fail(401, 'invalid sub-hub token');
    return node;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const filename = path.join(this.dir, '.writer.lock');
    try {
      regularFile(filename);
      const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (lock.pid === process.pid && lock.nonce === this.lockNonce) { fs.unlinkSync(filename); fsyncDir(this.dir); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  register(input: RegisterInput, owner: string): { node: PublicNode; token: string } {
    this.open();
    const id = nodeId(input.id), space = spaceName(input.space), url = nodeUrl(input.url);
    actorName(owner); bytes(input.capacityBytes, 'capacityBytes', true);
    const requested = settings({ mode: input.mode, enabled: input.enabled, label: input.label });
    const existing = Object.hasOwn(this.state.nodes, id) ? this.state.nodes[id] : null;
    if (existing) {
      if (existing.owner !== owner || existing.space !== space) fail(409, 'node id belongs to another owner or space');
      if (existing.url !== url || existing.capacityBytes !== input.capacityBytes) fail(409, 'node registration conflicts with its saved configuration');
      return { node: this.publicNode(existing), token: existing.token };
    }
    const mode = requested.mode ?? 'backup';
    if (mode === 'drive' && !url) fail(400, 'Active drives need a parent-reachable advertised URL');
    const made: StoredNode = { id, space, owner, ...(url ? { url } : {}), capacityBytes: input.capacityBytes, freeBytes: 0, backups: [], createdAt: this.now(), seenAt: null, token: crypto.randomBytes(32).toString('base64url'), mode, enabled: requested.enabled ?? true, label: requested.label ?? id, drive: { files: 0, bytes: 0, updatedAt: null }, status: 'ready', errors: [], online: false };
    this.change(next => {
      next.nodes[id] = made;
      this.event(next, { space, nodeId: id, kind: 'node_registered', subject: id, text: `Registered ${mode} node`, actor: owner });
    });
    return { node: this.publicNode(made), token: made.token };
  }
  updateNode(id: string, space: string, changes: NodeSettings, actor: string): PublicNode {
    this.open(); nodeId(id); spaceName(space); actorName(actor);
    const selected = Object.hasOwn(this.state.nodes, id) ? this.state.nodes[id] : null;
    if (!selected || selected.space !== space) return fail(404, 'no such node in this space');
    const validated = settings(changes);
    if ((validated.mode ?? selected.mode) === 'drive' && !selected.url) fail(400, 'Active drives need a parent-reachable advertised URL');
    const changed = (Object.keys(validated) as (keyof NodeSettings)[]).filter(key => selected[key] !== validated[key]);
    if (!changed.length) return this.publicNode(selected);
    return this.change(next => {
      const node = next.nodes[id];
      Object.assign(node, validated);
      this.event(next, { space, nodeId: id, kind: 'node_settings', subject: id, text: `Settings changed: ${changed.join(', ')}`, actor });
      return this.publicNode(node);
    });
  }
  spaces(): string[] {
    this.open();
    return [...new Set([...Object.values(this.state.nodes).map(node => node.space), ...Object.values(this.state.work).map(work => work.space)])].sort();
  }
  activity(space?: string): SubhubActivity[] {
    if (space !== undefined) spaceName(space);
    this.sweep();
    return this.state.activity.filter(event => space === undefined || event.space === space).slice().reverse()
      .map(({ id, at, space, nodeId, kind, subject, text, actor }) => ({ id, at, space, nodeId, kind, subject, text, ...(actor ? { actor } : {}) }));
  }
  driveNode(id: string, space: string): PublicNode | null {
    nodeId(id); spaceName(space); this.sweep();
    const node = Object.hasOwn(this.state.nodes, id) ? this.state.nodes[id] : null;
    return node?.space === space && node.mode === 'drive' ? this.publicNode(node) : null;
  }
  authenticateNode(id: string, token: string): PublicNode | null {
    this.open();
    try { return this.publicNode(this.nodeIn(this.state, id, token)); }
    catch (error) { if (error instanceof SubhubError && error.status === 401) return null; throw error; }
  }
  /** Server-only: never include this value in HTTP node listings or routes. */
  nodeToken(id: string): string | null {
    this.open();
    return Object.hasOwn(this.state.nodes, id) ? this.state.nodes[id].token : null;
  }
  heartbeat(id: string, token: string, input: HeartbeatInput) {
    this.open();
    const node = this.nodeIn(this.state, id, token);
    bytes(input.freeBytes, 'freeBytes');
    if (input.freeBytes > node.capacityBytes || !Array.isArray(input.backups) || input.backups.length > 10_000) fail(400, 'invalid node capacity or backup list');
    const backups: Backup[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const backup of input.backups) {
      if (!record(backup)) fail(400, 'invalid backup');
      const project = projectName(node.space, backup.project);
      if (typeof backup.oid !== 'string' || !OID.test(backup.oid) || typeof backup.snapshot !== 'string' || !SNAPSHOT.test(backup.snapshot) || ['.', '..'].includes(backup.snapshot)) fail(400, 'invalid backup oid or snapshot');
      bytes(backup.bytes, 'backup bytes');
      const key = JSON.stringify([project, backup.oid, backup.snapshot]);
      if (seen.has(key)) fail(400, 'duplicate backup');
      seen.add(key); total += backup.bytes;
      if (!Number.isSafeInteger(total) || total > node.capacityBytes) fail(400, 'backups exceed registered node capacity');
      backups.push({ project, oid: backup.oid, snapshot: backup.snapshot, bytes: backup.bytes });
    }
    backups.sort((a, b) => a.project.localeCompare(b.project) || a.oid.localeCompare(b.oid) || a.snapshot.localeCompare(b.snapshot));
    if (input.status !== undefined && input.status !== 'ready' && input.status !== 'degraded') fail(400, 'status must be ready or degraded');
    const status = input.status ?? node.status;
    const errors = input.errors === undefined ? node.errors : runtimeErrors(input.errors, node.token);
    const drive = input.drive === undefined ? node.drive : driveSummary(input.drive);
    this.sweep();
    const serverTime = this.now();
    return this.change(next => {
      const current = this.nodeIn(next, id, token);
      if (!current.online) this.event(next, { space: current.space, nodeId: id, kind: current.seenAt === null ? 'node_online' : 'node_reconnected', subject: id, text: current.seenAt === null ? 'Node is online' : 'Node reconnected' });
      if (JSON.stringify(current.backups.slice().sort((a, b) => a.project.localeCompare(b.project) || a.oid.localeCompare(b.oid) || a.snapshot.localeCompare(b.snapshot))) !== JSON.stringify(backups)) {
        this.event(next, { space: current.space, nodeId: id, kind: 'backup_changed', subject: id, text: `Backup manifest changed: ${backups.length} replicas, ${total} bytes` });
      }
      if (JSON.stringify(current.drive) !== JSON.stringify(drive)) this.event(next, { space: current.space, nodeId: id, kind: 'drive_changed', subject: id, text: `Drive manifest changed: ${drive.files} files, ${drive.bytes} bytes` });
      if (current.status !== status || JSON.stringify(current.errors) !== JSON.stringify(errors)) this.event(next, { space: current.space, nodeId: id, kind: 'node_status', subject: id, text: `Runtime ${status}${errors.length ? ` (${errors.length} errors)` : ''}` });
      Object.assign(current, { freeBytes: input.freeBytes, backups, seenAt: serverTime, online: true, drive, status, errors });
      return { node: this.publicNode(current), serverTime };
    });
  }
  nodes(space: string): PublicNode[] {
    spaceName(space); this.sweep();
    return Object.values(this.state.nodes).filter(node => node.space === space).sort((a, b) => a.id.localeCompare(b.id)).map(node => this.publicNode(node));
  }
  enqueue(input: EnqueueInput, actor: string): WorkItem {
    this.open();
    const space = spaceName(input.space), project = projectName(space, input.project);
    actorName(actor);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000) fail(400, 'work needs a title (up to 200 characters) and text (up to 20,000)');
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) fail(400, 'invalid work idempotency key');
    const title = input.title.trim(), text = input.text.trim();
    const duplicate = Object.values(this.state.work).find(item => item.space === space && item.actor === actor && item.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      if (duplicate.project !== project || duplicate.title !== title || duplicate.text !== text) fail(409, 'idempotency key was already used for different work');
      return copy(duplicate);
    }
    const now = this.now();
    const item: WorkItem = { id: `work-${crypto.randomUUID()}`, space, project, title, text, actor, idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now, status: 'queued', assignedNode: null, assignedAt: null, receivedAt: null, worker: null, fence: 0, leaseUntil: null, result: null };
    return this.change(next => {
      next.work[item.id] = item;
      this.event(next, { space, nodeId: null, kind: 'work_enqueued', subject: project, text: `Queued ${item.id}`, actor });
      return item;
    });
  }
  work(id: string): WorkItem | null { this.open(); return Object.hasOwn(this.state.work, id) ? copy(this.state.work[id]) : null; }
  listWork(space: string): WorkItem[] {
    this.open(); spaceName(space);
    return copy(Object.values(this.state.work).filter(item => item.space === space).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
  }
  assignments(nodeId: string, token: string): WorkItem[] {
    this.open();
    const requester = this.nodeIn(this.state, nodeId, token);
    this.sweep();
    const next = copy(this.state);
    const reserved = new Map<string, number>();
    let changed = false;
    for (const item of Object.values(next.work).filter(work => work.status === 'queued' && work.space === requester.space).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      const needed = Buffer.byteLength(JSON.stringify(item)) + 512;
      const available = (node: StoredNode) => node.freeBytes - (reserved.get(node.id) ?? 0);
      const assigned = item.assignedNode ? next.nodes[item.assignedNode] : null;
      // A receipt means the bytes are already on disk and included in the
      // next free-space report. Do not reserve their size for delivery again.
      if (assigned && assigned.enabled && this.healthy(assigned) && (item.receivedAt !== null || available(assigned) >= needed)) {
        if (item.receivedAt === null) reserved.set(assigned.id, (reserved.get(assigned.id) ?? 0) + needed);
        continue;
      }
      const eligible = Object.values(next.nodes).filter(node => node.space === item.space && node.enabled && this.healthy(node) && available(node) >= needed)
        .sort((a, b) => available(b) - available(a) || a.id.localeCompare(b.id));
      const chosen = eligible[0]?.id ?? null;
      if (chosen) reserved.set(chosen, (reserved.get(chosen) ?? 0) + needed);
      if (item.assignedNode === chosen) continue;
      item.assignedNode = chosen; item.assignedAt = chosen ? this.now() : null; item.receivedAt = null; item.updatedAt = this.now(); changed = true;
      this.event(next, { space: item.space, nodeId: chosen, kind: 'work_assigned', subject: item.project, text: chosen ? `Assigned ${item.id}` : `${item.id} is waiting for an available node` });
    }
    if (changed) this.persist(next);
    return copy(Object.values(this.state.work).filter(item => item.status === 'queued' && item.assignedNode === nodeId));
  }
  receipt(nodeId: string, token: string, ids: string[]): WorkItem[] {
    this.nodeIn(this.state, nodeId, token);
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string')) fail(400, 'invalid work receipt list');
    return this.change(next => ids.map(id => {
      const item = Object.hasOwn(next.work, id) ? next.work[id] : null;
      if (!item || item.status !== 'queued' || item.assignedNode !== nodeId) return fail(409, 'work is no longer queued for this node');
      if (item.receivedAt === null) this.event(next, { space: item.space, nodeId, kind: 'work_received', subject: item.project, text: `Received ${item.id}` });
      item.receivedAt ??= this.now(); item.updatedAt = this.now(); return item;
    }));
  }
  claim(id: string, worker: string, leaseSeconds = 60): WorkItem {
    actorName(worker);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) fail(400, 'lease must be 1 to 300 seconds');
    return this.change(next => {
      const item = Object.hasOwn(next.work, id) ? next.work[id] : null;
      if (!item) return fail(404, 'no such work item');
      if (item.status === 'completed' || (item.status === 'claimed' && (item.leaseUntil ?? 0) > this.now())) fail(409, 'work is already claimed or completed');
      item.status = 'claimed'; item.worker = worker; item.fence++; item.leaseUntil = this.now() + leaseSeconds * 1000; item.updatedAt = this.now();
      this.event(next, { space: item.space, nodeId: item.assignedNode, kind: 'work_claimed', subject: item.project, text: `Claimed ${item.id} (fence ${item.fence})`, actor: worker });
      return item;
    });
  }
  private leased(next: State, id: string, worker: string, fence: number) {
    const item = Object.hasOwn(next.work, id) ? next.work[id] : null;
    if (!item) return fail(404, 'no such work item');
    if (item.status !== 'claimed' || item.worker !== worker || item.fence !== fence || (item.leaseUntil ?? 0) <= this.now()) fail(409, 'stale or expired work lease');
    return item;
  }
  complete(id: string, worker: string, fence: number, result: string): WorkItem {
    actorName(worker);
    if (typeof result !== 'string' || result.length > 64_000) fail(400, 'work result must be text up to 64,000 characters');
    return this.change(next => {
      const item = this.leased(next, id, worker, fence);
      item.status = 'completed'; item.result = result; item.leaseUntil = null; item.updatedAt = this.now();
      this.event(next, { space: item.space, nodeId: item.assignedNode, kind: 'work_completed', subject: item.project, text: `Completed ${item.id}`, actor: worker });
      return item;
    });
  }
  release(id: string, worker: string, fence: number): WorkItem {
    actorName(worker);
    return this.change(next => {
      const item = this.leased(next, id, worker, fence);
      this.event(next, { space: item.space, nodeId: item.assignedNode, kind: 'work_released', subject: item.project, text: `Released ${item.id} back to the queue`, actor: worker });
      item.status = 'queued'; item.worker = null; item.leaseUntil = null; item.assignedNode = null; item.assignedAt = null; item.receivedAt = null; item.updatedAt = this.now(); return item;
    });
  }
  route(project: string, oid: string): Route | null {
    this.sweep();
    const space = spaceName(project.split('/')[0]);
    projectName(space, project);
    if (!OID.test(oid)) fail(400, 'invalid route oid');
    const eligible = Object.values(this.state.nodes).filter(node => node.space === space && node.url && node.enabled && this.healthy(node))
      .sort((a, b) => b.freeBytes - a.freeBytes || a.id.localeCompare(b.id));
    for (const node of eligible) {
      const backup = node.backups.find(backup => backup.project === project && backup.oid === oid && backup.bytes <= node.capacityBytes);
      if (backup) return copy({ nodeId: node.id, url: node.url!, ...backup });
    }
    return null;
  }
}
