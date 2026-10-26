// spacehub: GitHub-shaped git hosting where the database is the server.
//
// The hub has GitHub's two levels. Every top-level name is a space (like a
// GitHub user or organization), and spaces hold projects (repositories),
// addressed as "space/project":
//
//   user          a builder: a person's login, one identity per name
//   hub_space     the top-level names: a builder's personal space, a team
//                 space, or an agent
//   space_role    owners and members of a space
//   space         (code: project) a repository; `owner` is its space
//   git_ref       branch and tag pointers of a project (refs/heads/main -> oid)
//   git_object    content-addressed git objects of a project
//   object_chunk  bodies of objects larger than one chunk, split in order
//   space_member  (code: projectMember) collaborators on one project
//   presence      which connected clients follow which project right now
//   project_size  how many bytes of git objects each project stores
//   agent         an agent: a space of its own, with its own identity
//   agent_secret  (private) an agent's token, for its owners to launch it with
//   space_link    the GitHub user or organization a space mirrors
//   ref_sync      where GitHub had each mirrored ref at the last sync
//
// Stored table and column names predate projects: a table keeps its stored
// name (`space` holds projects) and `spaceId` columns hold a project's id,
// because SpacetimeDB cannot rename them in place. Reducers that take a
// `space` argument and act on one repository keep their old names too, so
// older clients keep working; there `space` is the project's full name.
//
// Reducers are the only write path, so every push is checked here: the
// caller must own or belong to the project's space (or collaborate on the
// project), every object must hash to its id, and a ref only moves if the
// caller saw its current value (compare-and-swap) and, unless forced, the
// move is a fast-forward.
import { schema, table, t, Router, SenderError, SyncResponse, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { Sha1, objectHeader } from './sha1';
import { CHUNK_SIZE, PRESENCE_STALE_SECONDS, commitParents, inSpace, memberKey, objectKey, ownsSpace, readObject, refKey, roleKey } from './store';
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

const project = table(
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

// Where a project was imported from (GitHub) and how the last import went.
// Written by the web service on behalf of the project's space owner.
const projectImport = table(
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

// The GitHub account that built a project's code (its builder). Set on
// GitHub imports, or by hand. Projects without a row are credited to their
// import source's GitHub owner, else to the builder who made them here.
const projectBuilder = table(
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
    spaceId: t.u64().index('btree'), // the project; 0 for hub-wide events (a builder joining, a team space)
    space: t.string(), // space/project at the time (or the space's name), kept after a delete
    agent: t.string(), // who did it: a builder (or an agent)
    kind: t.string(), // agent_registered (a builder joined), space_created (a project), team_created, ref_updated, ...
    subject: t.string(), // ref name, GitHub source or builder login
    oid: t.string(), // commit or tag the event points at
    count: t.u32(), // new commits in a push, or refs in an import
    text: t.string(), // commit subject, import message, builder name, what changed
  }
);

// Collaborators on one project, besides its space's owners and members
// (GitHub's repository collaborators). Its space's owners add and remove
// them; a collaborator can also leave.
const projectMember = table(
  { name: 'space_member', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(), // "<projectId>:<builder>"
    spaceId: t.u64().index('btree'), // the project
    agent: t.string().index('btree'), // the collaborator
    addedBy: t.string(),
    addedAt: t.timestamp(),
  }
);

// The hub's top-level names, like GitHub's users and organizations: every
// /<name> is a space. A builder has a personal space of the same name, a
// team space collects projects for several builders, and an agent is a space
// too. Agents, builders and team spaces share these names.
const hubSpace = table(
  { name: 'hub_space', public: true },
  {
    name: t.string().primaryKey(), // lowercase, a valid GitHub login
    kind: t.string().index('btree'), // personal | team | agent
    displayName: t.string(), // as written, e.g. a GitHub organization's case
    description: t.string(),
    parent: t.string(), // the space that owns an agent; "" otherwise
    createdBy: t.string(),
    createdAt: t.timestamp(),
  }
);

// Who belongs to a space. Owners manage it (members, links, deletes); members
// push to every project in it and create projects. A personal space's owner
// is its builder, and an agent's owners are its parent space's owners, with
// no row for either.
const spaceRole = table(
  { name: 'space_role', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(), // "<space>:<member>"
    space: t.string().index('btree'),
    member: t.string().index('btree'), // a builder or an agent
    role: t.string(), // owner | member
    addedBy: t.string(),
    addedAt: t.timestamp(),
  }
);

// One row per client connection that said which project it follows
// (watchSpace): `space watch`, `space sync --watch` and autosync. The row goes
// with the connection (clientDisconnected). Clients repeat watchSpace as a
// heartbeat; a row whose heartbeat stopped belongs to a connection the server
// never saw close, and is swept when the next client connects.
const presence = table(
  { name: 'presence', public: true },
  {
    connectionId: t.connectionId().primaryKey(),
    spaceId: t.u64().index('btree'), // the project; 0 when following a whole space
    agent: t.string(),
    mode: t.string(), // watch | sync | autosync
    branch: t.string(), // what sync and autosync keep current ("" for watch)
    since: t.timestamp(),
    seenAt: t.timestamp(),
    space: t.string().default(''), // the project's space, or the space followed whole
    host: t.string().default(''), // where a running agent runs, as it says
  }
);

// How much a project stores: the bytes of its git objects as git counts them
// (uncompressed), kept as objects arrive. A project has a row once counted:
// new projects from the start, older ones when measureNextProject reaches
// them (the server measures them in the background after it starts).
const projectSize = table(
  { name: 'project_size', public: true },
  {
    projectId: t.u64().primaryKey(),
    bytes: t.u64(),
  }
);

// An agent is a space (hub_space kind "agent") with an identity of its own:
// it pushes as itself to its own projects and to the spaces it is connected
// to (as a member there). Its owners are its parent space's owners. XO Swarm
// launches it with `spacehub agent run`, which needs its token.
const agent = table(
  { name: 'agent', public: true },
  {
    name: t.string().primaryKey(),
    identity: t.identity().unique(),
    createdBy: t.string(),
    createdAt: t.timestamp(),
  }
);

// Private: only the module reads it, for the agent's owners (agentToken).
const agentSecret = table({ name: 'agent_secret' }, { name: t.string().primaryKey(), token: t.string() });

// The GitHub account (user or organization) a space mirrors: its public
// repositories become projects with the same names, kept in step by the
// web service, which syncs as the hub admin. GitHub to hub only.
const spaceLink = table(
  { name: 'space_link', public: true },
  {
    space: t.string().primaryKey(),
    source: t.string(), // https://github.com/<login>
    status: t.string(), // requested | running | done | failed
    message: t.string(),
    requestedAt: t.timestamp(),
    updatedAt: t.timestamp(),
    syncedAt: t.timestamp(), // the last sync that finished (the epoch before one has)
    projects: t.u32(), // repositories mirrored at the last sync
  }
);

// Where GitHub had each ref of a mirrored project at the last sync. A ref
// that still holds that value has no work done here, so it follows GitHub,
// force pushes included; a ref that moved here only moves forward, and is
// left alone and marked diverged when GitHub went another way.
const refSync = table(
  { name: 'ref_sync', public: true },
  {
    key: t.string().primaryKey(), // "<projectId>:<ref>"
    projectId: t.u64().index('btree'),
    ref: t.string(),
    githubOid: t.string(),
    status: t.string(), // synced | diverged
    at: t.timestamp(),
  }
);

// Flags for one-off jobs, e.g. rebuilding the activity feed's history, and
// the hub's settings: who its admin is ("admin") and where accounts come from
// ("accounts": "github" for sign-up with GitHub, "xo" once xo makes them;
// no row is open sign-up).
const hubState = table({ name: 'hub_state' }, { key: t.string().primaryKey(), value: t.string() });

// What xo.quirq.dev keeps for each xo user (Clerk only says who they are):
// their projects, spaces and invites, as one JSON document per Clerk user id.
// Private: only the admin (the server's own web service, for xo.quirq.dev)
// reads or writes it. `version` moves by one on every write, and a write must
// name the version it read (compare-and-swap).
const xoRecord = table(
  { name: 'xo_record' },
  {
    subject: t.string().primaryKey(),
    doc: t.string(),
    version: t.u64(),
    updatedAt: t.timestamp(),
  }
);

// The hub agent that xo made for a Clerk user: its name is the user's xo
// username, and its token is handed back to that user's xo on every machine.
// Private, like xo_record.
const xoAgent = table(
  { name: 'xo_agent' },
  {
    subject: t.string().primaryKey(),
    username: t.string().unique(),
    identity: t.identity().unique(),
    token: t.string(),
    createdAt: t.timestamp(),
  }
);

// Builders who signed up with GitHub: the GitHub account (by its id, which
// stays when the login is renamed), and the hub token the web service hands
// back whenever that account signs in again, on any machine. Private: only
// the admin (the server's own web service) reads or writes it.
const githubAccount = table(
  { name: 'github_account' },
  {
    githubId: t.u64().primaryKey(),
    login: t.string(), // the GitHub login at sign-up
    username: t.string().unique(),
    identity: t.identity().unique(),
    token: t.string(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  user,
  project,
  gitRef,
  gitObject,
  objectChunk,
  projectImport,
  projectBuilder,
  activity,
  projectMember,
  presence,
  hubSpace,
  spaceRole,
  spaceLink,
  refSync,
  projectSize,
  agent,
  agentSecret,
  hubState,
  xoRecord,
  xoAgent,
  githubAccount,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const ObjectIn = t.object('ObjectIn', {
  oid: t.string(),
  kind: t.string(),
  data: t.byteArray(),
});

// Space names (builders, team spaces, agents) are GitHub logins, lowercased,
// so any GitHub user or organization has the same name here.
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
// First path segments the server's proxy needs for itself.
const RESERVED_USERNAMES = new Set(['v1', 'healthz']);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Project names are GitHub repository names.
const SPACE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OID = /^[0-9a-f]{40}$/;
const KINDS = new Set(['commit', 'tree', 'blob', 'tag']);
const ZERO_OID = '';

// The hub admin acting for a space that mirrors GitHub (the web service's
// sync). Shown in the activity feed as "GitHub sync".
const SYNCER = '-github';

function isAdmin(ctx: Ctx) {
  return ctx.db.hubState.key.find('admin')?.value === ctx.sender.toHexString();
}

function isSyncer(ctx: Ctx, space: string) {
  return isAdmin(ctx) && !!ctx.db.spaceLink.space.find(space);
}

function requireUser(ctx: Ctx) {
  const me = ctx.db.user.identity.find(ctx.sender);
  if (!me) throw new SenderError('no builder name yet: run spacehub auth login --builder <name>');
  return me;
}

// Who is calling: a builder's name, an agent's name, or null.
function actorName(ctx: Ctx): string | null {
  return ctx.db.user.identity.find(ctx.sender)?.username ?? ctx.db.agent.identity.find(ctx.sender)?.name ?? null;
}

function requireActor(ctx: Ctx): string {
  const me = actorName(ctx);
  if (!me) throw new SenderError('no builder or agent name for this identity: run spacehub auth login --builder <name>');
  return me;
}

function requireHubSpace(ctx: Ctx, name: string) {
  const row = ctx.db.hubSpace.name.find(name);
  if (!row) throw new SenderError(`no space named "${name}"`);
  return row;
}

const isOwner = (ctx: Ctx, space: string, actor: string | null) => ownsSpace(ctx.db, space, actor);
const isMember = (ctx: Ctx, space: string, actor: string | null) => inSpace(ctx.db, space, actor);

function requireSpaceOwner(ctx: Ctx, space: string) {
  const row = requireHubSpace(ctx, space);
  if (!isOwner(ctx, space, actorName(ctx))) throw new SenderError(`permission denied: only owners of "${space}" can do this`);
  return row;
}

function requireProject(ctx: Ctx, fullName: string) {
  const row = ctx.db.project.fullName.find(fullName);
  if (!row) throw new SenderError(`project "${fullName}" not found`);
  return row;
}

// Owner-only actions on a project: edits, imports, builder credits,
// collaborators, delete. The owners of its space.
function requireProjectAdmin(ctx: Ctx, fullName: string) {
  const row = requireProject(ctx, fullName);
  if (!isOwner(ctx, row.owner, actorName(ctx)) && !isSyncer(ctx, row.owner)) {
    throw new SenderError(`permission denied: only owners of "${row.owner}" can change "${fullName}"`);
  }
  return row;
}

// Pushes: the space's owners and members, and the project's collaborators.
function requireWritable(ctx: Ctx, fullName: string) {
  const row = requireProject(ctx, fullName);
  const me = actorName(ctx);
  if (isMember(ctx, row.owner, me) || isSyncer(ctx, row.owner)) return row;
  if (me && ctx.db.projectMember.key.find(memberKey(row.id, me))) return row;
  throw new SenderError(`permission denied: you are not an owner or member of "${row.owner}", nor a collaborator on "${fullName}"`);
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
    agent: e.agent ?? actorName(ctx) ?? (isAdmin(ctx) ? SYNCER : ''),
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
  const row = ctx.db.projectImport.spaceId.find(spaceId);
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

// Count `bytes` more for a project that is already counted.
function grow(ctx: Ctx, projectId: bigint, bytes: bigint) {
  const row = ctx.db.projectSize.projectId.find(projectId);
  if (row && bytes > 0n) ctx.db.projectSize.projectId.update({ ...row, bytes: row.bytes + bytes });
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

// A new top-level name: free across builders, team spaces and agents.
function checkSpaceName(ctx: Ctx, name: string) {
  if (!USERNAME.test(name)) {
    throw new SenderError('a name is 1-39 lowercase letters, digits or inner hyphens');
  }
  if (RESERVED_USERNAMES.has(name)) throw new SenderError(`the name "${name}" is reserved`);
  if (ctx.db.user.username.find(name) || ctx.db.hubSpace.name.find(name)) throw new SenderError(`the name "${name}" is taken`);
}

// A builder's login and its personal space.
function addBuilder(ctx: Ctx, identity: Identity, username: string) {
  checkSpaceName(ctx, username);
  ctx.db.user.insert({ identity, username, createdAt: ctx.timestamp });
  ctx.db.hubSpace.insert({ name: username, kind: 'personal', displayName: username, description: '', parent: '', createdBy: username, createdAt: ctx.timestamp });
  logActivity(ctx, { kind: 'agent_registered', agent: username });
}

// Where builders come from: "open" (anyone registers a name), "github" (sign
// up with a GitHub account, through the web service) or "xo".
function accounts(ctx: Ctx) {
  return ctx.db.hubState.key.find('accounts')?.value ?? 'open';
}

export const registerUser = spacetimedb.reducer({ username: t.string() }, (ctx, { username }) => {
  const source = accounts(ctx);
  if (source === 'xo') throw new SenderError('builders on this hub are made by xo: run xo login');
  if (source === 'github') {
    throw new SenderError('builders on this hub sign up with GitHub: log in with gh auth login, then run spacehub auth login');
  }
  const existing = ctx.db.user.identity.find(ctx.sender);
  if (existing) throw new SenderError(`this identity is already the builder "${existing.username}"`);
  const agent = ctx.db.agent.identity.find(ctx.sender);
  if (agent) throw new SenderError(`this identity is the agent "${agent.name}"`);
  addBuilder(ctx, ctx.sender, username);
});

// A builder leaves the hub: its login, its personal space, its places in
// other spaces, and every record of it in the activity feed. Its projects
// and agents go first (spacehub auth delete deletes them), and it cannot be
// the last owner of a team space. Its name is free again afterwards.
export const deleteBuilder = spacetimedb.reducer(ctx => {
  const name = requireUser(ctx).username;
  const projects = [...ctx.db.project.owner.filter(name)].length;
  if (projects) throw new SenderError(`${name} still has ${projects} projects; delete them first`);
  const agents = [...ctx.db.hubSpace.kind.filter('agent')].filter(a => a.parent === name).map(a => a.name);
  if (agents.length) throw new SenderError(`${name} still owns the agents ${agents.join(', ')}; delete them first`);
  const roles = [...ctx.db.spaceRole.member.filter(name)];
  for (const r of roles) {
    if (r.role === 'owner' && [...ctx.db.spaceRole.space.filter(r.space)].filter(o => o.role === 'owner').length === 1) {
      throw new SenderError(`${name} is the last owner of "${r.space}"; add another owner first`);
    }
  }
  for (const r of roles) ctx.db.spaceRole.id.delete(r.id);
  // Its personal space goes as a team space does (deleteTeam): the members it
  // added, its GitHub link and whoever follows it, so a builder who takes the
  // name later starts with none of them.
  for (const r of [...ctx.db.spaceRole.space.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  ctx.db.spaceLink.space.delete(name);
  for (const m of [...ctx.db.projectMember.agent.filter(name)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.iter()]) {
    if (p.agent === name || p.space === name || p.space.startsWith(`${name}/`)) ctx.db.presence.connectionId.delete(p.connectionId);
  }
  const about = new Set(['team_member_added', 'team_member_removed', 'member_added', 'member_removed']);
  for (const e of [...ctx.db.activity.iter()]) {
    const mine = e.agent === name || e.space === name || e.space.startsWith(`${name}/`) || (about.has(e.kind) && e.subject === name);
    if (mine) ctx.db.activity.id.delete(e.id);
  }
  const xo = [...ctx.db.xoAgent.iter()].find(a => a.username === name);
  if (xo) ctx.db.xoAgent.subject.delete(xo.subject);
  ctx.db.githubAccount.username.delete(name);
  ctx.db.hubSpace.name.delete(name);
  ctx.db.user.identity.delete(ctx.sender);
});

// Give every builder from before spaces existed its personal space (and any
// project whose space has no row yet). Runs on every server start; later
// calls find nothing to do.
export const migrateSpaces = spacetimedb.reducer(ctx => {
  const personal = (name: string, createdAt: Timestamp) => {
    if (!ctx.db.hubSpace.name.find(name)) {
      ctx.db.hubSpace.insert({ name, kind: 'personal', displayName: name, description: '', parent: '', createdBy: name, createdAt });
    }
  };
  for (const u of ctx.db.user.iter()) personal(u.username, u.createdAt);
  for (const p of ctx.db.project.iter()) personal(p.owner, p.createdAt);
});

// Count one project from before sizes were kept: add up its objects. One
// project per call, so no single call holds the database long; the server
// calls it in the background until it says every project is counted.
export const measureNextProject = spacetimedb.reducer(ctx => {
  requireAdmin(ctx);
  const sp = [...ctx.db.project.iter()].find(p => !ctx.db.projectSize.projectId.find(p.id));
  if (!sp) throw new SenderError('every project is measured');
  let bytes = 0n;
  for (const obj of ctx.db.gitObject.bySpacePos.filter(sp.id)) bytes += obj.size;
  ctx.db.projectSize.insert({ projectId: sp.id, bytes });
});

// ---------------------------------------------------------------- admin and xo

// The first identity to call this becomes the hub's admin, for good. The
// server's entrypoint calls it right after publishing, as the identity that
// owns the database, and refuses to start if someone else holds it.
export const claimAdmin = spacetimedb.reducer(ctx => {
  const admin = ctx.db.hubState.key.find('admin');
  if (admin) {
    if (admin.value !== ctx.sender.toHexString()) throw new SenderError('the hub admin is already another identity');
    return;
  }
  ctx.db.hubState.insert({ key: 'admin', value: ctx.sender.toHexString() });
});

function requireAdmin(ctx: Ctx) {
  if (ctx.db.hubState.key.find('admin')?.value !== ctx.sender.toHexString()) {
    throw new SenderError('permission denied: only the hub admin can do this');
  }
}

// "open": anyone can register a name; "github": builders sign up with a
// GitHub account and get its login as their name; "xo": only xo makes them.
export const setAccounts = spacetimedb.reducer({ source: t.string() }, (ctx, { source }) => {
  requireAdmin(ctx);
  if (source !== 'xo' && source !== 'open' && source !== 'github') throw new SenderError('accounts are "open", "github" or come from "xo"');
  const row = ctx.db.hubState.key.find('accounts');
  if (row) ctx.db.hubState.key.update({ ...row, value: source });
  else ctx.db.hubState.insert({ key: 'accounts', value: source });
});

// Clerk user ids, as Clerk writes them (user_2abc...).
const XO_SUBJECT = /^[A-Za-z0-9_]{1,64}$/;
const MAX_XO_DOC = 256 * 1024;

function checkSubject(subject: string) {
  if (!XO_SUBJECT.test(subject)) throw new SenderError(`invalid xo user id "${subject}"`);
}

export const xoPutRecord = spacetimedb.reducer(
  { subject: t.string(), version: t.u64(), doc: t.string() },
  (ctx, { subject, version, doc }) => {
    requireAdmin(ctx);
    checkSubject(subject);
    if (doc.length > MAX_XO_DOC) throw new SenderError(`record is larger than ${MAX_XO_DOC} bytes`);
    try {
      const parsed: unknown = JSON.parse(doc);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new SenderError('record must be a JSON object');
    }
    const current = ctx.db.xoRecord.subject.find(subject);
    const at = current?.version ?? 0n;
    if (at !== version) throw new SenderError(`stale: the record of ${subject} is at version ${at}`);
    const row = { subject, doc, version: at + 1n, updatedAt: ctx.timestamp };
    if (current) ctx.db.xoRecord.subject.update(row);
    else ctx.db.xoRecord.insert(row);
  }
);

// Make `identity` (a new identity whose token the admin holds) the agent
// `username` for the xo user `subject`.
export const xoLinkAgent = spacetimedb.reducer(
  { subject: t.string(), username: t.string(), identity: t.string(), token: t.string() },
  (ctx, { subject, username, identity: hex, token }) => {
    requireAdmin(ctx);
    checkSubject(subject);
    if (ctx.db.xoAgent.subject.find(subject)) throw new SenderError(`xo user ${subject} already has an agent`);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity)) throw new SenderError('that identity is already a builder');
    addBuilder(ctx, identity, username);
    ctx.db.xoAgent.insert({ subject, username, identity, token, createdAt: ctx.timestamp });
  }
);

// Make `identity` (a new identity whose token the admin holds) the builder for
// the GitHub account `githubId`, named after its login. The web service calls
// this once it has checked the account with GitHub; on a hub whose builders
// come from xo, GitHub sign-up is off.
export const githubLinkBuilder = spacetimedb.reducer(
  { githubId: t.u64(), login: t.string(), identity: t.string(), token: t.string() },
  (ctx, { githubId, login, identity: hex, token }) => {
    requireAdmin(ctx);
    if (accounts(ctx) === 'xo') throw new SenderError('builders on this hub are made by xo: run xo login');
    if (githubId === 0n) throw new SenderError('invalid GitHub account id');
    if (!GITHUB_LOGIN.test(login)) throw new SenderError(`invalid GitHub login "${login}"`);
    const known = ctx.db.githubAccount.githubId.find(githubId);
    if (known) throw new SenderError(`that GitHub account is already the builder "${known.username}"`);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity) || ctx.db.agent.identity.find(identity)) throw new SenderError('that identity is already a builder or an agent');
    const username = login.toLowerCase();
    addBuilder(ctx, identity, username);
    ctx.db.githubAccount.insert({ githubId, login, username, identity, token, createdAt: ctx.timestamp });
  }
);

function createProjectIn(ctx: Ctx, space: string, name: string, description: string) {
  const me = isSyncer(ctx, space) ? SYNCER : requireActor(ctx);
  if (!SPACE_NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    throw new SenderError('a project name may use letters, digits, ".", "_" and "-" and must not end in .git');
  }
  if (!ctx.db.hubSpace.name.find(space) && space !== me) throw new SenderError(`no space named "${space}"`);
  if (me !== SYNCER && !isMember(ctx, space, me)) throw new SenderError(`permission denied: only owners and members of "${space}" create projects in it`);
  const fullName = `${space}/${name}`;
  if (ctx.db.project.fullName.find(fullName)) throw new SenderError(`project "${fullName}" already exists`);
  const created = ctx.db.project.insert({
    id: 0n,
    fullName,
    owner: space,
    ownerIdentity: ctx.sender,
    name,
    description: description.slice(0, 500),
    defaultBranch: 'main',
    objectCount: 0n,
    objectPos: 0n,
    createdAt: ctx.timestamp,
    pushedAt: ctx.timestamp,
  });
  ctx.db.projectSize.insert({ projectId: created.id, bytes: 0n });
  logActivity(ctx, { kind: 'space_created', spaceId: created.id, space: fullName, agent: me });
}

// A project in the caller's personal space (from before team spaces).
export const createSpace = spacetimedb.reducer(
  { name: t.string(), description: t.string() },
  (ctx, { name, description }) => createProjectIn(ctx, requireUser(ctx).username, name, description)
);

export const createProject = spacetimedb.reducer(
  { space: t.string(), name: t.string(), description: t.string() },
  (ctx, { space, name, description }) => createProjectIn(ctx, space.trim().toLowerCase(), name, description)
);

export const deleteSpace = spacetimedb.reducer({ space: t.string() }, (ctx, { space: fullName }) => {
  const sp = requireProjectAdmin(ctx, fullName);
  logActivity(ctx, { kind: 'space_deleted', spaceId: sp.id, space: sp.fullName });
  for (const ref of [...ctx.db.gitRef.spaceId.filter(sp.id)]) ctx.db.gitRef.id.delete(ref.id);
  for (const obj of [...ctx.db.gitObject.bySpacePos.filter(sp.id)]) ctx.db.gitObject.id.delete(obj.id);
  for (const chunk of [...ctx.db.objectChunk.bySpaceOid.filter(sp.id)]) ctx.db.objectChunk.id.delete(chunk.id);
  for (const m of [...ctx.db.projectMember.spaceId.filter(sp.id)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.spaceId.filter(sp.id)]) ctx.db.presence.connectionId.delete(p.connectionId);
  for (const r of [...ctx.db.refSync.projectId.filter(sp.id)]) ctx.db.refSync.key.delete(r.key);
  ctx.db.projectSize.projectId.delete(sp.id);
  ctx.db.projectImport.spaceId.delete(sp.id);
  ctx.db.projectBuilder.spaceId.delete(sp.id);
  ctx.db.project.id.delete(sp.id);
});

// Credit the GitHub account (user or organization) that built the space's
// code. `handle` is its login; the profile link is derived from it (the
// `url` argument is ignored). An empty handle clears the credit, so the
// space falls back to its import source's owner, else its agent.
export const setBuilder = spacetimedb.reducer(
  { space: t.string(), handle: t.string(), name: t.string(), url: t.string() },
  (ctx, { space: fullName, handle, name }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    const login = handle.trim();
    if (login === '') {
      if (ctx.db.projectBuilder.spaceId.delete(sp.id)) logActivity(ctx, { kind: 'builder_cleared', spaceId: sp.id, space: sp.fullName });
      return;
    }
    if (!GITHUB_LOGIN.test(login)) throw new SenderError(`"${login}" is not a GitHub user or organization name`);
    const row = { spaceId: sp.id, handle: login.toLowerCase(), name: (name.trim() || login).slice(0, 100), url: `https://github.com/${login}` };
    if (ctx.db.projectBuilder.spaceId.find(sp.id)) ctx.db.projectBuilder.spaceId.update(row);
    else ctx.db.projectBuilder.insert(row);
    logActivity(ctx, { kind: 'builder_set', spaceId: sp.id, space: sp.fullName, subject: row.handle, text: row.name });
  }
);

// Change a space's description and/or default branch; omitted fields stay.
export const editSpace = spacetimedb.reducer(
  { space: t.string(), description: t.option(t.string()), defaultBranch: t.option(t.string()) },
  (ctx, { space: fullName, description, defaultBranch }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (defaultBranch !== undefined && !validRefName(`refs/heads/${defaultBranch}`)) {
      throw new SenderError(`invalid branch name "${defaultBranch}"`);
    }
    const next = {
      ...sp,
      description: description === undefined ? sp.description : description.slice(0, 500),
      defaultBranch: defaultBranch ?? sp.defaultBranch,
    };
    ctx.db.project.id.update(next);
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
    let added = 0n;
    for (const { oid, kind, data } of objects) {
      if (!OID.test(oid)) throw new SenderError(`invalid object id "${oid}"`);
      if (!KINDS.has(kind)) throw new SenderError(`invalid object kind "${kind}"`);
      if (data.length > CHUNK_SIZE) throw new SenderError(`object ${oid} is larger than one chunk; upload it with putChunk`);
      if (ctx.db.gitObject.key.find(objectKey(sp.id, oid))) continue;
      const actual = new Sha1().update(objectHeader(kind, data.length)).update(data).hex();
      if (actual !== oid) throw new SenderError(`object ${oid} hashes to ${actual}`);
      insertObject(ctx, sp, oid, kind, data.length, 0, data);
      added += BigInt(data.length);
    }
    ctx.db.project.id.update(sp);
    grow(ctx, sp.id, added);
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
    ctx.db.project.id.update(sp);
    grow(ctx, sp.id, BigInt(total));
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
      ctx.db.project.id.update({ ...sp, pushedAt: ctx.timestamp });
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
    ctx.db.project.id.update({ ...sp, defaultBranch, pushedAt: ctx.timestamp });
    if (!importing(ctx, sp.id) && current?.oid !== newOid) {
      const base = { spaceId: sp.id, space: sp.fullName, subject: name, oid: newOid, text: subjectOf(ctx, sp.id, newOid) };
      if (!current) logActivity(ctx, { ...base, kind: 'ref_created' });
      else if (!fastForward) logActivity(ctx, { ...base, kind: 'ref_forced' });
      else logActivity(ctx, { ...base, kind: 'ref_updated', count: firstParentDistance(ctx, sp.id, newOid, current.oid) });
    }
  }
);

// ---------------------------------------------------------------- spaces

// A builder or an agent: someone who can belong to a space.
function requireMemberName(ctx: Ctx, name: string) {
  const row = ctx.db.hubSpace.name.find(name);
  if (ctx.db.user.username.find(name) || row?.kind === 'agent') return row?.kind === 'agent' ? 'agent' : 'builder';
  throw new SenderError(`no builder or agent named "${name}"`);
}

export const createTeam = spacetimedb.reducer({ name: t.string(), description: t.string() }, (ctx, { name: raw, description }) => {
  const me = requireUser(ctx).username;
  const name = raw.trim().toLowerCase();
  checkSpaceName(ctx, name);
  ctx.db.hubSpace.insert({ name, kind: 'team', displayName: raw.trim(), description: description.slice(0, 500), parent: '', createdBy: me, createdAt: ctx.timestamp });
  ctx.db.spaceRole.insert({ id: 0n, key: roleKey(name, me), space: name, member: me, role: 'owner', addedBy: me, addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'team_created', space: name, subject: name });
});

export const editHubSpace = spacetimedb.reducer({ space: t.string(), description: t.string() }, (ctx, { space, description }) => {
  const row = requireSpaceOwner(ctx, space);
  ctx.db.hubSpace.name.update({ ...row, description: description.slice(0, 500) });
  logActivity(ctx, { kind: 'team_edited', space, subject: space, text: 'changed the description' });
});

// Only an empty team space goes: its projects and agents first.
export const deleteTeam = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  const row = requireSpaceOwner(ctx, space);
  if (row.kind !== 'team') throw new SenderError(`"${space}" is not a team space`);
  const projects = [...ctx.db.project.owner.filter(space)].length;
  const agents = [...ctx.db.hubSpace.kind.filter('agent')].filter(a => a.parent === space).length;
  if (projects || agents) throw new SenderError(`"${space}" still has ${projects} projects and ${agents} agents; delete or move them first`);
  for (const r of [...ctx.db.spaceRole.space.filter(space)]) ctx.db.spaceRole.id.delete(r.id);
  ctx.db.spaceLink.space.delete(space);
  for (const p of [...ctx.db.presence.spaceId.filter(0n)]) if (p.space === space) ctx.db.presence.connectionId.delete(p.connectionId);
  ctx.db.hubSpace.name.delete(space);
  logActivity(ctx, { kind: 'team_deleted', space, subject: space });
});

// Add a member or owner, or change a member's role. A personal space has
// one owner, its builder.
export const addSpaceMember = spacetimedb.reducer(
  { space: t.string(), member: t.string(), role: t.string() },
  (ctx, { space, member: raw, role }) => {
    const row = requireSpaceOwner(ctx, space);
    const member = raw.trim().toLowerCase();
    if (requireMemberName(ctx, member) === 'agent' && !isOwner(ctx, member, actorName(ctx))) {
      throw new SenderError(`permission denied: only the owners of the agent "${member}" connect it`);
    }
    if (role !== 'owner' && role !== 'member') throw new SenderError('a role is "owner" or "member"');
    if (row.kind !== 'team' && role === 'owner') throw new SenderError(`only team spaces have more owners; "${space}" is a ${row.kind} space`);
    if (member === space || (row.kind === 'agent' && isOwner(ctx, space, member))) throw new SenderError(`${member} already owns "${space}"`);
    const key = roleKey(space, member);
    const current = ctx.db.spaceRole.key.find(key);
    if (current?.role === role) return;
    const me = requireActor(ctx);
    if (current) ctx.db.spaceRole.id.update({ ...current, role });
    else ctx.db.spaceRole.insert({ id: 0n, key, space, member, role, addedBy: me, addedAt: ctx.timestamp });
    logActivity(ctx, { kind: 'team_member_added', space, subject: member, text: role });
  }
);

// An owner removes a member, or a member leaves. A team space keeps at
// least one owner.
export const removeSpaceMember = spacetimedb.reducer({ space: t.string(), member: t.string() }, (ctx, { space, member: raw }) => {
  requireHubSpace(ctx, space);
  const member = raw.trim().toLowerCase();
  const me = actorName(ctx);
  if (!isOwner(ctx, space, me) && me !== member) throw new SenderError(`permission denied: only owners of "${space}" remove its members`);
  const row = ctx.db.spaceRole.key.find(roleKey(space, member));
  if (!row) throw new SenderError(`${member} is not a member of "${space}"`);
  if (row.role === 'owner' && [...ctx.db.spaceRole.space.filter(space)].filter(r => r.role === 'owner').length === 1) {
    throw new SenderError(`${member} is the last owner of "${space}"; add another owner first`);
  }
  ctx.db.spaceRole.id.delete(row.id);
  logActivity(ctx, { kind: 'team_member_removed', space, subject: member });
});

// ---------------------------------------------------------------- agents

// Make an agent: a space named `name`, owned by `parent` (your personal space
// or a team you own), whose identity is `identity`. The caller made that
// identity and holds its token, which the hub keeps for the agent's owners.
export const createAgent = spacetimedb.reducer(
  { name: t.string(), parent: t.string(), identity: t.string(), token: t.string(), description: t.string() },
  (ctx, { name: raw, parent, identity: hex, token, description }) => {
    const me = requireUser(ctx).username;
    const name = raw.trim().toLowerCase();
    const owner = requireHubSpace(ctx, parent);
    if (owner.kind === 'agent') throw new SenderError('an agent belongs to a builder or a team space, not to another agent');
    if (!isOwner(ctx, parent, me)) throw new SenderError(`permission denied: only owners of "${parent}" make agents in it`);
    checkSpaceName(ctx, name);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new SenderError('identity must be 64 hex digits');
    if (!token || token.length > 4096) throw new SenderError('invalid token');
    const identity = Identity.fromString(hex.replace(/^0x/, '').toLowerCase());
    if (ctx.db.user.identity.find(identity) || ctx.db.agent.identity.find(identity)) throw new SenderError('that identity is already a builder or an agent');
    ctx.db.hubSpace.insert({ name, kind: 'agent', displayName: raw.trim(), description: description.slice(0, 500), parent, createdBy: me, createdAt: ctx.timestamp });
    ctx.db.agent.insert({ name, identity, createdBy: me, createdAt: ctx.timestamp });
    ctx.db.agentSecret.insert({ name, token });
    logActivity(ctx, { kind: 'agent_created', space: name, subject: parent });
  }
);

function requireAgent(ctx: Ctx, name: string) {
  const row = ctx.db.hubSpace.name.find(name);
  if (row?.kind !== 'agent') throw new SenderError(`no agent named "${name}"`);
  return row;
}

// Delete an agent with no projects left (delete them first).
export const deleteAgent = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  requireAgent(ctx, name);
  if (!isOwner(ctx, name, actorName(ctx))) throw new SenderError(`permission denied: only the owners of "${name}" delete it`);
  const projects = [...ctx.db.project.owner.filter(name)].length;
  if (projects) throw new SenderError(`"${name}" still has ${projects} projects; delete them first`);
  for (const r of [...ctx.db.spaceRole.member.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  for (const r of [...ctx.db.spaceRole.space.filter(name)]) ctx.db.spaceRole.id.delete(r.id);
  for (const m of [...ctx.db.projectMember.agent.filter(name)]) ctx.db.projectMember.id.delete(m.id);
  for (const p of [...ctx.db.presence.iter()]) if (p.agent === name) ctx.db.presence.connectionId.delete(p.connectionId);
  ctx.db.agentSecret.name.delete(name);
  ctx.db.agent.name.delete(name);
  ctx.db.hubSpace.name.delete(name);
  logActivity(ctx, { kind: 'agent_deleted', space: name });
});

// Connect an agent to a space: it becomes a member there. The caller must
// own both, so neither side is volunteered by the other.
export const connectAgent = spacetimedb.reducer({ agent: t.string(), space: t.string() }, (ctx, { agent: name, space }) => {
  requireAgent(ctx, name);
  const row = requireSpaceOwner(ctx, space);
  const me = requireActor(ctx);
  if (!isOwner(ctx, name, me)) throw new SenderError(`permission denied: only the owners of "${name}" connect it`);
  if (row.kind === 'agent') throw new SenderError('agents connect to builders\' and team spaces, not to other agents');
  const key = roleKey(space, name);
  if (ctx.db.spaceRole.key.find(key)) return;
  ctx.db.spaceRole.insert({ id: 0n, key, space, member: name, role: 'member', addedBy: me, addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'agent_connected', space, subject: name });
});

// Owners of either side can disconnect.
export const disconnectAgent = spacetimedb.reducer({ agent: t.string(), space: t.string() }, (ctx, { agent: name, space }) => {
  requireAgent(ctx, name);
  const me = actorName(ctx);
  if (!isOwner(ctx, name, me) && !isOwner(ctx, space, me)) throw new SenderError(`permission denied: only owners of "${name}" or "${space}" disconnect them`);
  const row = ctx.db.spaceRole.key.find(roleKey(space, name));
  if (!row) throw new SenderError(`${name} is not connected to "${space}"`);
  ctx.db.spaceRole.id.delete(row.id);
  logActivity(ctx, { kind: 'agent_disconnected', space, subject: name });
});

// An agent's token, for its owners (to launch it, e.g. from XO Swarm).
// A procedure, so the token goes back to the caller alone.
export const agentToken = spacetimedb.procedure({ agent: t.string() }, t.string(), (ctx, { agent: name }) =>
  ctx.withTx(tx => {
    const db = tx.db as Ctx['db'];
    const me = db.user.identity.find(ctx.sender)?.username ?? null;
    if (db.hubSpace.name.find(name)?.kind !== 'agent') throw new SenderError(`no agent named "${name}"`);
    if (!ownsSpace(db, name, me)) throw new SenderError(`permission denied: only the owners of "${name}" read its token`);
    return db.agentSecret.name.find(name)?.token ?? '';
  })
);

// ---------------------------------------------------------------- GitHub links

const GITHUB_ACCOUNT = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/?$/;

// Mirror a GitHub user's or organization's public repositories into the
// space, and sync now.
export const linkSpace = spacetimedb.reducer({ space: t.string(), source: t.string() }, (ctx, { space, source }) => {
  requireSpaceOwner(ctx, space);
  const m = GITHUB_ACCOUNT.exec(source.trim());
  if (!m) throw new SenderError('link a GitHub user or organization, like https://github.com/anthropics');
  const url = `https://github.com/${m[1]}`;
  const current = ctx.db.spaceLink.space.find(space);
  const row = {
    space,
    source: url,
    status: 'requested',
    message: 'waiting for the hub',
    requestedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    syncedAt: current && current.source === url ? current.syncedAt : Timestamp.UNIX_EPOCH,
    projects: current && current.source === url ? current.projects : 0,
  };
  if (current) ctx.db.spaceLink.space.update(row);
  else ctx.db.spaceLink.insert(row);
  if (current?.source !== url) logActivity(ctx, { kind: 'space_linked', space, subject: url });
});

export const requestSync = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  requireSpaceOwner(ctx, space);
  const row = ctx.db.spaceLink.space.find(space);
  if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
  if (row.status === 'requested' || row.status === 'running') return;
  ctx.db.spaceLink.space.update({ ...row, status: 'requested', message: 'waiting for the hub', requestedAt: ctx.timestamp, updatedAt: ctx.timestamp });
});

// Stop mirroring; the projects stay.
export const unlinkSpace = spacetimedb.reducer({ space: t.string() }, (ctx, { space }) => {
  requireSpaceOwner(ctx, space);
  const row = ctx.db.spaceLink.space.find(space);
  if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
  ctx.db.spaceLink.space.delete(space);
  logActivity(ctx, { kind: 'space_unlinked', space, subject: row.source });
});

// The web service's progress on a space's sync.
export const setLinkStatus = spacetimedb.reducer(
  { space: t.string(), status: t.string(), message: t.string(), projects: t.u32() },
  (ctx, { space, status, message, projects }) => {
    requireAdmin(ctx);
    const row = ctx.db.spaceLink.space.find(space);
    if (!row) throw new SenderError(`"${space}" is not linked to GitHub`);
    if (!['running', 'done', 'failed'].includes(status)) throw new SenderError(`invalid sync status "${status}"`);
    const done = status === 'done';
    ctx.db.spaceLink.space.update({ ...row, status, message: message.slice(0, 2000), updatedAt: ctx.timestamp, syncedAt: done ? ctx.timestamp : row.syncedAt, projects: done ? projects : row.projects });
    if (done) logActivity(ctx, { kind: 'space_synced', space, subject: row.source, count: projects, text: message });
    if (status === 'failed') logActivity(ctx, { kind: 'space_sync_failed', space, subject: row.source, text: message });
  }
);

const RefSyncIn = t.object('RefSyncIn', { ref: t.string(), githubOid: t.string(), status: t.string() });

// Where GitHub had refs at this sync, and whether the hub's copy follows
// each one ("synced"), went its own way ("diverged"), or is gone with it
// ("gone").
export const recordRefSync = spacetimedb.reducer(
  { project: t.string(), refs: t.array(RefSyncIn) },
  (ctx, { project: fullName, refs }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    for (const { ref, githubOid, status } of refs) {
      if (!validRefName(ref)) throw new SenderError(`invalid ref name "${ref}"`);
      const key = `${sp.id}:${ref}`;
      const current = ctx.db.refSync.key.find(key);
      if (status === 'gone') {
        if (current) ctx.db.refSync.key.delete(key);
        continue;
      }
      if (status !== 'synced' && status !== 'diverged') throw new SenderError(`invalid ref status "${status}"`);
      if (!OID.test(githubOid)) throw new SenderError(`invalid object id "${githubOid}"`);
      const row = { key, projectId: sp.id, ref, githubOid, status, at: ctx.timestamp };
      if (current) ctx.db.refSync.key.update(row);
      else ctx.db.refSync.insert(row);
      if (status === 'diverged' && current?.status !== 'diverged') {
        logActivity(ctx, { kind: 'ref_diverged', spaceId: sp.id, space: sp.fullName, subject: ref, oid: githubOid });
      }
    }
  }
);

// ---------------------------------------------------------------- collaborators

// Let one more builder push to one project. Adding one twice is a no-op.
// (Reducer names from before team spaces: "member" here is a collaborator.)
export const addMember = spacetimedb.reducer({ space: t.string(), agent: t.string() }, (ctx, { space: fullName, agent }) => {
  const sp = requireProjectAdmin(ctx, fullName);
  const name = agent.trim().toLowerCase();
  if (requireMemberName(ctx, name) === 'agent' && !isOwner(ctx, name, actorName(ctx))) {
    throw new SenderError(`permission denied: only the owners of the agent "${name}" connect it`);
  }
  if (isMember(ctx, sp.owner, name)) throw new SenderError(`${name} belongs to "${sp.owner}" and can already push to "${sp.fullName}"`);
  const key = memberKey(sp.id, name);
  if (ctx.db.projectMember.key.find(key)) return;
  ctx.db.projectMember.insert({ id: 0n, key, spaceId: sp.id, agent: name, addedBy: requireActor(ctx), addedAt: ctx.timestamp });
  logActivity(ctx, { kind: 'member_added', spaceId: sp.id, space: sp.fullName, subject: name });
});

// A space owner removes a collaborator, or a collaborator leaves.
export const removeMember = spacetimedb.reducer({ space: t.string(), agent: t.string() }, (ctx, { space: fullName, agent }) => {
  const sp = requireProject(ctx, fullName);
  const name = agent.trim().toLowerCase();
  const me = actorName(ctx);
  if (!isOwner(ctx, sp.owner, me) && me !== name) {
    throw new SenderError(`permission denied: only owners of "${sp.owner}" remove collaborators on "${fullName}"`);
  }
  const row = ctx.db.projectMember.key.find(memberKey(sp.id, name));
  if (!row) throw new SenderError(`${name} is not a collaborator on "${sp.fullName}"`);
  ctx.db.projectMember.id.delete(row.id);
  logActivity(ctx, { kind: 'member_removed', spaceId: sp.id, space: sp.fullName, subject: name });
});

// ---------------------------------------------------------------- presence

const PRESENCE_MODES = new Set(['watch', 'sync', 'autosync', 'agent']);
const PRESENCE_STALE_MICROS = BigInt(PRESENCE_STALE_SECONDS) * 1_000_000n;

// This connection follows `space` (`branch` for sync and autosync). Called
// again as a heartbeat; `since` stays while the space, mode and branch do.
export const watchSpace = spacetimedb.reducer(
  { space: t.string(), mode: t.string(), branch: t.string() },
  (ctx, { space: fullName, mode, branch }) => {
    const me = { username: requireActor(ctx) };
    const sp = requireProject(ctx, fullName);
    if (!PRESENCE_MODES.has(mode)) throw new SenderError(`invalid presence mode "${mode}"`);
    if (branch !== '' && !validRefName(`refs/heads/${branch}`)) throw new SenderError(`invalid branch name "${branch}"`);
    const connectionId = ctx.connectionId;
    if (!connectionId) throw new SenderError('presence needs a live connection');
    const current = ctx.db.presence.connectionId.find(connectionId);
    const same = current && current.spaceId === sp.id && current.mode === mode && current.branch === branch;
    const row = { connectionId, spaceId: sp.id, agent: me.username, mode, branch, since: same ? current.since : ctx.timestamp, seenAt: ctx.timestamp, space: sp.owner, host: '' };
    if (current) ctx.db.presence.connectionId.update(row);
    else ctx.db.presence.insert(row);
  }
);

// This connection follows every project of `space` (space clone and sync,
// and agents, which name the host they run on).
export const watchHub = spacetimedb.reducer({ space: t.string(), mode: t.string(), host: t.string() }, (ctx, { space, mode, host }) => {
  const me = requireActor(ctx);
  requireHubSpace(ctx, space);
  if (!PRESENCE_MODES.has(mode)) throw new SenderError(`invalid presence mode "${mode}"`);
  const connectionId = ctx.connectionId;
  if (!connectionId) throw new SenderError('presence needs a live connection');
  const current = ctx.db.presence.connectionId.find(connectionId);
  const same = current && current.spaceId === 0n && current.space === space && current.mode === mode;
  const row = { connectionId, spaceId: 0n, agent: me, mode, branch: '', since: same ? current.since : ctx.timestamp, seenAt: ctx.timestamp, space, host: host.slice(0, 100) };
  if (current) ctx.db.presence.connectionId.update(row);
  else ctx.db.presence.insert(row);
});

export const leaveSpace = spacetimedb.reducer(ctx => {
  if (ctx.connectionId) ctx.db.presence.connectionId.delete(ctx.connectionId);
});

// Sweep presence left by connections whose close the server never saw.
export const clientConnected = spacetimedb.clientConnected(ctx => {
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - PRESENCE_STALE_MICROS;
  for (const row of [...ctx.db.presence.iter()]) {
    if (row.seenAt.microsSinceUnixEpoch < cutoff) ctx.db.presence.connectionId.delete(row.connectionId);
  }
});

export const clientDisconnected = spacetimedb.clientDisconnected(ctx => {
  if (ctx.connectionId) ctx.db.presence.connectionId.delete(ctx.connectionId);
});

// ---------------------------------------------------------------- imports

const GITHUB_SOURCE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Record that an import into the space has started.
export const startImport = spacetimedb.reducer(
  { space: t.string(), source: t.string() },
  (ctx, { space: fullName, source }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (!GITHUB_SOURCE.test(source)) throw new SenderError('only https://github.com/<owner>/<repo> can be imported');
    const row = ctx.db.projectImport.spaceId.find(sp.id);
    if (row && row.status === 'running' && ctx.timestamp.microsSinceUnixEpoch - row.updatedAt.microsSinceUnixEpoch < IMPORT_STALE_MICROS) {
      throw new SenderError('an import into this space is already running');
    }
    const next = { spaceId: sp.id, source, status: 'running', message: 'starting', startedAt: ctx.timestamp, updatedAt: ctx.timestamp };
    if (row) ctx.db.projectImport.spaceId.update(next);
    else ctx.db.projectImport.insert(next);
    const syncing = ctx.db.gitRef.spaceId.filter(sp.id).next().done === false;
    logActivity(ctx, { kind: syncing ? 'sync_started' : 'import_started', spaceId: sp.id, space: sp.fullName, subject: source });
  }
);

// Report progress or the outcome of an import.
export const updateImport = spacetimedb.reducer(
  { space: t.string(), status: t.string(), message: t.string() },
  (ctx, { space: fullName, status, message }) => {
    const sp = requireProjectAdmin(ctx, fullName);
    if (!['running', 'done', 'failed'].includes(status)) throw new SenderError(`invalid import status "${status}"`);
    const row = ctx.db.projectImport.spaceId.find(sp.id);
    if (!row) throw new SenderError(`no import recorded for "${fullName}"`);
    ctx.db.projectImport.spaceId.update({ ...row, status, message: message.slice(0, 2000), updatedAt: ctx.timestamp });
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
  for (const sp of [...ctx.db.project.iter()]) {
    const logged = [...ctx.db.activity.spaceId.filter(sp.id)];
    const seen = (kind: string, subject = '') => logged.some(e => e.kind === kind && e.subject === subject);
    const base = { spaceId: sp.id, space: sp.fullName, agent: sp.owner };
    if (!seen('space_created')) logActivity(ctx, { ...base, kind: 'space_created', at: sp.createdAt });
    const builder = ctx.db.projectBuilder.spaceId.find(sp.id);
    if (builder && !seen('builder_set', builder.handle)) {
      logActivity(ctx, { ...base, kind: 'builder_set', at: sp.createdAt, subject: builder.handle, text: builder.name });
    }
    const refs = [...ctx.db.gitRef.spaceId.filter(sp.id)];
    const imp = ctx.db.projectImport.spaceId.find(sp.id);
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
