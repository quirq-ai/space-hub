// The hub's owner, bound to a GitHub account id, and suspending builders (npm test).
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const admin = as('admin');
const OWNER_ID = 4242n;

function hub(accounts = 'open') {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  call(admin, mod.claimAdmin);
  if (accounts !== 'open') call(admin, mod.setAccounts, { source: accounts });
  // A builder signs up with GitHub: the web service checked the account and made `who` its identity.
  const signUp = (who: TestAuth, githubId: bigint, login: string) =>
    call(admin, mod.githubLinkBuilder, { githubId, login, identity: hex(who), token: `tok-${login}` });
  const state = () => Object.fromEntries([...h.db.hubState.iter()].map(r => [r.key, r.value]));
  return { h, call, hex, signUp, state };
}

describe('hub owner', () => {
  it('is the GitHub account whose checked login matches, recorded by its id', () => {
    const { call, signUp, state } = hub();
    call(admin, mod.setOwnerLogin, { login: 'Alice' });
    signUp(as('alice'), OWNER_ID, 'alice');
    expect(state()).toMatchObject({ owner_login: 'Alice', owner: '4242' });
  });

  it('is not a builder who registers, or signs up as another account, with the owner login first', () => {
    const { call, signUp, state } = hub();
    call(admin, mod.setOwnerLogin, { login: 'alice' });
    // An open hub: anyone registers the name before the real owner comes.
    const squatter = as('squatter');
    call(squatter, mod.registerUser, { username: 'alice' });
    expect(state().owner).toBeUndefined();
    expect(() => call(squatter, mod.suspendBuilder, { username: 'alice' })).toThrow(/only the hub's owner/);
    // Another GitHub account is not the owner either.
    signUp(as('bob'), 7n, 'bob');
    expect(state().owner).toBeUndefined();
  });

  it('stays with the GitHub account when its builder is renamed, and never moves to the new holder of the name', () => {
    const { h, call, signUp, state } = hub();
    call(admin, mod.setOwnerLogin, { login: 'alice' });
    const alice = as('alice');
    signUp(alice, OWNER_ID, 'alice');
    // xo moves a builder made before GitHub was needed onto the login "alice2"; the owner record is untouched.
    call(admin, mod.xoLinkAgent, { subject: 'user_x', username: 'carol', identity: 'cd'.repeat(32), token: 't' });
    call(admin, mod.xoLinkGithub, { subject: 'user_x', githubId: 99n, login: 'alice2', xoName: '', alias: '', identity: '', token: '' });
    expect(state().owner).toBe('4242');
    expect(h.db.user.username.find('alice')?.identity.isEqual(h.db.githubAccount.githubId.find(OWNER_ID)!.identity)).toBe(true);
    call(alice, mod.suspendBuilder, { username: 'alice2' });
    expect([...h.db.builderSuspension.iter()].map(r => r.username)).toEqual(['alice2']);
  });

  it('restarting with the same login changes nothing; another login forgets the owner; "" is no owner', () => {
    const { call, signUp, state } = hub();
    call(admin, mod.setOwnerLogin, { login: 'alice' });
    signUp(as('alice'), OWNER_ID, 'alice');
    const before = state();
    call(admin, mod.setOwnerLogin, { login: 'alice' });
    call(admin, mod.setOwnerLogin, { login: 'ALICE' });
    expect(state()).toEqual(before);
    call(admin, mod.setOwnerLogin, { login: 'bob' });
    expect(state()).toMatchObject({ owner_login: 'bob' });
    expect(state().owner).toBeUndefined();
    call(admin, mod.setOwnerLogin, { login: '' });
    expect(state().owner_login).toBeUndefined();
    expect(() => call(admin, mod.setOwnerLogin, { login: 'not a login' })).toThrow(/invalid GitHub login/);
    expect(() => call(as('x'), mod.setOwnerLogin, { login: 'x' })).toThrow(/only the hub admin/);
  });

  it('is recorded at a returning sign-in when the owner was named after the account signed up', () => {
    const { call, signUp, state } = hub();
    signUp(as('alice'), OWNER_ID, 'alice');
    call(admin, mod.setOwnerLogin, { login: 'alice' });
    expect(state().owner).toBeUndefined();
    expect(() => call(admin, mod.githubSignedIn, { githubId: 7n, login: 'alice' })).toThrow(/no builder for that GitHub account/);
    expect(() => call(as('alice'), mod.githubSignedIn, { githubId: OWNER_ID, login: 'alice' })).toThrow(/only the hub admin/);
    expect(state().owner).toBeUndefined();
    call(admin, mod.githubSignedIn, { githubId: OWNER_ID, login: 'alice' });
    expect(state().owner).toBe('4242');
    // Later sign-ins (even under a new login) change nothing.
    call(admin, mod.githubSignedIn, { githubId: OWNER_ID, login: 'alice-renamed' });
    expect(state().owner).toBe('4242');
  });

  it('without an owner login, a hub records no owner (as before)', () => {
    const { signUp, state } = hub();
    signUp(as('alice'), OWNER_ID, 'alice');
    expect(Object.keys(state()).sort()).toEqual(['admin']);
  });
});

describe('suspending builders', () => {
  function withOwner() {
    const t = hub();
    t.call(admin, mod.setOwnerLogin, { login: 'alice' });
    const alice = as('alice');
    const bob = as('bob');
    t.signUp(alice, OWNER_ID, 'alice');
    t.signUp(bob, 7n, 'bob');
    t.call(bob, mod.createProject, { space: 'bob', name: 'notes', description: '' });
    return { ...t, alice, bob };
  }

  it("refuses a suspended builder's writes and keeps its data; restoring lets it back", () => {
    const { h, call, alice, bob } = withOwner();
    call(alice, mod.suspendBuilder, { username: 'bob' });
    call(alice, mod.suspendBuilder, { username: 'bob' });
    expect([...h.db.builderSuspension.iter()]).toHaveLength(1);
    expect(() => call(bob, mod.createProject, { space: 'bob', name: 'more', description: '' })).toThrow(/suspended/);
    expect(() => call(bob, mod.deleteProject, { project: 'bob/notes' })).toThrow(/suspended|permission denied/);
    expect(() => call(bob, mod.createOrg, { name: 'bobs-org', description: '' })).toThrow(/suspended/);
    expect(h.db.project.fullName.find('bob/notes')).toBeTruthy();
    expect(h.db.user.username.find('bob')).toBeTruthy();
    call(alice, mod.restoreBuilder, { username: 'bob' });
    call(alice, mod.restoreBuilder, { username: 'bob' });
    call(bob, mod.createProject, { space: 'bob', name: 'more', description: '' });
    expect(h.db.project.fullName.find('bob/more')).toBeTruthy();
  });

  it('is for the owner, or the admin; not other builders, and never the owner itself', () => {
    const { h, call, alice, bob } = withOwner();
    expect(() => call(bob, mod.suspendBuilder, { username: 'alice' })).toThrow(/only the hub's owner/);
    expect(() => call(alice, mod.suspendBuilder, { username: 'alice' })).toThrow(/cannot be suspended/);
    expect(() => call(alice, mod.suspendBuilder, { username: 'nobody' })).toThrow(/no builder named/);
    call(admin, mod.suspendBuilder, { username: 'bob' });
    expect(h.db.builderSuspension.username.find('bob')?.suspendedBy).toBe('-admin');
    expect(() => call(bob, mod.restoreBuilder, { username: 'bob' })).toThrow(/suspended|only the hub's owner/);
  });
});
