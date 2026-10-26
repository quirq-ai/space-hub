// The admin claim and the xo store, run in SpacetimeDB's in-process module
// harness (no server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) =>
    h.withReducerTx(auth, ctx => reducer(ctx, args));
  return { h, call };
}

const admin = as('admin');
const stranger = as('stranger');
const SUBJECT = 'user_2abcDEF123';

describe('claimAdmin', () => {
  it('goes to the first caller, for good', () => {
    const { call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.claimAdmin); // the same identity again is fine
    expect(() => call(stranger, mod.claimAdmin)).toThrow(/already another identity/);
  });
});

describe('xoPutRecord', () => {
  it('needs the admin', () => {
    const { call } = hub();
    expect(() => call(stranger, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: '{}' })).toThrow(/only the hub admin/);
    call(admin, mod.claimAdmin);
    expect(() => call(stranger, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: '{}' })).toThrow(/only the hub admin/);
  });

  it('is compare-and-swap on the version', () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: '{"projects":["a"]}' });
    expect(h.db.xoRecord.subject.find(SUBJECT)?.version).toBe(1n);
    expect(() => call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: '{}' })).toThrow(/stale: .* version 1/);
    call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 1n, doc: '{"projects":["a","b"]}' });
    const row = h.db.xoRecord.subject.find(SUBJECT)!;
    expect(row.version).toBe(2n);
    expect(JSON.parse(row.doc)).toEqual({ projects: ['a', 'b'] });
  });

  it('refuses bad ids, non-objects and oversized records', () => {
    const { call } = hub();
    call(admin, mod.claimAdmin);
    expect(() => call(admin, mod.xoPutRecord, { subject: "x' OR 1=1", version: 0n, doc: '{}' })).toThrow(/invalid xo user id/);
    expect(() => call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: '[1]' })).toThrow(/JSON object/);
    expect(() => call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: 'nope' })).toThrow(/JSON object/);
    const big = JSON.stringify({ a: 'x'.repeat(256 * 1024) });
    expect(() => call(admin, mod.xoPutRecord, { subject: SUBJECT, version: 0n, doc: big })).toThrow(/larger than/);
  });
});

describe('xoLinkAgent and accounts', () => {
  const identity = 'ab'.repeat(32);

  it('makes the agent once, under the xo username', () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.xoLinkAgent, { subject: SUBJECT, username: 'suraj', identity, token: 'tok' });
    expect(h.db.user.username.find('suraj')?.identity.toHexString()).toBe(identity);
    expect(h.db.xoAgent.subject.find(SUBJECT)?.token).toBe('tok');
    expect(() => call(admin, mod.xoLinkAgent, { subject: SUBJECT, username: 'suraj2', identity: 'cd'.repeat(32), token: 't' })).toThrow(/already has an agent/);
    expect(() => call(admin, mod.xoLinkAgent, { subject: 'user_other', username: 'suraj', identity: 'cd'.repeat(32), token: 't' })).toThrow(/is taken/);
    expect(() => call(stranger, mod.xoLinkAgent, { subject: 'user_x', username: 'x', identity: 'ef'.repeat(32), token: 't' })).toThrow(/only the hub admin/);
  });

  it('turns open sign-up off when accounts come from xo', () => {
    const { call } = hub();
    call(admin, mod.claimAdmin);
    call(as('alice'), mod.registerUser, { username: 'alice' });
    expect(() => call(stranger, mod.setAccounts, { source: 'xo' })).toThrow(/only the hub admin/);
    call(admin, mod.setAccounts, { source: 'xo' });
    expect(() => call(as('bob'), mod.registerUser, { username: 'bob' })).toThrow(/made by xo/);
    call(admin, mod.setAccounts, { source: 'open' });
    call(as('bob'), mod.registerUser, { username: 'bob' });
  });
});

describe('GitHub sign-up', () => {
  const OCTOCAT = 583231n;
  function signedUp() {
    const t = hub();
    t.call(admin, mod.claimAdmin);
    const octo = as('octocat-identity');
    const hex = t.h.withReducerTx(octo, ctx => ctx.sender.toHexString());
    t.call(admin, mod.githubLinkBuilder, { githubId: OCTOCAT, login: 'Octocat', identity: hex, token: 'octo-token' });
    return { ...t, octo, hex };
  }

  it('makes one builder per GitHub account, named after its login, and keeps its token', () => {
    const { h, call, hex } = signedUp();
    expect(h.db.user.username.find('octocat')?.identity.toHexString()).toBe(hex);
    expect(h.db.hubSpace.name.find('octocat')?.kind).toBe('personal');
    const row = h.db.githubAccount.githubId.find(OCTOCAT)!;
    expect([row.login, row.username, row.token]).toEqual(['Octocat', 'octocat', 'octo-token']);
    expect(() => call(admin, mod.githubLinkBuilder, { githubId: OCTOCAT, login: 'octocat', identity: 'cd'.repeat(32), token: 't' })).toThrow(/already the builder "octocat"/);
  });

  it('needs the admin, a free name and a GitHub login', () => {
    const { call } = signedUp();
    const args = { githubId: 7n, login: 'hubot', identity: 'cd'.repeat(32), token: 't' };
    expect(() => call(stranger, mod.githubLinkBuilder, args)).toThrow(/only the hub admin/);
    expect(() => call(admin, mod.githubLinkBuilder, { ...args, login: 'OCTOCAT' })).toThrow(/is taken/);
    call(as('alice'), mod.registerUser, { username: 'alice' });
    call(as('alice'), mod.createTeam, { name: 'acme', description: '' });
    expect(() => call(admin, mod.githubLinkBuilder, { ...args, login: 'acme' })).toThrow(/is taken/);
    expect(() => call(admin, mod.githubLinkBuilder, { ...args, login: 'v1' })).toThrow(/reserved/);
    expect(() => call(admin, mod.githubLinkBuilder, { ...args, login: "x' OR 1=1" })).toThrow(/invalid GitHub login/);
    expect(() => call(admin, mod.githubLinkBuilder, { ...args, githubId: 0n })).toThrow(/invalid GitHub account id/);
    call(admin, mod.githubLinkBuilder, args);
  });

  it('turns name registration off, and is itself off when xo makes builders', () => {
    const { call } = signedUp();
    call(admin, mod.setAccounts, { source: 'github' });
    expect(() => call(as('bob'), mod.registerUser, { username: 'bob' })).toThrow(/sign up with GitHub/);
    call(admin, mod.githubLinkBuilder, { githubId: 7n, login: 'hubot', identity: 'cd'.repeat(32), token: 't' });
    // xo's API still makes builders for its users next to GitHub sign-up.
    call(admin, mod.xoLinkAgent, { subject: SUBJECT, username: 'xo-user', identity: '12'.repeat(32), token: 't' });
    call(admin, mod.setAccounts, { source: 'xo' });
    expect(() => call(admin, mod.githubLinkBuilder, { githubId: 8n, login: 'monalisa', identity: 'ef'.repeat(32), token: 't' })).toThrow(/made by xo/);
    expect(() => call(admin, mod.setAccounts, { source: 'gitlab' })).toThrow(/"open", "github"/);
  });

  it('a builder who leaves frees its GitHub account and name', () => {
    const { h, call, octo } = signedUp();
    call(octo, mod.deleteBuilder);
    expect(h.db.githubAccount.githubId.find(OCTOCAT)).toBeNull();
    expect(h.db.user.username.find('octocat')).toBeNull();
    call(admin, mod.githubLinkBuilder, { githubId: OCTOCAT, login: 'octocat', identity: 'cd'.repeat(32), token: 'new' });
    expect(h.db.githubAccount.githubId.find(OCTOCAT)?.token).toBe('new');
  });
});
