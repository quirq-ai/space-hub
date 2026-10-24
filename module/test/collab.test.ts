// Spaces, collaborators and presence, run in SpacetimeDB's in-process module harness (no
// server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId, TimeDuration } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { Sha1, objectHeader } from '../src/sha1';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const encoder = new TextEncoder();
function object(kind: string, text: string) {
  const data = encoder.encode(text);
  return { oid: new Sha1().update(objectHeader(kind, data.length)).update(data).hex(), kind, data };
}

const TREE = object('tree', '');
function commit(message: string, parent?: string) {
  const who = 'e2e <e2e@example.com> 0 +0000';
  return object('commit', `tree ${TREE.oid}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n\n${message}\n`);
}

const SPACE = 'alice/notes';
const TEAM_PROJECT_NAME = 'acme/site';

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) =>
    h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice');
  const bob = as('bob');
  call(alice, mod.registerUser, { username: 'alice' });
  call(bob, mod.registerUser, { username: 'bob' });
  call(alice, mod.createSpace, { name: 'notes', description: '' });
  const push = (auth: TestAuth, c: ReturnType<typeof commit>, oldOid: string) => {
    call(auth, mod.putObjects, { space: SPACE, objects: [TREE, c] });
    call(auth, mod.updateRef, { space: SPACE, name: 'refs/heads/main', oldOid, newOid: c.oid, force: false });
  };
  const kinds = () => [...h.db.activity.iter()].map(e => `${e.agent} ${e.kind} ${e.subject}`.trim());
  return { h, call, alice, bob, push, kinds };
}

describe('collaborators', () => {
  it('lets the owner add a member, who can then push', () => {
    const { h, call, alice, bob, push, kinds } = hub();
    const first = commit('first');
    expect(() => push(bob, first, '')).toThrow(/permission denied/);
    expect(() => call(bob, mod.addMember, { space: SPACE, agent: 'bob' })).toThrow(/permission denied/);
    call(alice, mod.addMember, { space: SPACE, agent: 'Bob' });
    call(alice, mod.addMember, { space: SPACE, agent: 'bob' }); // twice is a no-op
    expect([...h.db.projectMember.iter()].map(m => m.agent)).toEqual(['bob']);
    push(bob, first, '');
    const sp = h.db.project.fullName.find(SPACE)!;
    expect(h.db.gitRef.spaceId.filter(sp.id).next().value?.oid).toBe(first.oid);
    expect(kinds()).toContain('alice member_added bob');
    expect(kinds()).toContain('bob ref_created refs/heads/main');
    // The owner and the member keep each other's history: fast-forwards only.
    push(alice, commit('second', first.oid), first.oid);
  });

  it('refuses unknown agents and the owner', () => {
    const { call, alice } = hub();
    expect(() => call(alice, mod.addMember, { space: SPACE, agent: 'nobody' })).toThrow(/no builder or agent named/);
    expect(() => call(alice, mod.addMember, { space: SPACE, agent: 'alice' })).toThrow(/can already push/);
  });

  it('keeps edits, imports, builders, members and deletes with the owner', () => {
    const { call, alice, bob } = hub();
    call(alice, mod.addMember, { space: SPACE, agent: 'bob' });
    expect(() => call(bob, mod.editSpace, { space: SPACE, description: 'x', defaultBranch: undefined })).toThrow(/permission denied/);
    expect(() => call(bob, mod.setBuilder, { space: SPACE, handle: 'octocat', name: '', url: '' })).toThrow(/permission denied/);
    expect(() => call(bob, mod.startImport, { space: SPACE, source: 'https://github.com/o/r' })).toThrow(/permission denied/);
    expect(() => call(bob, mod.deleteSpace, { space: SPACE })).toThrow(/permission denied/);
    call(as('carol'), mod.registerUser, { username: 'carol' });
    expect(() => call(bob, mod.addMember, { space: SPACE, agent: 'carol' })).toThrow(/permission denied/);
  });

  it('lets the owner remove a member and a member leave', () => {
    const { h, call, alice, bob, push, kinds } = hub();
    const carol = as('carol');
    call(carol, mod.registerUser, { username: 'carol' });
    call(alice, mod.addMember, { space: SPACE, agent: 'bob' });
    call(alice, mod.addMember, { space: SPACE, agent: 'carol' });
    expect(() => call(bob, mod.removeMember, { space: SPACE, agent: 'carol' })).toThrow(/permission denied/);
    call(bob, mod.removeMember, { space: SPACE, agent: 'bob' });
    call(alice, mod.removeMember, { space: SPACE, agent: 'carol' });
    expect([...h.db.projectMember.iter()]).toEqual([]);
    expect(() => call(alice, mod.removeMember, { space: SPACE, agent: 'bob' })).toThrow(/not a collaborator/);
    expect(() => push(bob, commit('late'), '')).toThrow(/permission denied/);
    expect(kinds()).toContain('bob member_removed bob');
    expect(kinds()).toContain('alice member_removed carol');
  });
});

describe('presence', () => {
  const second = (n: number) => TimeDuration.fromMillis(n * 1000);

  it('follows a connection from watchSpace to its disconnect', () => {
    const { h, call, bob } = hub();
    call(bob, mod.watchSpace, { space: SPACE, mode: 'autosync', branch: 'main' });
    const row = () => h.db.presence.connectionId.find(bob.connectionId!);
    expect(row()).toMatchObject({ agent: 'bob', mode: 'autosync', branch: 'main' });
    const since = row()!.since;
    h.clock.advance(second(60));
    call(bob, mod.watchSpace, { space: SPACE, mode: 'autosync', branch: 'main' }); // heartbeat
    expect(row()!.since).toEqual(since);
    expect(row()!.seenAt.microsSinceUnixEpoch > since.microsSinceUnixEpoch).toBe(true);
    call(bob, mod.watchSpace, { space: SPACE, mode: 'watch', branch: '' });
    expect(row()!.since.microsSinceUnixEpoch > since.microsSinceUnixEpoch).toBe(true);
    call(bob, mod.clientDisconnected);
    expect(row()).toBeNull();
  });

  it('sweeps rows whose heartbeat stopped when a client connects', () => {
    const { h, call, alice, bob } = hub();
    call(bob, mod.watchSpace, { space: SPACE, mode: 'watch', branch: '' });
    h.clock.advance(second(120));
    call(alice, mod.watchSpace, { space: SPACE, mode: 'sync', branch: 'main' });
    h.clock.advance(second(90));
    call(as('someone'), mod.clientConnected);
    expect([...h.db.presence.iter()].map(r => r.agent)).toEqual(['alice']);
  });

  it('follows a whole space', () => {
    const { h, call, alice, bob } = hub();
    call(alice, mod.createTeam, { name: 'acme', description: '' });
    expect(() => call(bob, mod.watchHub, { space: 'nowhere', mode: 'autosync', host: '' })).toThrow(/no space named/);
    call(bob, mod.watchHub, { space: 'acme', mode: 'autosync', host: '' });
    expect(h.db.presence.connectionId.find(bob.connectionId!)).toMatchObject({ spaceId: 0n, space: 'acme', agent: 'bob', mode: 'autosync' });
    call(bob, mod.watchSpace, { space: SPACE, mode: 'sync', branch: 'main' });
    expect(h.db.presence.connectionId.find(bob.connectionId!)).toMatchObject({ space: 'alice', branch: 'main' });
  });

  it('needs an agent, a known space and a valid mode', () => {
    const { call, bob } = hub();
    expect(() => call(as('anonymous'), mod.watchSpace, { space: SPACE, mode: 'watch', branch: '' })).toThrow(/no builder (or agent )?name/);
    expect(() => call(bob, mod.watchSpace, { space: 'alice/missing', mode: 'watch', branch: '' })).toThrow(/not found/);
    expect(() => call(bob, mod.watchSpace, { space: SPACE, mode: 'lurk', branch: '' })).toThrow(/invalid presence mode/);
    expect(() => call(bob, mod.watchSpace, { space: SPACE, mode: 'sync', branch: 'a..b' })).toThrow(/invalid branch/);
  });
});

describe('spaces', () => {
  const TEAM_PROJECT = 'acme/site';

  it('gives every builder a personal space, and names are shared', () => {
    const { h, call } = hub();
    expect(h.db.hubSpace.name.find('alice')).toMatchObject({ kind: 'personal' });
    expect(() => call(as('x'), mod.createTeam, { name: 'alice', description: '' })).toThrow(/no builder (or agent )?name/);
    expect(() => call(as('alice'), mod.createTeam, { name: 'bob', description: '' })).toThrow(/taken/);
    call(as('alice'), mod.createTeam, { name: 'Acme', description: 'the team' });
    expect(h.db.hubSpace.name.find('acme')).toMatchObject({ kind: 'team', displayName: 'Acme', createdBy: 'alice' });
    expect(() => call(as('carol'), mod.registerUser, { username: 'acme' })).toThrow(/taken/);
  });

  it('lets team members create projects and push; others cannot', () => {
    const { h, call, alice, bob, kinds } = hub();
    call(alice, mod.createTeam, { name: 'acme', description: '' });
    expect(() => call(bob, mod.createProject, { space: 'acme', name: 'site', description: '' })).toThrow(/permission denied/);
    expect(() => call(bob, mod.addSpaceMember, { space: 'acme', member: 'bob', role: 'member' })).toThrow(/permission denied/);
    call(alice, mod.addSpaceMember, { space: 'acme', member: 'bob', role: 'member' });
    call(bob, mod.createProject, { space: 'acme', name: 'site', description: '' });
    const first = commit('first');
    call(bob, mod.putObjects, { space: TEAM_PROJECT, objects: [TREE, first] });
    call(bob, mod.updateRef, { space: TEAM_PROJECT, name: 'refs/heads/main', oldOid: '', newOid: first.oid, force: false });
    expect(h.db.project.fullName.find(TEAM_PROJECT)?.owner).toBe('acme');
    // Members push; owners manage.
    expect(() => call(bob, mod.editSpace, { space: TEAM_PROJECT, description: 'x', defaultBranch: undefined })).toThrow(/permission denied/);
    call(alice, mod.editSpace, { space: TEAM_PROJECT, description: 'x', defaultBranch: undefined });
    const carol = as('carol');
    call(carol, mod.registerUser, { username: 'carol' });
    expect(() => call(carol, mod.putObjects, { space: TEAM_PROJECT, objects: [TREE] })).toThrow(/permission denied/);
    expect(kinds()).toEqual(expect.arrayContaining(['alice team_created acme', 'alice team_member_added bob', 'bob space_created']));
  });

  it('keeps a team owned, and lets members leave', () => {
    const { h, call, alice, bob } = hub();
    call(alice, mod.createTeam, { name: 'acme', description: '' });
    expect(() => call(alice, mod.removeSpaceMember, { space: 'acme', member: 'alice' })).toThrow(/last owner/);
    call(alice, mod.addSpaceMember, { space: 'acme', member: 'bob', role: 'owner' });
    call(bob, mod.removeSpaceMember, { space: 'acme', member: 'alice' });
    expect([...h.db.spaceRole.space.filter('acme')].map(r => `${r.member}:${r.role}`)).toEqual(['bob:owner']);
    call(bob, mod.addSpaceMember, { space: 'acme', member: 'alice', role: 'member' });
    call(alice, mod.removeSpaceMember, { space: 'acme', member: 'alice' });
    expect(() => call(alice, mod.addSpaceMember, { space: 'alice', member: 'bob', role: 'owner' })).toThrow(/only team spaces/);
  });

  it('deletes only an empty team space', () => {
    const { h, call, alice } = hub();
    call(alice, mod.createTeam, { name: 'acme', description: '' });
    call(alice, mod.createProject, { space: 'acme', name: 'site', description: '' });
    expect(() => call(alice, mod.deleteTeam, { space: 'acme' })).toThrow(/still has 1 projects/);
    call(alice, mod.createTeam, { name: 'empty', description: '' });
    call(alice, mod.deleteTeam, { space: 'empty' });
    expect(h.db.hubSpace.name.find('empty')).toBeNull();
    expect(() => call(alice, mod.deleteTeam, { space: 'alice' })).toThrow(/not a team space/);
  });

  it('migrates builders from before spaces', () => {
    const { h, call, alice } = hub();
    h.withReducerTx(alice, ctx => ctx.db.hubSpace.name.delete('alice'));
    expect(h.db.hubSpace.name.find('alice')).toBeNull();
    // Until it runs, a builder still owns its personal space.
    call(alice, mod.createProject, { space: 'alice', name: 'more', description: '' });
    call(alice, mod.migrateSpaces);
    call(alice, mod.migrateSpaces);
    expect(h.db.hubSpace.name.find('alice')).toMatchObject({ kind: 'personal' });
  });
});

describe('GitHub links', () => {
  function linked() {
    const t = hub();
    const admin = as('admin');
    t.call(admin, mod.claimAdmin);
    t.call(t.alice, mod.createTeam, { name: 'acme', description: '' });
    return { ...t, admin };
  }

  it('lets only owners link a space, to a GitHub account', () => {
    const { h, call, alice, bob } = linked();
    expect(() => call(bob, mod.linkSpace, { space: 'acme', source: 'https://github.com/acme' })).toThrow(/permission denied/);
    expect(() => call(alice, mod.linkSpace, { space: 'acme', source: 'https://example.com/acme' })).toThrow(/GitHub user or organization/);
    expect(() => call(alice, mod.linkSpace, { space: 'acme', source: 'https://github.com/acme/repo' })).toThrow(/GitHub user or organization/);
    call(alice, mod.linkSpace, { space: 'acme', source: 'https://github.com/acme/' });
    expect(h.db.spaceLink.space.find('acme')).toMatchObject({ source: 'https://github.com/acme', status: 'requested' });
  });

  it('lets the hub admin sync a linked space only', () => {
    const { h, call, alice, admin, kinds } = linked();
    expect(() => call(admin, mod.createProject, { space: 'acme', name: 'site', description: '' })).toThrow(/no builder (or agent )?name/);
    call(alice, mod.linkSpace, { space: 'acme', source: 'https://github.com/acme' });
    call(admin, mod.setLinkStatus, { space: 'acme', status: 'running', message: 'listing', projects: 0 });
    call(admin, mod.createProject, { space: 'acme', name: 'site', description: '' });
    const first = commit('from github');
    call(admin, mod.putObjects, { space: TEAM_PROJECT_NAME, objects: [TREE, first] });
    call(admin, mod.updateRef, { space: TEAM_PROJECT_NAME, name: 'refs/heads/main', oldOid: '', newOid: first.oid, force: false });
    call(admin, mod.recordRefSync, { project: TEAM_PROJECT_NAME, refs: [{ ref: 'refs/heads/main', githubOid: first.oid, status: 'synced' }] });
    call(admin, mod.recordRefSync, { project: TEAM_PROJECT_NAME, refs: [{ ref: 'refs/heads/main', githubOid: first.oid, status: 'diverged' }] });
    expect(h.db.refSync.key.find(`${h.db.project.fullName.find(TEAM_PROJECT_NAME)!.id}:refs/heads/main`)?.status).toBe('diverged');
    call(admin, mod.setLinkStatus, { space: 'acme', status: 'done', message: '1 project', projects: 1 });
    expect(h.db.spaceLink.space.find('acme')).toMatchObject({ status: 'done', projects: 1 });
    expect(kinds()).toEqual(expect.arrayContaining(['-github space_created', '-github ref_created refs/heads/main', '-github ref_diverged refs/heads/main', '-github space_synced https://github.com/acme']));
    // Not in a space that is not linked.
    expect(() => call(admin, mod.createProject, { space: 'alice', name: 'x', description: '' })).toThrow(/no builder (or agent )?name/);
    expect(() => call(alice, mod.setLinkStatus, { space: 'acme', status: 'done', message: '', projects: 0 })).toThrow(/only the hub admin/);
    call(alice, mod.unlinkSpace, { space: 'acme' });
    expect(() => call(admin, mod.putObjects, { space: TEAM_PROJECT_NAME, objects: [TREE] })).toThrow(/permission denied/);
  });
});

describe('agents', () => {
  function withAgent() {
    const t = hub();
    const scout = as('scout-identity');
    const hex = t.h.withReducerTx(scout, ctx => ctx.sender.toHexString());
    t.call(t.alice, mod.createAgent, { name: 'scout', parent: 'alice', identity: hex, token: 'scout-token', description: 'reads the web' });
    return { ...t, scout, hex };
  }

  it('is a space of its own, owned by its parent', () => {
    const { h, call, bob, scout, hex } = withAgent();
    expect(h.db.hubSpace.name.find('scout')).toMatchObject({ kind: 'agent', parent: 'alice', createdBy: 'alice' });
    expect(() => call(bob, mod.createAgent, { name: 'spy', parent: 'alice', identity: 'cd'.repeat(32), token: 't', description: '' })).toThrow(/permission denied/);
    expect(() => call(bob, mod.createAgent, { name: 'twin', parent: 'bob', identity: hex, token: 't', description: '' })).toThrow(/already a builder or an agent/);
    expect(() => call(bob, mod.createAgent, { name: 'alice', parent: 'bob', identity: 'ef'.repeat(32), token: 't', description: '' })).toThrow(/taken/);
    expect(() => call(scout, mod.registerUser, { username: 'scout2' })).toThrow(/is the agent "scout"/);
  });

  it('pushes as itself to its own projects and to spaces it is connected to', () => {
    const { h, call, alice, bob, scout, push, kinds } = withAgent();
    call(alice, mod.createProject, { space: 'scout', name: 'home', description: '' });
    const own = commit('soul');
    call(scout, mod.putObjects, { space: 'scout/home', objects: [TREE, own] });
    call(scout, mod.updateRef, { space: 'scout/home', name: 'refs/heads/main', oldOid: '', newOid: own.oid, force: false });
    const first = commit('first');
    expect(() => push(scout, first, '')).toThrow(/permission denied/);
    expect(() => call(bob, mod.addSpaceMember, { space: 'bob', member: 'scout', role: 'member' })).toThrow(/owners of the agent/);
    expect(() => call(bob, mod.connectAgent, { agent: 'scout', space: 'bob' })).toThrow(/permission denied/);
    call(alice, mod.connectAgent, { agent: 'scout', space: 'alice' });
    push(scout, first, '');
    expect(kinds()).toEqual(expect.arrayContaining(['alice agent_created alice', 'alice agent_connected scout', 'scout ref_created refs/heads/main']));
    call(alice, mod.disconnectAgent, { agent: 'scout', space: 'alice' });
    expect(() => push(scout, commit('late', first.oid), first.oid)).toThrow(/permission denied/);
    // It reports where it runs.
    call(scout, mod.watchHub, { space: 'scout', mode: 'agent', host: 'swarm-1' });
    expect(h.db.presence.connectionId.find(scout.connectionId!)).toMatchObject({ agent: 'scout', mode: 'agent', host: 'swarm-1', space: 'scout' });
  });

  it('gives its token to its owners only', () => {
    const { h, alice, bob } = withAgent();
    expect(mod.agentToken(h.procedureContext(alice) as never, { agent: 'scout' } as never)).toBe('scout-token');
    expect(() => mod.agentToken(h.procedureContext(bob) as never, { agent: 'scout' } as never)).toThrow(/permission denied/);
    expect(() => mod.agentToken(h.procedureContext(alice) as never, { agent: 'nobody' } as never)).toThrow(/no agent named/);
  });

  it('is deleted once it has no projects', () => {
    const { h, call, alice } = withAgent();
    call(alice, mod.createProject, { space: 'scout', name: 'home', description: '' });
    expect(() => call(alice, mod.deleteAgent, { name: 'scout' })).toThrow(/still has 1 projects/);
    call(alice, mod.createAgent, { name: 'temp', parent: 'alice', identity: 'ab'.repeat(32), token: 't', description: '' });
    call(alice, mod.connectAgent, { agent: 'temp', space: 'alice' });
    call(alice, mod.deleteAgent, { name: 'temp' });
    expect(h.db.hubSpace.name.find('temp')).toBeNull();
    expect([...h.db.spaceRole.member.filter('temp')]).toEqual([]);
  });
});
