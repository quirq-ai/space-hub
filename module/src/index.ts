// spacehub: GitHub-shaped git hosting where the database is the server.
//
//   user        an owner: one SpacetimeDB identity claims one username
//   space       a repository, addressed as "owner/name"
//   git_ref     branch and tag pointers of a space (refs/heads/main -> oid)
//   git_object  content-addressed git objects of a space (commit/tree/blob/tag)
//   object_chunk  bodies of objects larger than one chunk, split in order
//
// Reducers are the only write path, so every push is checked here: the
// caller must own the space, every object must hash to its id, and a ref only
// moves if the caller saw its current value (compare-and-swap) and, unless
// forced, the move is a fast-forward.
import { schema, table, t, Router, SenderError, SyncResponse, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type { Timestamp } from 'spacetimedb';
import { Sha1, objectHeader } from './sha1';
import { CHUNK_SIZE, commitParents, objectKey, readObject, refKey } from './store';
import { renderUi } from './ui';

const MAX_OBJECT_SIZE = 100 * 1024 * 1024;
// Fetch windows are cut on `pos`, a running total of row weights per space.
const ROW_OVERHEAD = 64;

const user = table(
  { name: 'user', public: true },
  {
    identity: t.identity().primaryKey(),
    username: t.string().unique(),
    createdAt: t.timestamp(),
  }
);

const space = table(
  { name: 'space', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fullName: t.string().unique(),
    owner: t.string().index('btree'),
    ownerIdentity: t.identity(),
    name: t.string(),
    description: t.string(),
    defaultBranch: t.string(),
    objectCount: t.u64(),
    objectPos: t.u64(),
    createdAt: t.timestamp(),
    pushedAt: t.timestamp(),
  }
);

const gitRef = table(
  { name: 'git_ref', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    spaceId: t.u64().index('btree'),
    name: t.string(),
    oid: t.string(),
    updatedAt: t.timestamp(),
    updatedBy: t.identity(),
  }
);

const gitObject = table(
  {
    name: 'git_object',
    public: true,
    indexes: [{ accessor: 'bySpacePos', algorithm: 'btree', columns: ['spaceId', 'pos'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    spaceId: t.u64(),
    pos: t.u64(),
    oid: t.string(),
    kind: t.string(),
    size: t.u64(),
    chunks: t.u32(),
    data: t.byteArray(),
  }
);

const objectChunk = table(
  {
    name: 'object_chunk',
    public: true,
    indexes: [{ accessor: 'bySpaceOid', algorithm: 'btree', columns: ['spaceId', 'oid'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    spaceId: t.u64(),
    oid: t.string(),
    idx: t.u32(),
    data: t.byteArray(),
  }
);

// Where a space was imported from (GitHub) and how the last import went.
// Written by the web service on behalf of the space's owner.
const spaceImport = table(
  { name: 'space_import', public: true },
  {
    spaceId: t.u64().primaryKey(),
    source: t.string(),
    status: t.string(), // running | done | failed
    message: t.string(),
    startedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// The GitHub account that built a space's code (its builder). Set on
// GitHub imports, or by hand. Spaces without a row are credited to their
// import source's GitHub owner, else to the agent that owns them.
const spaceBuilder = table(
  { name: 'space_builder', public: true },
  {
    spaceId: t.u64().primaryKey(),
    handle: t.string().index('btree'), // GitHub login, lowercase
    name: t.string(), // display name ("Anthropic" for anthropics)
    url: t.string(), // https://github.com/<login>
  }
);

// The hub's activity feed: every change, oldest first. Pages sort by `at`.
const activity = table(
  { name: 'activity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp().index('btree'),
    spaceId: t.u64().index('btree'), // 0 for hub-wide events (an agent registering)
    space: t.string(), // agent/name at the time, kept after a delete
    agent: t.string(), // who did it
    kind: t.string(), // agent_registered, space_created, ref_updated, import_done, ...
    subject: t.string(), // ref name, GitHub source or builder login
    oid: t.string(), // commit or tag the event points at
    count: t.u32(), // new commits in a push, or refs in an import
    text: t.string(), // commit subject, import message, builder name, what changed
  }
);

// Flags for one-off jobs, e.g. rebuilding the activity feed's history.
const hubState = table({ name: 'hub_state' }, { key: t.string().primaryKey(), value: t.string() });

const spacetimedb = schema({ user, space, gitRef, gitObject, objectChunk, spaceImport, spaceBuilder, activity, hubState });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const ObjectIn = t.object('ObjectIn', {
  oid: t.string(),
  kind: t.string(),
  data: t.byteArray(),
});

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
// First path segments the web UI and the server's proxy already use.
const RESERVED_USERNAMES = new Set(['v1', 'healthz', 'api', 'static', 'assets', 'login', 'settings', 'builders']);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SPACE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OID = /^[0-9a-f]{40}$/;
const KINDS = new Set(['commit', 'tree', 'blob', 'tag']);
const ZERO_OID = '';

function requireUser(ctx: Ctx) {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me) throw new SenderError('no agent name yet: run spacehub auth login --agent <name>');
  return me;
}

function requireSpace(ctx: Ctx, fullName: string) {
  const row = ctx.db.space.fullName.find(fullName);
  if (!row) throw new SenderError(`space "${fullName}" not found`);
  return row;
}

function requireWritable(ctx: Ctx, fullName: string) {
  const row = requireSpace(ctx, fullName);
  if (!row.ownerIdentity.equals(ctx.sender)) {
    throw new SenderError(`permission denied: you do not own "${fullName}"`);
  }
  return row;
}

function validRefName(name: string) {
  if (!name.startsWith('refs/') || name.length > 255) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return !name.split('/').some(part => part === '' || part.startsWith('.'));
}

const textDecoder = new TextDecoder('utf-8');
const IMPORT_STALE_MICROS = 3_600_000_000n;

interface ActivityIn {
  kind: string;
  at?: Timestamp;
  spaceId?: bigint;
  space?: string;
  agent?: string;
  subject?: string;
  oid?: string;
  count?: number;
  text?: string;
}

function logActivity(ctx: Ctx, e: ActivityIn) {
  ctx.db.activity.insert({
    id: 0n,
    at: e.at ?? ctx.timestamp,
    spaceId: e.spaceId ?? 0n,
    space: e.space ?? '',
    agent: e.agent ?? ctx.db.user.identity.find(ctx.sender)?.username ?? '',
    kind: e.kind,
    subject: e.subject ?? '',
    oid: e.oid ?? '',
    count: e.count ?? 0,
    text: (e.text ?? '').slice(0, 300),
  });
}

// While a GitHub import runs its many ref updates are not logged one by
// one; the import's own events summarize them.
function importing(ctx: Ctx, spaceId: bigint) {
  const row = ctx.db.spaceImport.spaceId.find(spaceId);
  return !!row && row.status === 'running' && ctx.timestamp.microsSinceUnixEpoch - row.updatedAt.microsSinceUnixEpoch < IMPORT_STALE_MICROS;
}

// First line of a commit's (or annotated tag's) message.
function subjectOf(ctx: Ctx, spaceId: bigint, oid: string) {
  const obj = readObject(ctx.db, spaceId, oid);
  if (!obj) return '';
  const text = textDecoder.decode(obj.data.subarray(0, 64 * 1024));
  const split = text.indexOf('\n\n');
  return split >= 0 ? text.slice(split + 2).split('\n')[0].slice(0, 200) : '';
}

// Commits from `from` back to `to` along first parents (0 when unknown).
function firstParentDistance(ctx: Ctx, spaceId: bigint, from: string, to: string, cap = 1000) {
  let oid = from;
  for (let n = 0; n < cap; n++) {
    if (oid === to) return n;
    const obj = readObject(ctx.db, spaceId, oid);
    if (!obj || obj.kind !== 'commit') return 0;
    const parent = commitParents(obj.data)[0];
    if (!parent) return 0;
    oid = parent;
  }
  return 0;
}

function isAncestor(ctx: Ctx, spaceId: bigint, ancestor: string, tip: string): boolean {
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    const obj = readObject(ctx.db, spaceId, oid);
    if (!obj || obj.kind !== 'commit') continue;
    for (const parent of commitParents(obj.data)) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

function insertObject(ctx: Ctx, sp: { id: bigint; objectCount: bigint; objectPos: bigint }, oid: string, kind: string, size: number, chunks: number, data: Uint8Array) {
  sp.objectCount += 1n;
  sp.objectPos += BigInt(data.length + ROW_OVERHEAD);
  ctx.db.gitObject.insert({
    id: 0n,
    key: objectKey(sp.id, oid),
    spaceId: sp.id,
    pos: sp.objectPos,
    oid,
    kind,
    size: BigInt(size),
    chunks,
    data,
  });
}

export const registerUser = spacetimedb.reducer({ username: t.string() }, (ctx, { username }) => {
  if (!USERNAME.test(username)) {
    throw new SenderError('an agent name is 1-39 lowercase letters, digits or inner hyphens');
  }
  if (RESERVED_USERNAMES.has(username)) throw new SenderError(`agent name "${username}" is reserved`);
  const existing = ctx.db.user.identity.find(ctx.sender);
  if (existing) throw new SenderError(`this identity is already the agent "${existing.username}"`);
  if (ctx.db.user.username.find(username)) throw new SenderError(`agent name "${username}" is taken`);
  ctx.db.user.insert({ identity: ctx.sender, username, createdAt: ctx.timestamp });
  logActivity(ctx, { kind: 'agent_registered', agent: username });
});

export const createSpace = spacetimedb.reducer(
  { name: t.string(), description: t.string() },
  (ctx, { name, description }) => {
    const me = requireUser(ctx);
    if (!SPACE_NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
      throw new SenderError('space name may use letters, digits, ".", "_" and "-" and must not end in .git');
    }
    const fullName = `${me.username}/${name}`;
    if (ctx.db.space.fullName.find(fullName)) throw new SenderError(`space "${fullName}" already exists`);
    const created = ctx.db.space.insert({
      id: 0n,
      fullName,
      owner: me.username,
      ownerIdentity: ctx.sender,
      name,
      description: description.slice(0, 500),
      defaultBranch: 'main',
      objectCount: 0n,
      objectPos: 0n,
      createdAt: ctx.timestamp,
      pushedAt: ctx.timestamp,
    });
    logActivity(ctx, { kind: 'space_created', spaceId: created.id, space: fullName, agent: me.username });
  }
);

export const deleteSpace = spacetimedb.reducer({ space: t.string() }, (ctx, { space: fullName }) => {
  const sp = requireWritable(ctx, fullName);
  logActivity(ctx, { kind: 'space_deleted', spaceId: sp.id, space: sp.fullName });
  for (const ref of [...ctx.db.gitRef.spaceId.filter(sp.id)]) ctx.db.gitRef.id.delete(ref.id);
  for (const obj of [...ctx.db.gitObject.bySpacePos.filter(sp.id)]) ctx.db.gitObject.id.delete(obj.id);
  for (const chunk of [...ctx.db.objectChunk.bySpaceOid.filter(sp.id)]) ctx.db.objectChunk.id.delete(chunk.id);
  ctx.db.spaceImport.spaceId.delete(sp.id);
  ctx.db.spaceBuilder.spaceId.delete(sp.id);
  ctx.db.space.id.delete(sp.id);
});

// Credit the GitHub account (user or organization) that built the space's
// code. `handle` is its login; the profile link is derived from it (the
// `url` argument is ignored). An empty handle clears the credit, so the
// space falls back to its import source's owner, else its agent.
export const setBuilder = spacetimedb.reducer(
  { space: t.string(), handle: t.string(), name: t.string(), url: t.string() },
  (ctx, { space: fullName, handle, name }) => {
    const sp = requireWritable(ctx, fullName);
    const login = handle.trim();
    if (login === '') {
      if (ctx.db.spaceBuilder.spaceId.delete(sp.id)) logActivity(ctx, { kind: 'builder_cleared', spaceId: sp.id, space: sp.fullName });
      return;
    }
    if (!GITHUB_LOGIN.test(login)) throw new SenderError(`"${login}" is not a GitHub user or organization name`);
    const row = { spaceId: sp.id, handle: login.toLowerCase(), name: (name.trim() || login).slice(0, 100), url: `https://github.com/${login}` };
    if (ctx.db.spaceBuilder.spaceId.find(sp.id)) ctx.db.spaceBuilder.spaceId.update(row);
    else ctx.db.spaceBuilder.insert(row);
    logActivity(ctx, { kind: 'builder_set', spaceId: sp.id, space: sp.fullName, subject: row.handle, text: row.name });
  }
);

// Change a space's description and/or default branch; omitted fields stay.
export const editSpace = spacetimedb.reducer(
  { space: t.string(), description: t.option(t.string()), defaultBranch: t.option(t.string()) },
  (ctx, { space: fullName, description, defaultBranch }) => {
    const sp = requireWritable(ctx, fullName);
    if (defaultBranch !== undefined && !validRefName(`refs/heads/${defaultBranch}`)) {
      throw new SenderError(`invalid branch name "${defaultBranch}"`);
    }
    const next = {
      ...sp,
      description: description === undefined ? sp.description : description.slice(0, 500),
      defaultBranch: defaultBranch ?? sp.defaultBranch,
    };
    ctx.db.space.id.update(next);
    const changed: string[] = [];
    if (next.description !== sp.description) changed.push('changed the description');
    if (next.defaultBranch !== sp.defaultBranch) changed.push(`set the default branch to ${next.defaultBranch}`);
    if (changed.length > 0 && !importing(ctx, sp.id)) {
      logActivity(ctx, { kind: 'space_edited', spaceId: sp.id, space: sp.fullName, text: changed.join(' and ') });
    }
  }
);

// Upload a batch of whole objects. Objects the space already has are skipped,
// so retrying a failed push is safe.
export const putObjects = spacetimedb.reducer(
  { space: t.string(), objects: t.array(ObjectIn) },
  (ctx, { space: fullName, objects }) => {
    const sp = requireWritable(ctx, fullName);
    for (const { oid, kind, data } of objects) {
      if (!OID.test(oid)) throw new SenderError(`invalid object id "${oid}"`);
      if (!KINDS.has(kind)) throw new SenderError(`invalid object kind "${kind}"`);
      if (data.length > CHUNK_SIZE) throw new SenderError(`object ${oid} is larger than one chunk; upload it with putChunk`);
      if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) continue;
      const actual = new Sha1().update(objectHeader(kind, data.length)).update(data).hex();
      if (actual !== oid) throw new SenderError(`object ${oid} hashes to ${actual}`);
      insertObject(ctx, sp, oid, kind, data.length, 0, data);
    }
    ctx.db.space.id.update(sp);
  }
);

// Stage one chunk of a large object. Re-uploading a chunk replaces it.
export const putChunk = spacetimedb.reducer(
  { space: t.string(), oid: t.string(), idx: t.u32(), data: t.byteArray() },
  (ctx, { space: fullName, oid, idx, data }) => {
    const sp = requireWritable(ctx, fullName);
    if (!OID.test(oid)) throw new SenderError(`invalid object id "${oid}"`);
    if (data.length > CHUNK_SIZE) throw new SenderError('chunk too large');
    if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) return;
    const key = `${sp.id}:${oid}:${idx}`;
    const existing = ctx.db.objectChunk.key.find(key);
    if (existing) ctx.db.objectChunk.id.delete(existing.id);
    ctx.db.objectChunk.insert({ id: 0n, key, spaceId: sp.id, oid, idx, data });
  }
);

// Seal a large object once all its chunks are staged: check the hash over
// the chunks in order, then record the object.
export const finishObject = spacetimedb.reducer(
  { space: t.string(), oid: t.string(), kind: t.string(), size: t.u64(), chunks: t.u32() },
  (ctx, { space: fullName, oid, kind, size, chunks }) => {
    const sp = requireWritable(ctx, fullName);
    if (!KINDS.has(kind)) throw new SenderError(`invalid object kind "${kind}"`);
    if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) return;
    const total = Number(size);
    if (total > MAX_OBJECT_SIZE) throw new SenderError(`object ${oid} exceeds ${MAX_OBJECT_SIZE} bytes`);
    if (chunks !== Math.ceil(total / CHUNK_SIZE)) throw new SenderError('chunk count does not match size');
    const hash = new Sha1().update(objectHeader(kind, total));
    let seen = 0;
    for (let idx = 0; idx < chunks; idx++) {
      const chunk = ctx.db.objectChunk.key.find(`${sp.id}:${oid}:${idx}`);
      if (!chunk) throw new SenderError(`object ${oid} is missing chunk ${idx}`);
      hash.update(chunk.data);
      seen += chunk.data.length;
    }
    if (seen !== total) throw new SenderError(`object ${oid} chunks hold ${seen} bytes, expected ${total}`);
    const actual = hash.hex();
    if (actual !== oid) throw new SenderError(`object ${oid} hashes to ${actual}`);
    insertObject(ctx, sp, oid, kind, total, chunks, new Uint8Array(0));
    ctx.db.space.id.update(sp);
  }
);

// Move, create or delete one ref. `oldOid` is what the pusher believes the
// ref holds now ("" for absent, "*" for a plain force push that overwrites
// anything); a mismatch means someone pushed in between.
export const updateRef = spacetimedb.reducer(
  { space: t.string(), name: t.string(), oldOid: t.string(), newOid: t.string(), force: t.bool() },
  (ctx, { space: fullName, name, oldOid, newOid, force }) => {
    const sp = requireWritable(ctx, fullName);
    if (!validRefName(name)) throw new SenderError(`invalid ref name "${name}"`);
    const current = ctx.db.gitRef.key.find(refKey(sp.id, name));
    const currentOid = current?.oid ?? ZERO_OID;
    if (oldOid !== '*' && currentOid !== oldOid) {
      throw new SenderError(`stale info: ${name} is at ${currentOid || 'nothing'}, fetch first`);
    }
    if (newOid === ZERO_OID) {
      if (current) {
        ctx.db.gitRef.id.delete(current.id);
        if (!importing(ctx, sp.id)) logActivity(ctx, { kind: 'ref_deleted', spaceId: sp.id, space: sp.fullName, subject: name, oid: current.oid });
      }
      ctx.db.space.id.update({ ...sp, pushedAt: ctx.timestamp });
      return;
    }
    if (!OID.test(newOid)) throw new SenderError(`invalid object id "${newOid}"`);
    const target = ctx.db.gitObject.key.find(objectKey(sp.id, newOid));
    if (!target) throw new SenderError(`object ${newOid} has not been uploaded`);
    const isBranch = name.startsWith('refs/heads/');
    if (isBranch && target.kind !== 'commit') throw new SenderError(`${name} must point at a commit`);
    let fastForward = true;
    if (current && !force) {
      if (!isBranch) throw new SenderError(`${name} already exists`);
      if (!isAncestor(ctx, sp.id, current.oid, newOid)) throw new SenderError(`non-fast-forward update of ${name}`);
    } else if (current && current.oid !== newOid) {
      fastForward = isBranch && isAncestor(ctx, sp.id, current.oid, newOid);
    }
    if (current) {
      ctx.db.gitRef.id.update({ ...current, oid: newOid, updatedAt: ctx.timestamp, updatedBy: ctx.sender });
    } else {
      ctx.db.gitRef.insert({
        id: 0n,
        key: refKey(sp.id, name),
        spaceId: sp.id,
        name,
        oid: newOid,
        updatedAt: ctx.timestamp,
        updatedBy: ctx.sender,
      });
    }
    // The first branch pushed to an empty space becomes its default branch.
    let defaultBranch = sp.defaultBranch;
    if (isBranch && !ctx.db.gitRef.key.find(refKey(sp.id, `refs/heads/${defaultBranch}`))) {
      defaultBranch = name.slice('refs/heads/'.length);
    }
    ctx.db.space.id.update({ ...sp, defaultBranch, pushedAt: ctx.timestamp });
    if (!importing(ctx, sp.id) && current?.oid !== newOid) {
      const base = { spaceId: sp.id, space: sp.fullName, subject: name, oid: newOid, text: subjectOf(ctx, sp.id, newOid) };
      if (!current) logActivity(ctx, { ...base, kind: 'ref_created' });
      else if (!fastForward) logActivity(ctx, { ...base, kind: 'ref_forced' });
      else logActivity(ctx, { ...base, kind: 'ref_updated', count: firstParentDistance(ctx, sp.id, newOid, current.oid) });
    }
  }
);

const GITHUB_SOURCE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Record that an import into the space has started.
export const startImport = spacetimedb.reducer(
  { space: t.string(), source: t.string() },
  (ctx, { space: fullName, source }) => {
    const sp = requireWritable(ctx, fullName);
    if (!GITHUB_SOURCE.test(source)) throw new SenderError('only https://github.com/<owner>/<repo> can be imported');
    const row = ctx.db.spaceImport.spaceId.find(sp.id);
    if (row && row.status === 'running' && ctx.timestamp.microsSinceUnixEpoch - row.updatedAt.microsSinceUnixEpoch < IMPORT_STALE_MICROS) {
      throw new SenderError('an import into this space is already running');
    }
    const next = { spaceId: sp.id, source, status: 'running', message: 'starting', startedAt: ctx.timestamp, updatedAt: ctx.timestamp };
    if (row) ctx.db.spaceImport.spaceId.update(next);
    else ctx.db.spaceImport.insert(next);
    const syncing = ctx.db.gitRef.spaceId.filter(sp.id).next().done === false;
    logActivity(ctx, { kind: syncing ? 'sync_started' : 'import_started', spaceId: sp.id, space: sp.fullName, subject: source });
  }
);

// Report progress or the outcome of an import.
export const updateImport = spacetimedb.reducer(
  { space: t.string(), status: t.string(), message: t.string() },
  (ctx, { space: fullName, status, message }) => {
    const sp = requireWritable(ctx, fullName);
    if (!['running', 'done', 'failed'].includes(status)) throw new SenderError(`invalid import status "${status}"`);
    const row = ctx.db.spaceImport.spaceId.find(sp.id);
    if (!row) throw new SenderError(`no import recorded for "${fullName}"`);
    ctx.db.spaceImport.spaceId.update({ ...row, status, message: message.slice(0, 2000), updatedAt: ctx.timestamp });
    const base = { spaceId: sp.id, space: sp.fullName, subject: row.source, text: message };
    if (status === 'done') logActivity(ctx, { ...base, kind: 'import_done', count: [...ctx.db.gitRef.spaceId.filter(sp.id)].length });
    if (status === 'failed') logActivity(ctx, { ...base, kind: 'import_failed' });
  }
);

// Rebuild the activity feed for what happened before it existed: agents,
// spaces, builder credits, imports, and each ref's latest push. Runs once;
// the server image calls it after every publish, and later calls do nothing.
export const backfillActivity = spacetimedb.reducer(ctx => {
  if (ctx.db.hubState.key.find('activity_backfilled')) return;
  ctx.db.hubState.insert({ key: 'activity_backfilled', value: String(ctx.timestamp.microsSinceUnixEpoch) });
  const registered = new Set([...ctx.db.activity.spaceId.filter(0n)].filter(e => e.kind === 'agent_registered').map(e => e.agent));
  for (const u of ctx.db.user.iter()) {
    if (!registered.has(u.username)) logActivity(ctx, { kind: 'agent_registered', at: u.createdAt, agent: u.username });
  }
  for (const sp of [...ctx.db.space.iter()]) {
    const logged = [...ctx.db.activity.spaceId.filter(sp.id)];
    const seen = (kind: string, subject = '') => logged.some(e => e.kind === kind && e.subject === subject);
    const base = { spaceId: sp.id, space: sp.fullName, agent: sp.owner };
    if (!seen('space_created')) logActivity(ctx, { ...base, kind: 'space_created', at: sp.createdAt });
    const builder = ctx.db.spaceBuilder.spaceId.find(sp.id);
    if (builder && !seen('builder_set', builder.handle)) {
      logActivity(ctx, { ...base, kind: 'builder_set', at: sp.createdAt, subject: builder.handle, text: builder.name });
    }
    const refs = [...ctx.db.gitRef.spaceId.filter(sp.id)];
    const imp = ctx.db.spaceImport.spaceId.find(sp.id);
    if (imp) {
      if (!seen('import_started', imp.source)) logActivity(ctx, { ...base, kind: 'import_started', at: imp.startedAt, subject: imp.source });
      if (imp.status === 'done' && !seen('import_done', imp.source)) {
        logActivity(ctx, { ...base, kind: 'import_done', at: imp.updatedAt, subject: imp.source, text: imp.message, count: refs.length });
      }
      if (imp.status === 'failed' && !seen('import_failed', imp.source)) {
        logActivity(ctx, { ...base, kind: 'import_failed', at: imp.updatedAt, subject: imp.source, text: imp.message });
      }
      continue;
    }
    for (const r of refs) {
      if (logged.some(e => e.subject === r.name)) continue;
      logActivity(ctx, {
        ...base,
        kind: 'ref_pushed',
        at: r.updatedAt,
        agent: ctx.db.user.identity.find(r.updatedBy)?.username ?? sp.owner,
        subject: r.name,
        oid: r.oid,
        text: subjectOf(ctx, sp.id, r.oid),
      });
    }
  }
});

// The web UI. Behind the server image's proxy every page lands here with
// the original request URI in X-Spacehub-Uri; see ui.ts for the pages.
export const ui = spacetimedb.httpHandler((ctx, req) => {
  const res = ctx.withTx(tx =>
    renderUi(tx.db, {
      uri: req.uri,
      forwardedUri: req.headers.get('x-spacehub-uri'),
      cookie: req.headers.get('cookie'),
      proto: req.headers.get('x-forwarded-proto'),
      now: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n),
    })
  );
  return new SyncResponse(res.body, { status: res.status, headers: res.headers });
});

export const routes = spacetimedb.httpRouter(new Router().get('/ui', ui));
