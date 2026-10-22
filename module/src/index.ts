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
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Sha1, objectHeader } from './sha1';

// Objects up to this size are stored inline; larger ones go to object_chunk.
const CHUNK_SIZE = 1024 * 1024;
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

const spacetimedb = schema({ user, space, gitRef, gitObject, objectChunk });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const ObjectIn = t.object('ObjectIn', {
  oid: t.string(),
  kind: t.string(),
  data: t.byteArray(),
});

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SPACE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OID = /^[0-9a-f]{40}$/;
const KINDS = new Set(['commit', 'tree', 'blob', 'tag']);
const ZERO_OID = '';

function objectKey(spaceId: bigint, oid: string) {
  return `${spaceId}:${oid}`;
}

function refKey(spaceId: bigint, name: string) {
  return `${spaceId}:${name}`;
}

function requireUser(ctx: Ctx) {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me) throw new SenderError('no username yet: run spacehub auth login --username <name>');
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

function readObject(ctx: Ctx, spaceId: bigint, oid: string): { kind: string; data: Uint8Array } | null {
  const row = ctx.db.gitObject.key.find(objectKey(spaceId, oid));
  if (!row) return null;
  if (row.chunks === 0) return { kind: row.kind, data: row.data };
  const data = new Uint8Array(Number(row.size));
  for (const chunk of ctx.db.objectChunk.bySpaceOid.filter([spaceId, oid])) {
    if (chunk.idx < row.chunks) data.set(chunk.data, chunk.idx * CHUNK_SIZE);
  }
  return { kind: row.kind, data };
}

// "parent <oid>" lines of a commit header, which ends at the first blank line.
function commitParents(data: Uint8Array): string[] {
  const parents: string[] = [];
  let i = 0;
  while (i < data.length && data[i] !== 0x0a) {
    let end = i;
    while (end < data.length && data[end] !== 0x0a) end++;
    if (end - i === 47 && String.fromCharCode(...data.subarray(i, i + 7)) === 'parent ') {
      parents.push(String.fromCharCode(...data.subarray(i + 7, end)));
    }
    i = end + 1;
  }
  return parents;
}

function isAncestor(ctx: Ctx, spaceId: bigint, ancestor: string, tip: string): boolean {
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    const obj = readObject(ctx, spaceId, oid);
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
    throw new SenderError('username must be 1-39 lowercase letters, digits or inner hyphens');
  }
  const existing = ctx.db.user.identity.find(ctx.sender);
  if (existing) throw new SenderError(`this identity is already registered as "${existing.username}"`);
  if (ctx.db.user.username.find(username)) throw new SenderError(`username "${username}" is taken`);
  ctx.db.user.insert({ identity: ctx.sender, username, createdAt: ctx.timestamp });
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
    ctx.db.space.insert({
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
  }
);

export const deleteSpace = spacetimedb.reducer({ space: t.string() }, (ctx, { space: fullName }) => {
  const sp = requireWritable(ctx, fullName);
  for (const ref of [...ctx.db.gitRef.spaceId.filter(sp.id)]) ctx.db.gitRef.id.delete(ref.id);
  for (const obj of [...ctx.db.gitObject.bySpacePos.filter(sp.id)]) ctx.db.gitObject.id.delete(obj.id);
  for (const chunk of [...ctx.db.objectChunk.bySpaceOid.filter(sp.id)]) ctx.db.objectChunk.id.delete(chunk.id);
  ctx.db.space.id.delete(sp.id);
});

// Change a space's description and/or default branch; omitted fields stay.
export const editSpace = spacetimedb.reducer(
  { space: t.string(), description: t.option(t.string()), defaultBranch: t.option(t.string()) },
  (ctx, { space: fullName, description, defaultBranch }) => {
    const sp = requireWritable(ctx, fullName);
    if (defaultBranch !== undefined && !validRefName(`refs/heads/${defaultBranch}`)) {
      throw new SenderError(`invalid branch name "${defaultBranch}"`);
    }
    ctx.db.space.id.update({
      ...sp,
      description: description === undefined ? sp.description : description.slice(0, 500),
      defaultBranch: defaultBranch ?? sp.defaultBranch,
    });
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
      if (current) ctx.db.gitRef.id.delete(current.id);
      ctx.db.space.id.update({ ...sp, pushedAt: ctx.timestamp });
      return;
    }
    if (!OID.test(newOid)) throw new SenderError(`invalid object id "${newOid}"`);
    const target = ctx.db.gitObject.key.find(objectKey(sp.id, newOid));
    if (!target) throw new SenderError(`object ${newOid} has not been uploaded`);
    const isBranch = name.startsWith('refs/heads/');
    if (isBranch && target.kind !== 'commit') throw new SenderError(`${name} must point at a commit`);
    if (current && !force) {
      if (!isBranch) throw new SenderError(`${name} already exists`);
      if (!isAncestor(ctx, sp.id, current.oid, newOid)) throw new SenderError(`non-fast-forward update of ${name}`);
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
  }
);
