// Reading git data back out of the tables; shared by the push rules and the
// web UI.
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from './index';

export type Db = ReducerCtx<InferSchema<typeof spacetimedb>>['db'];

// Objects up to this size are stored inline; larger ones go to object_chunk.
export const CHUNK_SIZE = 1024 * 1024;

export function objectKey(spaceId: bigint, oid: string) {
  return `${spaceId}:${oid}`;
}

export function refKey(spaceId: bigint, name: string) {
  return `${spaceId}:${name}`;
}

export function memberKey(spaceId: bigint, agent: string) {
  return `${spaceId}:${agent}`;
}

export function roleKey(space: string, member: string) {
  return `${space}:${member}`;
}

// Owners of a space: a personal space's builder, an org's owner rows,
// an agent's parent's owners. A space without a row yet (before
// migrateSpaces) is a builder's personal space.
export function ownsSpace(db: Db, space: string, actor: string | null, depth = 0): boolean {
  if (!actor) return false;
  const row = db.hubSpace.name.find(space);
  if (!row || row.kind === 'personal') return actor === space;
  if (row.kind === 'agent') return depth < 4 && ownsSpace(db, row.parent, actor, depth + 1);
  return db.spaceRole.key.find(roleKey(space, actor))?.role === 'owner';
}

// Owners and members: who pushes to every project of the space.
// An agent belongs to its own space too.
export function inSpace(db: Db, space: string, actor: string | null): boolean {
  if (!actor) return false;
  if (actor === space && db.hubSpace.name.find(space)?.kind === 'agent') return true;
  return ownsSpace(db, space, actor) || !!db.spaceRole.key.find(roleKey(space, actor));
}

// Clients repeat watchSpace about once a minute; a presence row this much
// older belongs to a connection that is gone.
export const PRESENCE_STALE_SECONDS = 180;

export function readObject(db: Db, spaceId: bigint, oid: string): { kind: string; data: Uint8Array } | null {
  const row = db.gitObject.key.find(objectKey(spaceId, oid));
  if (!row) return null;
  if (row.chunks === 0) return { kind: row.kind, data: row.data };
  const data = new Uint8Array(Number(row.size));
  for (const chunk of db.objectChunk.bySpaceOid.filter([spaceId, oid])) {
    if (chunk.idx < row.chunks) data.set(chunk.data, chunk.idx * CHUNK_SIZE);
  }
  return { kind: row.kind, data };
}

// "parent <oid>" lines of a commit header, which ends at the first blank line.
export function commitParents(data: Uint8Array): string[] {
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
