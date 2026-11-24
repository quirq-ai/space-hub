// Reading git data back out of the tables; shared by the push rules and the
// web UI.
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';
import type spacetimedb from './index';

export type Db = ReducerCtx<InferSchema<typeof spacetimedb>>['db'];

// Objects up to this size are stored inline; larger ones go to object_chunk.
export const CHUNK_SIZE = 1024 * 1024;

export function objectKey(projectId: bigint, oid: string) {
  return `${projectId}:${oid}`;
}

export function refKey(projectId: bigint, name: string) {
  return `${projectId}:${name}`;
}

export function memberKey(projectId: bigint, agent: string) {
  return `${projectId}:${agent}`;
}

export function roleKey(space: string, member: string) {
  return `${space}:${member}`;
}

// The space a name stands for: a second name of a builder (space_alias)
// stands for the builder's personal space, any other name for itself. Pages,
// the API and reducers all take either.
export function spaceFor(db: Db, name: string): string {
  if (db.space.name.find(name)) return name;
  return (db.spaceAlias.name.find(name) ?? db.spaceAlias.name.find(name.toLowerCase()))?.space ?? name;
}

// "space/project", with a second name of the space replaced by the space.
export function projectFor(db: Db, fullName: string): string {
  const at = fullName.indexOf('/');
  return at < 0 ? fullName : spaceFor(db, fullName.slice(0, at)) + fullName.slice(at);
}

// Owners of a space: a personal space's builder, an org's owner rows,
// an agent's parent's owners. A name without a space row owns itself.
export function ownsSpace(db: Db, space: string, actor: string | null, depth = 0): boolean {
  if (!actor) return false;
  const row = db.space.name.find(space);
  if (!row || row.kind === 'personal') return actor === space;
  if (row.kind === 'agent') return depth < 4 && ownsSpace(db, row.parent, actor, depth + 1);
  return db.spaceRole.key.find(roleKey(space, actor))?.role === 'owner';
}

// Owners and members: who pushes to every project of the space.
// An agent belongs to its own space too.
export function inSpace(db: Db, space: string, actor: string | null): boolean {
  if (!actor) return false;
  if (actor === space && db.space.name.find(space)?.kind === 'agent') return true;
  return ownsSpace(db, space, actor) || !!db.spaceRole.key.find(roleKey(space, actor));
}

// ---------------------------------------------------------------- who belongs to the hub
//
// The one rule for "is this identity one of the hub's own" (members-only
// hubs, suspended builders). Reducers and the views below both ask it, so it
// lives here and nowhere else.

// A builder the hub's owner has not suspended (builder_suspension).
export function activeBuilder(db: Db, identity: Identity): boolean {
  return !!db.user.identity.find(identity) && !db.builderSuspension.identity.find(identity.toHexString());
}

// Whether an owner name (a builder, or an agent owning through an org role)
// belongs to the hub.
function activeName(db: Db, name: string, depth: number): boolean {
  const user = db.user.username.find(name);
  if (user) return !db.builderSuspension.identity.find(user.identity.toHexString());
  return db.space.name.find(name)?.kind === 'agent' && agentHasMember(db, name, depth + 1);
}

// Whether an agent's owners (ownsSpace: its parent's owners, up the chain)
// include a member. An agent of a suspended builder does not.
function agentHasMember(db: Db, agent: string, depth = 0): boolean {
  if (depth > 4) return false;
  const row = db.space.name.find(agent);
  if (row?.kind !== 'agent') return false;
  const parent = db.space.name.find(row.parent);
  if (!parent || parent.kind === 'personal') return activeName(db, row.parent, depth);
  if (parent.kind === 'agent') return agentHasMember(db, parent.name, depth + 1);
  return [...db.spaceRole.space.filter(parent.name)].some(r => r.role === 'owner' && activeName(db, r.member, depth));
}

// A member of the hub: a builder who is not suspended, or an agent whose
// owners include one.
export function isMember(db: Db, identity: Identity): boolean {
  if (db.user.identity.find(identity)) return activeBuilder(db, identity);
  const agent = db.agent.identity.find(identity);
  return !!agent && agentHasMember(db, agent.name);
}

// hub_state "membersOnly": "true" keeps everything from whoever is not a
// member. No row (the default) is a hub anyone may read, as before.
export function membersOnly(db: Db): boolean {
  return db.hubState.key.find('membersOnly')?.value === 'true';
}

// hub_state "defaultVisibility": what a new project starts as when whoever
// creates it does not choose. No row (the default) is public, as before.
export type Visibility = 'public' | 'private';
export function defaultVisibility(db: Db): Visibility {
  return db.hubState.key.find('defaultVisibility')?.value === 'private' ? 'private' : 'public';
}

// Whether `identity` may read the hub's spaces and projects (the views in
// index.ts). The admin (the server's own web service) always may.
export function mayReadHub(db: Db, identity: Identity): boolean {
  if (!membersOnly(db)) return true;
  return isMember(db, identity) || db.hubState.key.find('admin')?.value === identity.toHexString();
}

// ---------------------------------------------------------------- who may read a project
//
// The one rule for "may this identity read this project" (spec section 3).
// Reducers keep the project_access table equal to it (refreshAccess and
// friends below), and the per-project views read that table, so the rule
// itself lives here and nowhere else.

// A project is private when project_visibility says so; no row is public, as
// every project was before visibility existed.
export function isPrivate(db: Db, projectId: bigint): boolean {
  return db.projectVisibility.projectId.find(projectId)?.visibility === 'private';
}

export function isAdminIdentity(db: Db, identity: Identity): boolean {
  return db.hubState.key.find('admin')?.value === identity.toHexString();
}

// The name an identity reads as: a builder's login or an agent's name. A
// builder's name even when suspended; activeName decides whether it counts.
function readerName(db: Db, identity: Identity): string | null {
  return db.user.identity.find(identity)?.username ?? db.agent.identity.find(identity)?.name ?? null;
}

// Who owns a space by name (ownsSpace's rows, listed): a personal space's
// builder, an org's owner rows, an agent's parent's owners.
function ownersOf(db: Db, space: string, depth = 0): string[] {
  const row = db.space.name.find(space);
  if (!row || row.kind === 'personal') return [space];
  if (row.kind === 'agent') return depth < 4 ? ownersOf(db, row.parent, depth + 1) : [];
  return [...db.spaceRole.space.filter(space)].filter(r => r.role === 'owner').map(r => r.member);
}

// The nearest space above an agent that is not an agent: a builder's personal
// space or an org (null when the chain is broken or too long).
function agentHome(db: Db, agent: string) {
  let row = db.space.name.find(agent);
  for (let depth = 0; row?.kind === 'agent' && depth < 5; depth++) row = db.space.name.find(row.parent);
  return row && row.kind !== 'agent' ? row : null;
}

// Whether the name `name` (a member of the hub) may read private project `p`:
// it owns or is in the project's space, or collaborates on the project. An
// agent also reads through where it belongs:
//   - an agent of a builder (personal space) reads what that builder reads;
//   - an agent of an org reads that org's projects only. It never inherits an
//     owner's own access: every owner of the org can launch it, so through it
//     one owner would reach another owner's private work.
function readsPrivate(db: Db, p: { id: bigint; owner: string }, name: string): boolean {
  if (!activeName(db, name, 0)) return false;
  if (inSpace(db, p.owner, name)) return true;
  if (db.projectMember.key.find(memberKey(p.id, name))) return true;
  if (db.space.name.find(name)?.kind !== 'agent') return false;
  const home = agentHome(db, name);
  if (!home) return false;
  if (home.kind === 'org') return p.owner === home.name;
  return !!db.user.username.find(home.name) && readsPrivate(db, p, home.name);
}

// May `identity` read project `projectId`?
//   members-only hub and not a member (nor the admin)  -> no
//   the admin (the server's own web service)           -> yes; it filters per person itself
//   public project                                     -> yes
//   owner or member of its space, collaborator on it,
//   an agent of a builder who may, or an agent of the
//   org the project is in                              -> yes
//   anyone else                                        -> no
// A suspended builder is nobody: it reads what someone signed out reads
// (public projects, and only on a hub that is not members-only), never a
// private project, and neither do agents whose owners are all suspended.
export function canRead(db: Db, identity: Identity, projectId: bigint): boolean {
  const p = db.project.id.find(projectId);
  if (!p || !mayReadHub(db, identity)) return false;
  if (isAdminIdentity(db, identity)) return true;
  if (!isPrivate(db, projectId)) return true;
  const name = readerName(db, identity);
  return !!name && readsPrivate(db, p, name);
}

// canRead for a person the web service vouches for (reader.ts): a builder by
// name, or null for someone signed out. Someone signed out reads what a fresh
// identity would: public projects, on a hub that is not members-only.
export function canReadAs(db: Db, name: string | null, projectId: bigint): boolean {
  const user = name ? db.user.username.find(name) : null;
  if (user) return canRead(db, user.identity, projectId);
  return !!db.project.id.find(projectId) && !membersOnly(db) && !isPrivate(db, projectId);
}

// ---------------------------------------------------------------- project_access, kept equal to canRead
//
// project_access holds one row per (identity, project) that canRead allows,
// for the views to filter by ctx.sender and semijoin to the content tables
// (a semijoin compares indexed columns only, so the rule has to be a table).
// What the rows are, chosen so the views stay one query and the table small:
//
//   - a public project has exactly one row, for PUBLIC_READER (the zero
//     identity, which no client ever has). "Everyone" cannot be listed as
//     rows (anyone with a fresh identity may read a public project), so the
//     views ask for `identity = sender OR identity = PUBLIC_READER`;
//   - a private project has one row per builder or agent that canRead allows:
//     its space's owners and members, its collaborators, and their agents;
//   - the admin has no rows (the views give it every row, as mayReadHub does),
//     and members-only is not in the table at all: the views check mayReadHub
//     first, so switching it changes no row.
//
//   - one more row, the hub row (PUBLIC_READER, HUB_ROW = project id 0, which
//     no project has): rows about no project (activity of a space, presence
//     following a whole space) carry projectId 0, and a view is one query
//     (no union), so this row is how they pass the same semijoin. Space
//     names are not secret, so everyone who may read the hub reads them.
//
// So the table holds (projects + readers of private projects + 1) rows, not
// builders x projects, and nothing on an existing hub but one row a project.
// The kinds never overlap, so a semijoin never sees a project twice.
export const PUBLIC_READER = Identity.zero();
export const HUB_ROW = 0n;

// PUBLIC_READER for a view's query. The query builder writes an identity
// literal only when it is the server runtime's own Identity class, which the
// one this module imports from 'spacetimedb' is not: `r.identity.eq(
// PUBLIC_READER)` would silently match nothing (checked on a real server,
// 2.12). Build it from the caller's identity's class instead:
//   ctx.from.projectAccess
//     .where(r => r.identity.eq(ctx.sender).or(r.identity.eq(publicReaderFor(ctx.sender))))
//     .rightSemijoin(ctx.from.gitObject, (a, o) => a.projectId.eq(o.projectId))
export function publicReaderFor(sender: Identity): Identity {
  const RuntimeIdentity = sender.constructor as new (data: bigint) => Identity;
  return new RuntimeIdentity(0n);
}

// Who should have a row for project `projectId`, by identity hex.
function wantedReaders(db: Db, projectId: bigint): Map<string, Identity> {
  const want = new Map<string, Identity>();
  if (projectId === HUB_ROW) return want.set(PUBLIC_READER.toHexString(), PUBLIC_READER);
  const p = db.project.id.find(projectId);
  if (!p) return want;
  if (!isPrivate(db, projectId)) {
    want.set(PUBLIC_READER.toHexString(), PUBLIC_READER);
    return want;
  }
  // Everyone who could pass readsPrivate: names in or owning the space, its
  // collaborators, and every agent (an agent reads through its owners). canRead
  // decides; this only keeps from asking about every builder of the hub.
  const names = new Set<string>([p.owner, ...ownersOf(db, p.owner)]);
  for (const r of db.spaceRole.space.filter(p.owner)) names.add(r.member);
  for (const m of db.projectMember.projectId.filter(projectId)) names.add(m.agent);
  for (const a of db.agent.iter()) names.add(a.name);
  for (const name of names) {
    const identity = db.user.username.find(name)?.identity ?? db.agent.name.find(name)?.identity;
    if (identity && canRead(db, identity, projectId)) want.set(identity.toHexString(), identity);
  }
  return want;
}

export interface AccessChange {
  added: number;
  removed: number;
}

// Make project `projectId`'s rows match the rule: rows that should go go,
// missing ones are added, the rest are left alone (so a subscriber sees no
// churn). A project that no longer exists loses all its rows.
export function refreshAccess(db: Db, projectId: bigint): AccessChange {
  if (projectId !== HUB_ROW) ensureHubRow(db);
  const want = wantedReaders(db, projectId);
  const change = { added: 0, removed: 0 };
  for (const row of [...db.projectAccess.projectId.filter(projectId)]) {
    const hex = row.identity.toHexString();
    if (want.has(hex)) want.delete(hex);
    else {
      db.projectAccess.id.delete(row.id);
      change.removed++;
    }
  }
  for (const identity of want.values()) {
    db.projectAccess.insert({ id: 0n, identity, projectId });
    change.added++;
  }
  return change;
}

// The hub row, if it is missing (a new hub, or one from before it): cheap
// enough (one index lookup) to ask whenever who may read changes.
export function ensureHubRow(db: Db) {
  for (const _ of db.projectAccess.projectId.filter(HUB_ROW)) return;
  db.projectAccess.insert({ id: 0n, identity: PUBLIC_READER, projectId: HUB_ROW });
}

// Every project of a space, and of the agents it owns (whose owners are its
// owners): after a change of who is in the space.
export function refreshSpaceAccess(db: Db, space: string) {
  const spaces = [space, ...[...db.space.kind.filter('agent')].filter(a => a.parent === space).map(a => a.name)];
  for (const s of spaces) for (const p of [...db.project.owner.filter(s)]) refreshAccess(db, p.id);
}

// One identity's rows: after it was made, deleted, or its agents' owners
// changed. Only private projects can hold its rows.
export function refreshIdentityAccess(db: Db, identity: Identity) {
  ensureHubRow(db);
  if (identity.isEqual(PUBLIC_READER)) return;
  const have = new Set<bigint>();
  for (const row of [...db.projectAccess.identity.filter(identity)]) {
    if (isPrivate(db, row.projectId) && canRead(db, identity, row.projectId)) have.add(row.projectId);
    else db.projectAccess.id.delete(row.id);
  }
  if (identity.isEqual(PUBLIC_READER) || isAdminIdentity(db, identity)) return;
  for (const v of [...db.projectVisibility.iter()]) {
    if (v.visibility === 'private' && !have.has(v.projectId) && canRead(db, identity, v.projectId)) {
      db.projectAccess.insert({ id: 0n, identity, projectId: v.projectId });
    }
  }
}

// What the whole table should be, against what it is (the access check), and
// optionally make it so. Rows of projects that are gone count as extra.
export interface AccessReport {
  projects: number;
  rows: number;
  missing: string[]; // "<projectId> <identity hex>"
  extra: string[];
}

export function checkAccessTable(db: Db, repair: boolean): AccessReport {
  const report: AccessReport = { projects: 0, rows: 0, missing: [], extra: [] };
  const seen = new Set<bigint>([HUB_ROW]);
  const compare = (projectId: bigint) => {
    const want = wantedReaders(db, projectId);
    for (const row of db.projectAccess.projectId.filter(projectId)) {
      const hex = row.identity.toHexString();
      if (want.has(hex)) want.delete(hex);
      else report.extra.push(`${projectId} ${hex}`);
    }
    for (const hex of want.keys()) report.missing.push(`${projectId} ${hex}`);
  };
  compare(HUB_ROW);
  for (const p of [...db.project.iter()]) {
    report.projects++;
    seen.add(p.id);
    compare(p.id);
  }
  for (const row of db.projectAccess.iter()) {
    if (!seen.has(row.projectId)) report.extra.push(`${row.projectId} ${row.identity.toHexString()}`);
  }
  if (repair && (report.missing.length || report.extra.length)) refreshAllAccess(db);
  report.rows = Number(db.projectAccess.count());
  return report;
}

// Every project's rows, and rows of projects that are gone: after a change
// that can reach anywhere (a builder renamed, merged, deleted or suspended; an
// org's owners changed, which changes who owns its agents).
export function refreshAllAccess(db: Db) {
  refreshAccess(db, HUB_ROW);
  const seen = new Set<bigint>([HUB_ROW]);
  for (const p of [...db.project.iter()]) {
    seen.add(p.id);
    refreshAccess(db, p.id);
  }
  for (const row of [...db.projectAccess.iter()]) if (!seen.has(row.projectId)) db.projectAccess.id.delete(row.id);
}

// Clients repeat watchProject and watchSpace about once a minute; a presence
// row this much older belongs to a connection that is gone.
export const PRESENCE_STALE_SECONDS = 180;

export function readObject(db: Db, projectId: bigint, oid: string): { kind: string; data: Uint8Array } | null {
  const row = db.gitObject.key.find(objectKey(projectId, oid));
  if (!row) return null;
  if (row.chunks === 0) return { kind: row.kind, data: row.data };
  const data = new Uint8Array(Number(row.size));
  for (const chunk of db.objectChunk.byProjectOid.filter([projectId, oid])) {
    if (chunk.idx < row.chunks) data.set(chunk.data, chunk.idx * CHUNK_SIZE);
  }
  return { kind: row.kind, data };
}

export function objectSize(db: Db, projectId: bigint, oid: string): number | null {
  const row = db.gitObject.key.find(objectKey(projectId, oid));
  return row ? Number(row.size) : null;
}

/** Bytes start to end (exclusive) of an object, reading only the chunks they fall in. */
export function readObjectRange(db: Db, projectId: bigint, oid: string, start: number, end: number): Uint8Array | null {
  const row = db.gitObject.key.find(objectKey(projectId, oid));
  if (!row) return null;
  end = Math.min(end, Number(row.size));
  if (row.chunks === 0) return row.data.slice(start, end);
  const data = new Uint8Array(Math.max(0, end - start));
  for (let idx = Math.floor(start / CHUNK_SIZE); idx * CHUNK_SIZE < end; idx++) {
    const chunk = db.objectChunk.key.find(`${projectId}:${oid}:${idx}`);
    if (!chunk) return null;
    const at = idx * CHUNK_SIZE;
    data.set(chunk.data.subarray(Math.max(start, at) - at, Math.min(end, at + chunk.data.length) - at), Math.max(start, at) - start);
  }
  return data;
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
