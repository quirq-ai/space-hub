// Members-only hubs: who is a member (store.ts isMember), the owner's switch,
// and agents of a suspended builder (npm test). What a non-member actually
// receives from the visible_* views is checked against a real server
// (scripts/leak-test.sh).
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { isMember, mayReadHub, membersOnly } from '../src/store';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const admin = as('admin');

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  const id = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender);
  call(admin, mod.claimAdmin);
  // alice owns the hub (signed up with GitHub as the owner login); bob is another builder.
  const alice = as('alice');
  const bob = as('bob');
  call(admin, mod.setOwnerLogin, { login: 'alice' });
  call(admin, mod.githubLinkBuilder, { githubId: 1n, login: 'alice', identity: hex(alice), token: 'tok-alice' });
  call(admin, mod.githubLinkBuilder, { githubId: 2n, login: 'bob', identity: hex(bob), token: 'tok-bob' });
  const member = (auth: TestAuth) => isMember(h.db as any, id(auth));
  const mayRead = (auth: TestAuth) => mayReadHub(h.db as any, id(auth));
  return { h, call, hex, member, mayRead, alice, bob };
}

describe('isMember', () => {
  it('is a builder who is not suspended, or an agent with such an owner', () => {
    const { call, hex, member, alice, bob } = hub();
    const scout = as('scout');
    call(bob, mod.createAgent, { name: 'scout', parent: 'bob', identity: hex(scout), token: 't', description: '' });
    expect(member(alice)).toBe(true);
    expect(member(bob)).toBe(true);
    expect(member(scout)).toBe(true);
    expect(member(as('stranger'))).toBe(false);
    expect(member(admin)).toBe(false);

    call(alice, mod.suspendBuilder, { username: 'bob' });
    expect(member(bob)).toBe(false);
    expect(member(scout)).toBe(false);
    call(alice, mod.restoreBuilder, { username: 'bob' });
    expect(member(scout)).toBe(true);
  });

  it('counts an org agent while one owner of the org is a member', () => {
    const { call, hex, member, alice, bob } = hub();
    call(bob, mod.createOrg, { name: 'acme', description: '' });
    call(bob, mod.addSpaceMember, { space: 'acme', member: 'alice', role: 'owner' });
    const bot = as('bot');
    call(bob, mod.createAgent, { name: 'bot', parent: 'acme', identity: hex(bot), token: 't', description: '' });
    call(alice, mod.suspendBuilder, { username: 'bob' });
    expect(member(bot)).toBe(true); // alice still owns acme
  });
});

describe('members-only', () => {
  it('is off unless the owner switches it on; off removes the setting', () => {
    const { h, call, mayRead, alice, bob } = hub();
    const stranger = as('stranger');
    expect(membersOnly(h.db as any)).toBe(false);
    expect(mayRead(stranger)).toBe(true);

    expect(() => call(bob, mod.setMembersOnly, { on: true })).toThrow(/only the hub's owner/);
    expect(() => call(stranger, mod.setMembersOnly, { on: true })).toThrow(/only the hub's owner/);
    call(alice, mod.setMembersOnly, { on: true });
    call(alice, mod.setMembersOnly, { on: true }); // again: nothing changes
    expect(h.db.hubState.key.find('membersOnly')?.value).toBe('true');
    expect(mayRead(stranger)).toBe(false);
    expect(mayRead(bob)).toBe(true);
    expect(mayRead(admin)).toBe(true); // the web service reads as the admin

    call(alice, mod.suspendBuilder, { username: 'bob' });
    expect(mayRead(bob)).toBe(false);

    call(admin, mod.setMembersOnly, { on: false }); // the admin may act for the owner
    expect(h.db.hubState.key.find('membersOnly')).toBeFalsy();
    expect(mayRead(stranger)).toBe(true);
  });
});

describe('an agent of a suspended builder', () => {
  it('can no longer write, and can again once its builder is restored', () => {
    const { call, hex, alice, bob } = hub();
    const scout = as('scout');
    call(bob, mod.createAgent, { name: 'scout', parent: 'bob', identity: hex(scout), token: 't', description: '' });
    call(scout, mod.createProject, { space: 'scout', name: 'notes', description: '' });
    call(alice, mod.suspendBuilder, { username: 'bob' });
    expect(() => call(scout, mod.createProject, { space: 'scout', name: 'more', description: '' })).toThrow(/no owner left on this hub/);
    expect(() => call(scout, mod.editProject, { project: 'scout/notes', description: 'x', defaultBranch: undefined })).toThrow(/permission denied/);
    call(alice, mod.restoreBuilder, { username: 'bob' });
    call(scout, mod.createProject, { space: 'scout', name: 'more', description: '' });
  });
});
