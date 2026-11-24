// Private projects: who may read a project (store.ts canRead), and the
// project_access table the reducers keep equal to it (npm test). Every test
// that changes who may read ends by comparing the table with a recompute from
// scratch over every builder and agent of the hub.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { HUB_ROW, PUBLIC_READER, canRead, checkAccessTable, isPrivate } from '../src/store';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const admin = as('admin');

// alice owns the hub. acme is an org: bob owns it, dave is a member, and
// acmebot is its agent (owned by acme's owners). scout is bob's agent, cbot
// carol's, ebot eve's. acme/secret has carol as a collaborator; bob/own is
// bob's personal project.
function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  const id = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender);
  const db = () => h.db as any;
  call(admin, mod.claimAdmin);
  const who = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'eve', 'scout', 'acmebot', 'cbot', 'ebot', 'stranger'].map(n => [n, as(n)]));
  call(admin, mod.setOwnerLogin, { login: 'alice' });
  ['alice', 'bob', 'carol', 'dave', 'eve'].forEach((n, i) =>
    call(admin, mod.githubLinkBuilder, { githubId: BigInt(i + 1), login: n, identity: hex(who[n]), token: `tok-${n}` })
  );
  const agent = (owner: string, name: string, parent = owner) =>
    call(who[owner], mod.createAgent, { name, parent, identity: hex(who[name]), token: 't', description: '' });
  call(who.bob, mod.createOrg, { name: 'acme', description: '' });
  call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'dave', role: 'member' });
  agent('bob', 'scout');
  agent('bob', 'acmebot', 'acme');
  agent('carol', 'cbot');
  agent('eve', 'ebot');
  call(who.bob, mod.createProject, { space: 'acme', name: 'secret', description: '' });
  call(who.bob, mod.createProject, { space: 'bob', name: 'own', description: '' });
  call(who.bob, mod.addProjectMember, { project: 'acme/secret', agent: 'carol' });
  const pid = (fullName: string) => h.db.project.fullName.find(fullName)!.id;
  const reads = (n: string | TestAuth, project: string) => canRead(db(), id(typeof n === 'string' ? who[n] : n), pid(project));
  const readers = (project: string) => Object.keys(who).filter(n => reads(n, project)).sort();
  const visibility = (project: string, v: string, by = 'bob') => call(who[by], mod.setProjectVisibility, { project, visibility: v });

  // The table, against what it should be, worked out here from canRead over
  // every builder and agent (not from the module's own candidate list).
  const inSync = () => {
    const want = new Set<string>([`${HUB_ROW} ${PUBLIC_READER.toHexString()}`]); // the hub row
    const identities = [...h.db.user.iter()].map(u => u.identity).concat([...h.db.agent.iter()].map(a => a.identity));
    for (const p of h.db.project.iter()) {
      if (!isPrivate(db(), p.id)) want.add(`${p.id} ${PUBLIC_READER.toHexString()}`);
      else for (const i of identities) if (canRead(db(), i, p.id)) want.add(`${p.id} ${i.toHexString()}`);
    }
    const have = [...h.db.projectAccess.iter()].map(r => `${r.projectId} ${r.identity.toHexString()}`);
    expect(have.length).toBe(new Set(have).size); // no duplicates
    expect(new Set(have)).toEqual(want);
    const report = checkAccessTable(db(), false);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  };
  return { h, call, hex, id, who, db, pid, reads, readers, visibility, inSync, agent };
}

const ALL = ['acmebot', 'alice', 'bob', 'carol', 'cbot', 'dave', 'eve', 'ebot', 'scout', 'stranger'].sort();
const SECRET_READERS = ['acmebot', 'bob', 'carol', 'cbot', 'dave', 'scout'].sort();

describe('canRead', () => {
  it('a public project: anyone; on a members-only hub, members only', () => {
    const { call, who, reads, readers } = hub();
    expect(readers('acme/secret')).toEqual(ALL);
    expect(reads(admin, 'acme/secret')).toBe(true);
    call(who.alice, mod.setMembersOnly, { on: true });
    expect(readers('acme/secret')).toEqual(ALL.filter(n => n !== 'stranger'));
    expect(reads(admin, 'acme/secret')).toBe(true);
  });

  it('a private project: owners and members of its space, collaborators, and their agents', () => {
    const { call, who, reads, readers, visibility } = hub();
    visibility('acme/secret', 'private');
    // bob owns acme, dave is in it, carol collaborates; scout and acmebot are
    // owned by bob, cbot by carol. eve, her agent and strangers are not let in.
    expect(readers('acme/secret')).toEqual(SECRET_READERS);
    expect(reads(admin, 'acme/secret')).toBe(true);
    visibility('bob/own', 'private');
    // acmebot is acme's agent: it reads acme's projects, never bob's own.
    expect(readers('bob/own')).toEqual(['bob', 'scout']);
    // Members-only changes nothing for a private project: its readers are all members.
    call(who.alice, mod.setMembersOnly, { on: true });
    expect(readers('acme/secret')).toEqual(SECRET_READERS);
    expect(readers('bob/own')).toEqual(['bob', 'scout']);
  });

  it("an org's agent reads the org's projects and where it collaborates, never an owner's own", () => {
    const { call, who, hex, reads, readers, inSync } = hub();
    // team: owners alice and bob, with the shared agent team-bot.
    const teamBot = as('team-bot');
    call(who.alice, mod.createOrg, { name: 'team', description: '' });
    call(who.alice, mod.addSpaceMember, { space: 'team', member: 'bob', role: 'owner' });
    call(who.alice, mod.createAgent, { name: 'team-bot', parent: 'team', identity: hex(teamBot), token: 't', description: '' });
    const priv = (owner: TestAuth, space: string, name: string) => {
      call(owner, mod.createProject, { space, name, description: '' });
      call(owner, mod.setProjectVisibility, { project: `${space}/${name}`, visibility: 'private' });
    };
    priv(who.alice, 'alice', 'diary'); // alice's personal private project
    priv(who.alice, 'team', 'plan'); // team's private project
    // Another org's private project, with team-bot as a collaborator (only its owners may add it).
    call(who.alice, mod.createOrg, { name: 'side', description: '' });
    priv(who.alice, 'side', 'shared');
    priv(who.alice, 'side', 'other');
    call(who.alice, mod.addProjectMember, { project: 'side/shared', agent: 'team-bot' });
    expect(reads(teamBot, 'alice/diary')).toBe(false); // bob cannot reach alice's work through it
    expect(reads(teamBot, 'team/plan')).toBe(true);
    expect(reads(teamBot, 'side/shared')).toBe(true);
    expect(reads(teamBot, 'side/other')).toBe(false); // alice owns side, but that is alice's access, not the agent's
    call(who.bob, mod.setProjectVisibility, { project: 'acme/secret', visibility: 'private' });
    expect(reads(teamBot, 'acme/secret')).toBe(false); // not its org, though bob owns acme
    expect(readers('alice/diary')).toEqual(['alice']);
    inSync();
    // Connected to another org, it reads that org's projects as a member does; disconnected, no more.
    call(who.alice, mod.createOrg, { name: 'labs', description: '' });
    priv(who.alice, 'labs', 'x');
    call(who.alice, mod.connectAgent, { agent: 'team-bot', space: 'labs' });
    expect(reads(teamBot, 'labs/x')).toBe(true);
    inSync();
    call(who.alice, mod.disconnectAgent, { agent: 'team-bot', space: 'labs' });
    expect(reads(teamBot, 'labs/x')).toBe(false);
    inSync();
    // Changing the org's owners changes nothing it reads; with every owner suspended it reads nothing.
    call(who.alice, mod.removeSpaceMember, { space: 'team', member: 'bob' });
    expect(reads(teamBot, 'team/plan')).toBe(true);
    inSync();
    call(who.alice, mod.removeProjectMember, { project: 'side/shared', agent: 'team-bot' });
    expect(reads(teamBot, 'side/shared')).toBe(false);
    inSync();
  });

  it("a builder's own agent reads what the builder reads, until the builder is suspended", () => {
    const { call, who, reads, inSync } = hub();
    call(who.bob, mod.setProjectVisibility, { project: 'bob/own', visibility: 'private' });
    call(who.alice, mod.createOrg, { name: 'labs', description: '' });
    call(who.alice, mod.createProject, { space: 'labs', name: 'x', description: '' });
    call(who.alice, mod.setProjectVisibility, { project: 'labs/x', visibility: 'private' });
    expect(reads('scout', 'labs/x')).toBe(false);
    call(who.alice, mod.addSpaceMember, { space: 'labs', member: 'bob', role: 'member' }); // bob joins an org
    expect(reads('scout', 'labs/x')).toBe(true);
    expect(reads('scout', 'bob/own')).toBe(true);
    inSync();
    call(who.alice, mod.suspendBuilder, { username: 'bob' });
    expect(reads('scout', 'labs/x')).toBe(false);
    expect(reads('scout', 'bob/own')).toBe(false);
    inSync();
  });

  it('follows membership of the project\'s own space, and agents through their owners', () => {
    const { call, who, readers, visibility } = hub();
    visibility('acme/secret', 'private');
    call(who.alice, mod.createOrg, { name: 'labs', description: '' });
    call(who.alice, mod.createProject, { space: 'labs', name: 'x', description: '' });
    call(who.alice, mod.setProjectVisibility, { project: 'labs/x', visibility: 'private' });
    expect(readers('labs/x')).toEqual(['alice']);
    call(who.alice, mod.addSpaceMember, { space: 'labs', member: 'eve', role: 'member' });
    expect(readers('labs/x')).toEqual(['alice', 'ebot', 'eve']);
    call(who.eve, mod.addSpaceMember, { space: 'eve', member: 'carol', role: 'member' });
    expect(readers('labs/x')).toEqual(['alice', 'ebot', 'eve']); // carol is in eve's space, not in labs
  });

  it('a suspended builder reads what someone signed out reads; its agents lose its access', () => {
    const { call, who, reads, readers, visibility } = hub();
    visibility('acme/secret', 'private');
    call(who.alice, mod.suspendBuilder, { username: 'carol' });
    expect(readers('acme/secret')).toEqual(SECRET_READERS.filter(n => n !== 'carol' && n !== 'cbot'));
    expect(reads('carol', 'bob/own')).toBe(true); // public, open hub: like anyone
    call(who.alice, mod.setMembersOnly, { on: true });
    expect(reads('carol', 'bob/own')).toBe(false);
    expect(reads('cbot', 'bob/own')).toBe(false);
    // bob is acme's only owner: with bob suspended, acmebot and scout go with him; dave stays.
    call(who.alice, mod.suspendBuilder, { username: 'bob' });
    expect(readers('acme/secret')).toEqual(['dave']);
    call(who.alice, mod.restoreBuilder, { username: 'bob' });
    call(who.alice, mod.restoreBuilder, { username: 'carol' });
    expect(readers('acme/secret')).toEqual(SECRET_READERS);
  });

  it('a project that is gone is read by no one', () => {
    const { h, call, who, db, pid } = hub();
    const id = pid('bob/own');
    call(who.bob, mod.deleteProject, { project: 'bob/own' });
    expect(canRead(db(), h.withReducerTx(who.bob, ctx => ctx.sender), id)).toBe(false);
  });
});

describe('setProjectVisibility', () => {
  it('is for owners of the space, logs the change, and public removes the row', () => {
    const { h, call, who, pid, visibility } = hub();
    expect(() => visibility('acme/secret', 'private', 'dave')).toThrow(/only owners of "acme"/);
    expect(() => visibility('acme/secret', 'private', 'carol')).toThrow(/only owners of "acme"/);
    expect(() => visibility('acme/secret', 'hidden')).toThrow(/"public" or "private"/);
    expect(() => call(who.stranger, mod.setProjectVisibility, { project: 'acme/secret', visibility: 'private' })).toThrow(/permission denied/);
    visibility('acme/secret', 'private');
    visibility('acme/secret', 'private'); // again: nothing changes
    const logged = () => [...h.db.activity.iter()].filter(e => e.kind === 'visibility_changed').map(e => e.subject);
    expect(logged()).toEqual(['private']);
    visibility('acme/secret', 'public');
    expect(h.db.projectVisibility.projectId.find(pid('acme/secret'))).toBeNull();
    expect(logged()).toEqual(['private', 'public']);
  });
});

describe('default visibility for new projects', () => {
  const state = (h: any) => h.db.hubState.key.find('defaultVisibility')?.value ?? null;

  it('is set by the owner (or the admin) only; public removes the setting; setting it twice changes nothing', () => {
    const { h, call, who } = hub();
    expect(state(h)).toBeNull();
    for (const n of ['bob', 'dave', 'stranger', 'scout']) {
      expect(() => call(who[n], mod.setDefaultVisibility, { visibility: 'private' })).toThrow(/permission denied/);
    }
    expect(() => call(who.alice, mod.setDefaultVisibility, { visibility: 'hidden' })).toThrow(/"public" or "private"/);
    expect(state(h)).toBeNull();
    call(who.alice, mod.setDefaultVisibility, { visibility: 'private' });
    call(who.alice, mod.setDefaultVisibility, { visibility: 'private' });
    expect(state(h)).toBe('private');
    expect([...h.db.hubState.iter()].filter((r: any) => r.key === 'defaultVisibility').length).toBe(1);
    call(who.alice, mod.setDefaultVisibility, { visibility: 'public' });
    call(who.alice, mod.setDefaultVisibility, { visibility: 'public' });
    expect(state(h)).toBeNull();
    // The admin (by CLI) may too, as with every owner action.
    call(admin, mod.setDefaultVisibility, { visibility: 'private' });
    expect(state(h)).toBe('private');
  });

  it('unset: a new project is public, as before', () => {
    const { h, call, who, pid, readers, inSync } = hub();
    call(who.bob, mod.createProject, { space: 'acme', name: 'fresh', description: '' });
    expect(h.db.projectVisibility.projectId.find(pid('acme/fresh'))).toBeNull();
    expect(readers('acme/fresh')).toEqual(ALL);
    inSync();
  });

  it('private: every way a builder makes a project starts it private, readable only by those the rule lets in', () => {
    const { h, call, who, pid, reads, readers, inSync } = hub();
    call(who.alice, mod.setDefaultVisibility, { visibility: 'private' });
    // A plain create, a template (the goal space), a chat started in an org, and a repo room.
    call(who.bob, mod.createProject, { space: 'acme', name: 'fresh', description: '' });
    call(who.bob, mod.createProjectFromTemplate, { space: 'acme', name: 'launch', description: '', template: '', goal: 'Ship it.' });
    call(who.bob, mod.startChat, { space: 'acme', project: '' });
    for (const p of ['acme/fresh', 'acme/launch', 'acme/chat']) {
      expect(h.db.projectVisibility.projectId.find(pid(p))?.visibility).toBe('private');
      expect(readers(p)).toEqual(['acmebot', 'bob', 'dave', 'scout']);
      expect(reads('eve', p)).toBe(false);
      expect(reads('stranger', p)).toBe(false);
      expect([...h.db.projectAccess.projectId.filter(pid(p))].some((r: any) => r.identity.isEqual(PUBLIC_READER))).toBe(false);
    }
    // Projects made before the setting keep theirs.
    expect(readers('bob/own')).toEqual(ALL);
    inSync();
  });

  it('a repo room always starts public, readable by its opener, whatever the default', () => {
    const { h, call, who, pid, reads, readers, inSync } = hub();
    call(who.alice, mod.setDefaultVisibility, { visibility: 'private' });
    call(who.alice, mod.createOrg, { name: 'explain', description: '' });
    call(admin, mod.openRepoRoom, { owner: 'octo', repo: 'hello', description: '', openedBy: 'eve' });
    const room = [...h.db.project.owner.filter('explain')][0].fullName;
    expect(h.db.projectVisibility.projectId.find(pid(room))).toBeNull();
    expect(reads('eve', room)).toBe(true); // eve is not in "explain", yet reads the room she opened
    expect(readers(room)).toEqual(ALL);
    inSync();
  });

  it("the creator's explicit choice wins over the default, both ways", () => {
    const { h, call, who, pid, readers, inSync } = hub();
    call(who.bob, mod.createProjectWithVisibility, { space: 'acme', name: 'hidden', description: '', visibility: 'private' });
    call(who.bob, mod.createProjectFromTemplateWithVisibility, { space: 'bob', name: 'plan', description: '', template: '', goal: 'Plan.', visibility: 'private' });
    expect(readers('acme/hidden')).toEqual(['acmebot', 'bob', 'dave', 'scout']);
    expect(readers('bob/plan')).toEqual(['bob', 'scout']);
    call(who.alice, mod.setDefaultVisibility, { visibility: 'private' });
    call(who.bob, mod.createProjectWithVisibility, { space: 'acme', name: 'open', description: '', visibility: 'public' });
    call(who.bob, mod.createProjectFromTemplateWithVisibility, { space: 'acme', name: 'open-plan', description: '', template: '', goal: 'Plan.', visibility: 'public' });
    call(who.bob, mod.createProjectWithVisibility, { space: 'acme', name: 'default', description: '', visibility: '' });
    expect(readers('acme/open')).toEqual(ALL);
    expect(readers('acme/open-plan')).toEqual(ALL);
    expect(h.db.projectVisibility.projectId.find(pid('acme/default'))?.visibility).toBe('private');
    expect(() => call(who.bob, mod.createProjectWithVisibility, { space: 'acme', name: 'odd', description: '', visibility: 'secret' })).toThrow(/"public" or "private"/);
    expect(h.db.project.fullName.find('acme/odd')).toBeNull();
    inSync();
  });
});

describe('project_access', () => {
  it('starts as one row a project (and the hub row), for everyone: no visibility rows is the hub as before', () => {
    const { h, inSync } = hub();
    expect([...h.db.projectVisibility.iter()]).toEqual([]);
    const rows = [...h.db.projectAccess.iter()];
    expect(rows.length).toBe([...h.db.project.iter()].length + 1);
    expect(rows.filter(r => r.projectId === HUB_ROW).length).toBe(1);
    expect(rows.every(r => r.identity.isEqual(PUBLIC_READER))).toBe(true);
    inSync();
  });

  it('follows visibility, collaborators and projects', () => {
    const { call, who, visibility, inSync } = hub();
    visibility('acme/secret', 'private');
    inSync();
    visibility('bob/own', 'private');
    inSync();
    call(who.bob, mod.removeProjectMember, { project: 'acme/secret', agent: 'carol' });
    inSync();
    call(who.bob, mod.addProjectMember, { project: 'bob/own', agent: 'eve' });
    inSync();
    call(who.eve, mod.removeProjectMember, { project: 'bob/own', agent: 'eve' }); // a collaborator leaves
    inSync();
    call(who.dave, mod.createProject, { space: 'acme', name: 'more', description: '' });
    inSync();
    call(who.bob, mod.deleteProject, { project: 'acme/secret' });
    inSync();
    visibility('bob/own', 'public');
    inSync();
  });

  it('follows space roles: members, owners, role changes, leaving', () => {
    const { call, who, visibility, inSync, readers } = hub();
    visibility('acme/secret', 'private');
    call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'eve', role: 'member' });
    inSync();
    call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'eve', role: 'owner' });
    inSync();
    // eve owns acme now, but acme's agent still does not read eve's own projects.
    call(who.eve, mod.createProject, { space: 'eve', name: 'diary', description: '' });
    call(who.eve, mod.setProjectVisibility, { project: 'eve/diary', visibility: 'private' });
    expect(readers('eve/diary')).toEqual(['ebot', 'eve']);
    inSync();
    call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'eve', role: 'member' }); // owner -> member
    expect(readers('eve/diary')).toEqual(['ebot', 'eve']);
    inSync();
    call(who.eve, mod.removeSpaceMember, { space: 'acme', member: 'eve' });
    inSync();
    call(who.bob, mod.removeSpaceMember, { space: 'acme', member: 'dave' });
    inSync();
    call(who.eve, mod.addSpaceMember, { space: 'eve', member: 'dave', role: 'member' }); // a personal space's member
    expect(readers('eve/diary')).toEqual(['dave', 'ebot', 'eve']);
    inSync();
  });

  it('follows agents: made, connected, disconnected, deleted', () => {
    const { call, who, hex, visibility, inSync, readers, reads } = hub();
    visibility('acme/secret', 'private');
    // A new agent of a collaborator reads what its owner reads, at once.
    const late = as('late');
    call(who.carol, mod.createAgent, { name: 'late', parent: 'carol', identity: hex(late), token: 't', description: '' });
    expect(reads(late, 'acme/secret')).toBe(true);
    inSync();
    call(who.eve, mod.createProject, { space: 'eve', name: 'diary', description: '' });
    visibility('eve/diary', 'private', 'eve');
    call(who.eve, mod.addSpaceMember, { space: 'eve', member: 'bob', role: 'member' });
    // bob's own agent reads it through bob; acme's agent does not.
    expect(readers('eve/diary')).toEqual(['bob', 'ebot', 'eve', 'scout']);
    call(who.bob, mod.createOrg, { name: 'beta', description: '' });
    call(who.bob, mod.createProject, { space: 'beta', name: 'b', description: '' });
    visibility('beta/b', 'private');
    call(who.bob, mod.connectAgent, { agent: 'acmebot', space: 'beta' });
    inSync();
    call(who.bob, mod.disconnectAgent, { agent: 'acmebot', space: 'beta' });
    inSync();
    call(who.eve, mod.deleteAgent, { name: 'ebot' });
    expect(readers('eve/diary')).toEqual(['bob', 'eve', 'scout']);
    inSync();
  });

  it('follows builders: suspended, restored, deleted, renamed and merged', () => {
    const { h, call, who, hex, visibility, inSync } = hub();
    visibility('acme/secret', 'private');
    visibility('bob/own', 'private');
    call(who.alice, mod.suspendBuilder, { username: 'bob' });
    inSync();
    call(who.alice, mod.restoreBuilder, { username: 'bob' });
    inSync();
    call(who.dave, mod.deleteBuilder); // drops its place in acme itself
    inSync();
    call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'carol', role: 'owner' });
    call(who.carol, mod.deleteAgent, { name: 'cbot' });
    call(who.bob, mod.removeSpaceMember, { space: 'acme', member: 'carol' });
    call(who.carol, mod.removeProjectMember, { project: 'acme/secret', agent: 'carol' });
    call(who.carol, mod.deleteBuilder); // carol, once an owner of acme (acmebot's owners changed)
    inSync();
    // A builder xo made is renamed to its GitHub login, then another is merged into a GitHub builder.
    const old = as('old-xo');
    call(admin, mod.xoLinkAgent, { subject: 'user_old', username: 'suraj', identity: hex(old), token: 'tok' });
    call(who.bob, mod.addSpaceMember, { space: 'acme', member: 'suraj', role: 'member' });
    call(old, mod.createProject, { space: 'suraj', name: 'notes', description: '' });
    call(old, mod.setProjectVisibility, { project: 'suraj/notes', visibility: 'private' });
    inSync();
    call(admin, mod.xoLinkGithub, { subject: 'user_old', githubId: 77n, login: 'surajgh', xoName: 'Suraj', alias: '', identity: '', token: '' });
    expect(h.db.project.fullName.find('surajgh/notes')).toBeTruthy();
    inSync();
    const other = as('other-xo');
    call(admin, mod.xoLinkAgent, { subject: 'user_other', username: 'carl', identity: hex(other), token: 'tok' });
    call(other, mod.createProject, { space: 'carl', name: 'p', description: '' });
    call(other, mod.setProjectVisibility, { project: 'carl/p', visibility: 'private' });
    call(admin, mod.xoLinkGithub, { subject: 'user_other', githubId: 1n, login: 'alice', xoName: 'Alice', alias: '', identity: '', token: '' });
    expect(h.db.project.fullName.find('alice/p')).toBeTruthy();
    expect(h.db.user.username.find('carl')).toBeNull();
    inSync();
  });

  it('is not touched by members-only, and new builders get no rows', () => {
    const { h, call, who, hex, visibility, inSync } = hub();
    visibility('acme/secret', 'private');
    const before = [...h.db.projectAccess.iter()].length;
    call(who.alice, mod.setMembersOnly, { on: true });
    call(who.alice, mod.setMembersOnly, { on: false });
    expect([...h.db.projectAccess.iter()].length).toBe(before);
    call(admin, mod.githubLinkBuilder, { githubId: 50n, login: 'zed', identity: hex(as('zed')), token: 't' });
    expect([...h.db.projectAccess.iter()].length).toBe(before);
    inSync();
  });
});

describe('the access check', () => {
  it('reports drift without writing, and rebuildAccess repairs it (owner or admin only)', () => {
    const { h, call, who, db, pid, visibility, inSync } = hub();
    visibility('acme/secret', 'private');
    // Break the table by hand: drop a reader, add a stray row.
    const secret = pid('acme/secret');
    h.withReducerTx(admin, ctx => {
      const row = [...ctx.db.projectAccess.projectId.filter(secret)][0];
      ctx.db.projectAccess.id.delete(row.id);
      ctx.db.projectAccess.insert({ id: 0n, identity: ctx.sender, projectId: secret });
      ctx.db.projectAccess.insert({ id: 0n, identity: ctx.sender, projectId: 999n });
    });
    const report = checkAccessTable(db(), false);
    expect(report.missing.length).toBe(1);
    expect(report.extra.length).toBe(2);
    expect(checkAccessTable(db(), false).extra.length).toBe(2); // nothing was written
    expect(() => call(who.bob, mod.rebuildAccess)).toThrow(/only the hub's owner or admin/);
    expect(() => call(who.stranger, mod.rebuildAccess)).toThrow(/only the hub's owner or admin/);
    call(who.alice, mod.rebuildAccess);
    inSync();
    call(admin, mod.rebuildAccess); // again: nothing to do
    inSync();
  });

  it('fills the table on a hub from before it', () => {
    const { h, call, inSync } = hub();
    h.withReducerTx(admin, ctx => {
      for (const row of [...ctx.db.projectAccess.iter()]) ctx.db.projectAccess.id.delete(row.id);
    });
    expect([...h.db.projectAccess.iter()]).toEqual([]);
    call(admin, mod.rebuildAccess);
    inSync();
  });
});
