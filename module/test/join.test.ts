// Who may join a hub: the join policy, the allowlist and invite codes, checked
// at the one place every new builder is made (addBuilder), on every sign-up
// path (npm test).
import { describe, expect, it } from 'vitest';
import { ConnectionId, TimeDuration } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const admin = as('admin');
const OWNER_ID = 4242n;
const CODE = 'invite-code-0123456789abcdef';
let nextId = 100n;

// A hub owned by alice (GitHub id 4242), with `policy` set by her when given.
function hub(policy?: string) {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  call(admin, mod.claimAdmin);
  call(admin, mod.setOwnerLogin, { login: 'alice' });
  const alice = as('alice');
  call(admin, mod.githubLinkBuilder, { githubId: OWNER_ID, login: 'alice', identity: hex(alice), token: 'tok-alice' });
  if (policy) call(alice, mod.setJoinPolicy, { policy });
  const builders = () => [...h.db.user.iter()].map(u => u.username).sort();
  // The sign-up paths, each making the builder `login` (or `name`).
  const paths = {
    open: (name: string, invite = '') =>
      invite ? call(as(`open-${name}`), mod.registerWithInvite, { username: name, invite }) : call(as(`open-${name}`), mod.registerUser, { username: name }),
    github: (login: string, invite = '') => {
      const args = { githubId: nextId++, login, identity: hex(as(`gh-${login}`)), token: `tok-${login}` };
      return invite ? call(admin, mod.githubLinkBuilderWithInvite, { ...args, invite }) : call(admin, mod.githubLinkBuilder, args);
    },
    xo: (login: string) =>
      call(admin, mod.xoLinkGithub, { subject: `user_${login.replace(/-/g, '_')}`, githubId: nextId++, login, xoName: '', alias: '', identity: hex(as(`xo-${login}`)), token: 't' }),
    xoAgent: (name: string) =>
      call(admin, mod.xoLinkAgent, { subject: `user_agent_${name.replace(/-/g, '_')}`, username: name, identity: hex(as(`xa-${name}`)), token: 't' }),
  };
  return { h, call, alice, builders, paths };
}

describe('join policy "anyone" (and none set)', () => {
  it('a hub with no policy lets everyone in on every path, as before', () => {
    const { h, paths, builders } = hub();
    expect(h.db.hubState.key.find('join')).toBeNull();
    paths.open('olive');
    paths.github('gina');
    paths.xo('xena');
    paths.xoAgent('xavier');
    expect(builders()).toEqual(['alice', 'gina', 'olive', 'xavier', 'xena']);
  });

  it('"anyone" set explicitly is the same, and the row stays', () => {
    const { h, paths, builders } = hub('anyone');
    paths.open('olive');
    paths.github('gina');
    expect(builders()).toEqual(['alice', 'gina', 'olive']);
    expect(h.db.hubState.key.find('join')?.value).toBe('anyone');
  });
});

describe('join policy "allowlist"', () => {
  it('lets in listed GitHub logins on the GitHub and xo paths, and refuses the rest with a reason', () => {
    const { call, alice, paths, builders } = hub('allowlist');
    call(alice, mod.allowJoin, { login: 'Gina' });
    call(alice, mod.allowJoin, { login: '@xena' });
    paths.github('gina');
    paths.xo('xena');
    expect(() => paths.github('mallory')).toThrow(/not allowed to join this hub: the GitHub account mallory is not on its allowlist/);
    expect(() => paths.xo('mallory')).toThrow(/not on its allowlist/);
    // A name registered on an open hub is not a checked GitHub login, even a listed one.
    call(alice, mod.allowJoin, { login: 'olive' });
    expect(() => paths.open('olive')).toThrow(/not allowed to join this hub: .*invite code/);
    expect(() => paths.xoAgent('xavier')).toThrow(/not allowed to join/);
    expect(builders()).toEqual(['alice', 'gina', 'xena']);
  });

  it('an invite code works there too, on the open path included', () => {
    const { call, alice, paths, builders } = hub('allowlist');
    call(alice, mod.createInvite, { code: CODE, hours: 24 });
    paths.open('olive', CODE);
    expect(builders()).toEqual(['alice', 'olive']);
  });

  it('taking a login off the list stops new sign-ups but keeps builders already here', () => {
    const { h, call, alice, paths, builders } = hub('allowlist');
    call(alice, mod.allowJoin, { login: 'gina' });
    call(alice, mod.allowJoin, { login: 'gus' });
    paths.github('gina');
    call(alice, mod.disallowJoin, { login: 'GINA' });
    call(alice, mod.disallowJoin, { login: 'gus' });
    call(alice, mod.disallowJoin, { login: 'gus' });
    expect([...h.db.joinRule.iter()]).toEqual([]);
    expect(() => paths.github('gus')).toThrow(/not on its allowlist/);
    call(as('gh-gina'), mod.createProject, { space: 'gina', name: 'notes', description: '' });
    expect(builders()).toEqual(['alice', 'gina']);
  });
});

describe('join policy "invite"', () => {
  it('refuses everyone without a code or a listed login, on every path', () => {
    const { paths, builders } = hub('invite');
    expect(() => paths.open('olive')).toThrow(/not allowed to join this hub: it is invite-only/);
    expect(() => paths.github('gina')).toThrow(/invite-only/);
    expect(() => paths.xo('xena')).toThrow(/invite-only/);
    expect(() => paths.xoAgent('xavier')).toThrow(/invite-only/);
    expect(builders()).toEqual(['alice']);
  });

  it('a listed login joins without a code', () => {
    const { call, alice, paths, builders } = hub('invite');
    call(alice, mod.allowJoin, { login: 'gina' });
    paths.github('gina');
    expect(builders()).toEqual(['alice', 'gina']);
  });

  it("the owner's GitHub login always may (a new hub set to invite before its owner arrives)", () => {
    const h = createModuleTestHarness(spacetimedb, mod);
    const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
    call(admin, mod.claimAdmin);
    call(admin, mod.setOwnerLogin, { login: 'Alice' });
    call(admin, mod.setJoinPolicy, { policy: 'invite' });
    const hex = h.withReducerTx(as('alice'), ctx => ctx.sender.toHexString());
    call(admin, mod.githubLinkBuilder, { githubId: OWNER_ID, login: 'alice', identity: hex, token: 't' });
    expect(h.db.hubState.key.find('owner')?.value).toBe('4242');
  });

  it('an invite code works once, on the open and GitHub paths', () => {
    const { h, call, alice, paths, builders } = hub('invite');
    call(alice, mod.createInvite, { code: CODE, hours: 24 });
    paths.github('gina', CODE);
    expect(() => paths.open('olive', CODE)).toThrow(/that invite code was already used/);
    const row = [...h.db.joinInvite.iter()][0];
    expect(row.usedBy).toBe('gina');
    expect(row.codeHash).not.toContain(CODE);
    call(alice, mod.createInvite, { code: `${CODE}-2`, hours: 24 });
    paths.open('olive', `${CODE}-2`);
    expect(() => paths.open('oscar', 'no-such-code-0123456789')).toThrow(/that invite code is not valid here/);
    expect(builders()).toEqual(['alice', 'gina', 'olive']);
  });

  it('a refused sign-up spends no code (the whole sign-up is one transaction)', () => {
    const { h, call, alice, paths } = hub('invite');
    call(alice, mod.createInvite, { code: CODE, hours: 24 });
    expect(() => paths.open('alice', CODE)).toThrow(/is taken/);
    expect([...h.db.joinInvite.iter()][0].usedBy).toBe('');
    paths.open('olive', CODE);
  });

  it('an invite code runs out', () => {
    const { h, call, alice, paths } = hub('invite');
    call(alice, mod.createInvite, { code: CODE, hours: 1 });
    h.clock.advance(TimeDuration.fromMillis(60 * 60 * 1000));
    expect(() => paths.github('gina', CODE)).toThrow(/that invite code has expired/);
  });

  it('a revoked code is refused; a used one cannot be revoked; revoking again changes nothing', () => {
    const { h, call, alice, paths } = hub('invite');
    call(alice, mod.createInvite, { code: CODE, hours: 24 });
    call(alice, mod.createInvite, { code: `${CODE}-2`, hours: 24 });
    const [first, second] = [...h.db.joinInvite.iter()].sort((a, b) => Number(a.id - b.id));
    call(alice, mod.revokeInvite, { id: first.id });
    call(alice, mod.revokeInvite, { id: first.id });
    expect(() => paths.github('gina', CODE)).toThrow(/not valid here/);
    paths.github('gina', `${CODE}-2`);
    expect(() => call(alice, mod.revokeInvite, { id: second.id })).toThrow(/already used by gina/);
  });

  it('changing the policy locks out no builder already here', () => {
    const { call, alice, paths } = hub();
    paths.open('olive');
    call(alice, mod.setJoinPolicy, { policy: 'invite' });
    call(as('open-olive'), mod.createProject, { space: 'olive', name: 'notes', description: '' });
  });
});

describe('who sets the policy, the list and the invites', () => {
  it('the owner (or the admin), nobody else; bad input is refused', () => {
    const { h, call, alice, paths } = hub();
    paths.open('olive');
    const olive = as('open-olive');
    for (const [reducer, args] of [
      [mod.setJoinPolicy, { policy: 'invite' }],
      [mod.allowJoin, { login: 'olive' }],
      [mod.disallowJoin, { login: 'gina' }],
      [mod.createInvite, { code: CODE, hours: 24 }],
      [mod.revokeInvite, { id: 1n }],
    ] as const) {
      expect(() => call(olive, reducer, args)).toThrow(/only the hub's owner/);
    }
    expect(h.db.hubState.key.find('join')).toBeNull();
    expect([...h.db.joinRule.iter()]).toEqual([]);
    expect([...h.db.joinInvite.iter()]).toEqual([]);
    expect(() => call(alice, mod.setJoinPolicy, { policy: 'members' })).toThrow(/"anyone", "allowlist" or "invite"/);
    expect(() => call(alice, mod.allowJoin, { login: 'not a login' })).toThrow(/invalid GitHub login/);
    expect(() => call(alice, mod.createInvite, { code: 'short', hours: 24 })).toThrow(/16 to 128/);
    expect(() => call(alice, mod.createInvite, { code: CODE, hours: 0 })).toThrow(/1 to 720 hours/);
    call(admin, mod.setJoinPolicy, { policy: 'allowlist' });
    call(alice, mod.allowJoin, { login: 'gina' });
    call(alice, mod.allowJoin, { login: 'gina' });
    expect([...h.db.joinRule.iter()].map(r => [r.login, r.addedBy])).toEqual([['gina', 'alice']]);
    call(alice, mod.createInvite, { code: CODE, hours: 24 });
    expect(() => call(alice, mod.createInvite, { code: CODE, hours: 24 })).toThrow(/exists already/);
  });

  it('setting the same policy again changes nothing', () => {
    const { h, call, alice } = hub('invite');
    const before = [...h.db.hubState.iter()];
    call(alice, mod.setJoinPolicy, { policy: 'invite' });
    expect([...h.db.hubState.iter()]).toEqual(before);
  });
});

describe('repo rooms on a hub that chooses who joins', () => {
  function rooms(policy?: string) {
    const t = hub(policy);
    t.call(t.alice, mod.createOrg, { name: 'explain', description: 'Open repo rooms' });
    const open = (openedBy: string, repo = 'hello') => t.call(admin, mod.openRepoRoom, { owner: 'octo', repo, description: '', openedBy });
    return { ...t, open };
  }

  it('anyone (signed out included) opens one while the policy is "anyone"', () => {
    const { h, open } = rooms();
    open('');
    expect(h.db.project.fullName.find('explain/octo.hello')).toBeTruthy();
  });

  it('only a builder opens a new one otherwise; an existing room still opens for all', () => {
    const { h, call, alice, open } = rooms('invite');
    expect(() => open('')).toThrow(/only builders of this hub open new rooms/);
    expect(() => open('stranger')).toThrow(/only builders/);
    open('alice');
    expect(h.db.project.fullName.find('explain/octo.hello')).toBeTruthy();
    open('');
    call(alice, mod.setJoinPolicy, { policy: 'anyone' });
    open('', 'other');
  });
});
