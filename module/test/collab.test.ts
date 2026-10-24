// Members and presence, run in SpacetimeDB's in-process module harness (no
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

describe('members', () => {
  it('lets the owner add a member, who can then push', () => {
    const { h, call, alice, bob, push, kinds } = hub();
    const first = commit('first');
    expect(() => push(bob, first, '')).toThrow(/permission denied/);
    expect(() => call(bob, mod.addMember, { space: SPACE, agent: 'bob' })).toThrow(/permission denied/);
    call(alice, mod.addMember, { space: SPACE, agent: 'Bob' });
    call(alice, mod.addMember, { space: SPACE, agent: 'bob' }); // twice is a no-op
    expect([...h.db.spaceMember.iter()].map(m => m.agent)).toEqual(['bob']);
    push(bob, first, '');
    const sp = h.db.space.fullName.find(SPACE)!;
    expect(h.db.gitRef.spaceId.filter(sp.id).next().value?.oid).toBe(first.oid);
    expect(kinds()).toContain('alice member_added bob');
    expect(kinds()).toContain('bob ref_created refs/heads/main');
    // The owner and the member keep each other's history: fast-forwards only.
    push(alice, commit('second', first.oid), first.oid);
  });

  it('refuses unknown agents and the owner', () => {
    const { call, alice } = hub();
    expect(() => call(alice, mod.addMember, { space: SPACE, agent: 'nobody' })).toThrow(/no agent named/);
    expect(() => call(alice, mod.addMember, { space: SPACE, agent: 'alice' })).toThrow(/owns/);
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
    expect([...h.db.spaceMember.iter()]).toEqual([]);
    expect(() => call(alice, mod.removeMember, { space: SPACE, agent: 'bob' })).toThrow(/not a member/);
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

  it('needs an agent, a known space and a valid mode', () => {
    const { call, bob } = hub();
    expect(() => call(as('anonymous'), mod.watchSpace, { space: SPACE, mode: 'watch', branch: '' })).toThrow(/no agent name/);
    expect(() => call(bob, mod.watchSpace, { space: 'alice/missing', mode: 'watch', branch: '' })).toThrow(/not found/);
    expect(() => call(bob, mod.watchSpace, { space: SPACE, mode: 'lurk', branch: '' })).toThrow(/invalid presence mode/);
    expect(() => call(bob, mod.watchSpace, { space: SPACE, mode: 'sync', branch: 'a..b' })).toThrow(/invalid branch/);
  });
});
