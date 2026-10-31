// Signing in with xo as the GitHub account connected to XO (xoLinkGithub),
// and second names: a builder's xo username, or the name xo gave it before,
// shows the same space and works wherever a name does (npm test).
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { renderUi } from '../src/ui';
import { renderApi } from '../src/workspace';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const admin = as('admin');
const SUBJECT = 'user_2suraj';
const GH = 1001n;

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  call(admin, mod.claimAdmin);
  return { h, call, hex };
}

const link = (over: object = {}) => ({ subject: SUBJECT, githubId: GH, login: 'SharmaSuraj0123', xoName: 'Suraj', alias: 'suraj', identity: '', token: '', ...over });
const page = (db: any, path: string) => renderUi(db, { uri: '/', forwardedUri: path, cookie: null, proto: 'https', now: 1_800_000_000 });
const view = (db: any, space: string, project = '') =>
  JSON.parse(renderApi(db, { query: new Map([['space', space], ['project', project]]), viewer: null, now: 1_800_000_000 }).body);

describe('xoLinkGithub', () => {
  it('makes the GitHub account its builder, the xo username its display name and second name', () => {
    const { h, call, hex } = hub();
    const me = as('suraj-identity');
    call(admin, mod.xoLinkGithub, link({ identity: hex(me), token: 'tok' }));
    expect(h.db.user.username.find('sharmasuraj0123')?.identity.toHexString()).toBe(hex(me));
    expect(h.db.githubAccount.githubId.find(GH)?.token).toBe('tok');
    expect(h.db.xoLink.subject.find(SUBJECT)).toMatchObject({ githubId: GH, username: 'sharmasuraj0123', xoName: 'Suraj' });
    expect(h.db.space.name.find('sharmasuraj0123')?.displayName).toBe('Suraj');
    expect(h.db.spaceAlias.name.find('suraj')?.space).toBe('sharmasuraj0123');
    // Again: nothing new is needed, and nothing changes.
    call(admin, mod.xoLinkGithub, link());
    expect([...h.db.user.iter()].length).toBe(1);
  });

  it('signs in as the builder GitHub sign-in made, without a new identity', () => {
    const { h, call } = hub();
    call(admin, mod.githubLinkBuilder, { githubId: GH, login: 'sharmasuraj0123', identity: 'ab'.repeat(32), token: 'gh-tok' });
    call(admin, mod.xoLinkGithub, link());
    expect(h.db.xoLink.subject.find(SUBJECT)?.username).toBe('sharmasuraj0123');
    expect(h.db.githubAccount.githubId.find(GH)?.token).toBe('gh-tok');
  });

  it('needs an identity for a new builder, the admin and a GitHub account', () => {
    const { call } = hub();
    expect(() => call(admin, mod.xoLinkGithub, link())).toThrow(/needs an identity/);
    expect(() => call(as('stranger'), mod.xoLinkGithub, link({ identity: 'ab'.repeat(32), token: 't' }))).toThrow(/only the hub admin/);
    expect(() => call(admin, mod.xoLinkGithub, link({ githubId: 0n, identity: 'ab'.repeat(32), token: 't' }))).toThrow(/invalid GitHub account id/);
    expect(() => call(admin, mod.xoLinkGithub, link({ login: 'bad login', identity: 'ab'.repeat(32), token: 't' }))).toThrow(/invalid GitHub login/);
  });

  it('gives no second name that is taken, reserved or invalid; the display name stays', () => {
    const { h, call } = hub();
    call(as('alice'), mod.registerUser, { username: 'suraj' });
    call(admin, mod.xoLinkGithub, link({ identity: 'ab'.repeat(32), token: 't' }));
    expect(h.db.spaceAlias.name.find('suraj')).toBeNull();
    expect(h.db.space.name.find('sharmasuraj0123')?.displayName).toBe('Suraj');
    call(admin, mod.xoLinkGithub, link({ alias: 'v1' }));
    call(admin, mod.xoLinkGithub, link({ alias: 'Not A Name' }));
    expect([...h.db.spaceAlias.iter()]).toEqual([]);
  });

  it('renames the builder xo made before GitHub was needed, keeping its token and work', () => {
    const { h, call, hex } = hub();
    const old = as('old-xo-identity');
    call(admin, mod.xoLinkAgent, { subject: SUBJECT, username: 'suraj', identity: hex(old), token: 'old-tok' });
    call(old, mod.createProject, { space: 'suraj', name: 'notes', description: '' });
    call(old, mod.createOrg, { name: 'acme', description: '' });
    call(admin, mod.xoLinkGithub, link({ alias: 'suraj' }));
    expect(h.db.xoAgent.subject.find(SUBJECT)).toBeNull();
    expect(h.db.user.username.find('suraj')).toBeNull();
    expect(h.db.user.username.find('sharmasuraj0123')?.identity.toHexString()).toBe(hex(old));
    expect(h.db.githubAccount.githubId.find(GH)?.token).toBe('old-tok');
    expect(h.db.project.fullName.find('sharmasuraj0123/notes')?.owner).toBe('sharmasuraj0123');
    expect(h.db.spaceRole.key.find('acme:sharmasuraj0123')?.role).toBe('owner');
    expect(h.db.space.name.find('suraj')).toBeNull();
    expect(h.db.spaceAlias.name.find('suraj')?.space).toBe('sharmasuraj0123');
    // The same identity pushes on, now under its GitHub name.
    call(old, mod.createProject, { space: 'suraj', name: 'more', description: '' });
    expect(h.db.project.fullName.find('sharmasuraj0123/more')).toBeTruthy();
  });

  it('merges that builder into the one GitHub sign-in made, renaming clashing projects', () => {
    const { h, call, hex } = hub();
    const old = as('old-xo-identity');
    const gh = as('github-identity');
    call(admin, mod.githubLinkBuilder, { githubId: GH, login: 'sharmasuraj0123', identity: hex(gh), token: 'gh-tok' });
    call(gh, mod.createProject, { space: 'sharmasuraj0123', name: 'notes', description: 'mine' });
    call(admin, mod.xoLinkAgent, { subject: SUBJECT, username: 'suraj', identity: hex(old), token: 'old-tok' });
    call(old, mod.createProject, { space: 'suraj', name: 'notes', description: 'from xo' });
    call(old, mod.createProject, { space: 'suraj', name: 'plans', description: '' });
    call(gh, mod.createOrg, { name: 'acme', description: '' });
    call(gh, mod.addSpaceMember, { space: 'acme', member: 'suraj', role: 'member' });
    call(old, mod.createOrg, { name: 'beta', description: '' });
    call(admin, mod.xoLinkGithub, link({ alias: 'suraj' }));
    expect(h.db.user.username.find('suraj')).toBeNull();
    expect(h.db.githubAccount.githubId.find(GH)?.token).toBe('gh-tok');
    expect(h.db.project.fullName.find('sharmasuraj0123/notes')?.description).toBe('mine');
    expect(h.db.project.fullName.find('sharmasuraj0123/notes-suraj')?.description).toBe('from xo');
    expect(h.db.project.fullName.find('sharmasuraj0123/plans')).toBeTruthy();
    expect(h.db.spaceRole.key.find('acme:sharmasuraj0123')?.role).toBe('owner');
    expect(h.db.spaceRole.key.find('acme:suraj')).toBeNull();
    expect(h.db.spaceRole.key.find('beta:sharmasuraj0123')?.role).toBe('owner');
    expect(h.db.spaceAlias.name.find('suraj')?.space).toBe('sharmasuraj0123');
    // Activity follows the projects to their new names.
    const paths = [...h.db.activity.iter()].filter(e => e.kind === 'project_created').map(e => e.path).sort();
    expect(paths).toEqual(['sharmasuraj0123/notes', 'sharmasuraj0123/notes-suraj', 'sharmasuraj0123/plans']);
  });

  it('one xo user per GitHub account: whoever connected it last', () => {
    const { h, call } = hub();
    call(admin, mod.xoLinkGithub, link({ identity: 'ab'.repeat(32), token: 't' }));
    call(admin, mod.xoLinkGithub, link({ subject: 'user_other', xoName: 'Other', alias: '' }));
    expect(h.db.xoLink.subject.find(SUBJECT)).toBeNull();
    expect(h.db.xoLink.subject.find('user_other')?.username).toBe('sharmasuraj0123');
  });
});

describe('second names', () => {
  function linked() {
    const t = hub();
    const me = as('suraj-identity');
    t.call(admin, mod.xoLinkGithub, link({ identity: t.hex(me), token: 'tok' }));
    t.call(me, mod.createProject, { space: 'suraj', name: 'notes', description: 'my notes' });
    return { ...t, me };
  }

  it('work wherever a name does, and nobody else can take one', () => {
    const { h, call, me } = linked();
    expect(h.db.project.fullName.find('sharmasuraj0123/notes')).toBeTruthy();
    call(me, mod.editProject, { project: 'suraj/notes', description: 'edited', defaultBranch: undefined });
    expect(h.db.project.fullName.find('sharmasuraj0123/notes')?.description).toBe('edited');
    call(me, mod.editSpace, { space: 'suraj', description: 'hello' });
    expect(h.db.space.name.find('sharmasuraj0123')?.description).toBe('hello');
    call(me, mod.createOrg, { name: 'acme', description: '' });
    call(as('bob'), mod.registerUser, { username: 'bob' });
    call(me, mod.addSpaceMember, { space: 'acme', member: 'bob', role: 'member' });
    call(as('bob'), mod.createOrg, { name: 'bobs', description: '' });
    call(as('bob'), mod.addSpaceMember, { space: 'bobs', member: 'suraj', role: 'member' });
    expect(h.db.spaceRole.key.find('bobs:sharmasuraj0123')).toBeTruthy();
    expect(() => call(as('carol'), mod.registerUser, { username: 'suraj' })).toThrow(/is taken/);
    expect(() => call(me, mod.createOrg, { name: 'suraj', description: '' })).toThrow(/is taken/);
  });

  it('show the same pages and views as the builder name', () => {
    const { h } = linked();
    const own = page(h.db, '/sharmasuraj0123');
    const second = page(h.db, '/suraj');
    expect(second.status).toBe(200);
    expect(second.body).toBe(own.body);
    expect(own.body).toContain('also /suraj');
    expect(page(h.db, '/suraj/notes').status).toBe(200);
    expect(page(h.db, '/suraj/notes').body).toBe(page(h.db, '/sharmasuraj0123/notes').body);
    expect(view(h.db, 'suraj').meta).toMatchObject({ level: 'space', name: 'sharmasuraj0123', displayName: 'Suraj', aliases: ['suraj'] });
    expect(view(h.db, 'suraj', 'notes').meta).toMatchObject({ level: 'project', space: 'sharmasuraj0123', fullName: 'sharmasuraj0123/notes' });
  });

  it('go with the builder when it leaves', () => {
    const { h, call, hex } = hub();
    const me = as('leaving-identity');
    call(admin, mod.xoLinkGithub, link({ identity: hex(me), token: 'tok' }));
    call(me, mod.deleteBuilder);
    expect(h.db.spaceAlias.name.find('suraj')).toBeNull();
    expect(h.db.xoLink.subject.find(SUBJECT)).toBeNull();
    call(as('carol'), mod.registerUser, { username: 'suraj' });
  });
});
