// The per-caller views (visible_<table>): what each caller reads of a
// private project, run as the queries the server runs (npm test). The leak
// test (scripts/leak-test.sh) asks the same of a real server.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

// Every view that holds rows of projects, and how a row names its project.
const PROJECT_VIEWS = {
  visibleProject: (r: any) => r.id,
  visibleGitRef: (r: any) => r.projectId,
  visibleGitObject: (r: any) => r.projectId,
  visibleObjectChunk: (r: any) => r.projectId,
  visibleProjectImport: (r: any) => r.projectId,
  visibleProjectBuilder: (r: any) => r.projectId,
  visibleActivity: (r: any) => r.projectId,
  visibleProjectMember: (r: any) => r.projectId,
  visiblePresence: (r: any) => r.projectId,
  visibleRefSync: (r: any) => r.projectId,
  visibleProjectSize: (r: any) => r.projectId,
  visibleQuestion: (r: any) => r.projectId,
  visibleProjectVisibility: (r: any) => r.projectId,
} as const;

const admin = as('admin');

// alice owns the hub; bob has bob/secret (private, with a commit, a
// collaborator slot, presence and a question) and bob/open (public); carol is
// a member of the hub without access.
function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const hex = (auth: TestAuth) => h.withReducerTx(auth, ctx => ctx.sender.toHexString());
  call(admin, mod.claimAdmin);
  const who = Object.fromEntries(['alice', 'bob', 'carol', 'stranger'].map(n => [n, as(n)]));
  call(admin, mod.setOwnerLogin, { login: 'alice' });
  ['alice', 'bob', 'carol'].forEach((n, i) =>
    call(admin, mod.githubLinkBuilder, { githubId: BigInt(i + 1), login: n, identity: hex(who[n]), token: `tok-${n}` })
  );
  call(who.bob, mod.createProjectFromTemplate, { space: 'bob', name: 'secret', description: '', template: '', goal: 'a goal' });
  call(who.bob, mod.createProjectFromTemplate, { space: 'bob', name: 'open', description: '', template: '', goal: 'a goal' });
  call(who.bob, mod.watchProject, { project: 'bob/secret', mode: 'watch', branch: '' });
  call(as('bob'), mod.watchSpace, { space: 'bob', mode: 'agent', host: 'h' }); // bob on a second connection
  call(who.alice, mod.watchProject, { project: 'bob/open', mode: 'watch', branch: '' });
  call(who.bob, mod.setProjectVisibility, { project: 'bob/secret', visibility: 'private' });
  const pid = (fullName: string) => h.db.project.fullName.find(fullName)!.id;
  // Rows of each project view the caller reads, by project id.
  const read = (auth: TestAuth) => {
    const ctx = h.viewContext(auth);
    const out: Record<string, bigint[]> = {};
    for (const [view, project] of Object.entries(PROJECT_VIEWS)) {
      const rows = h.runQuery<any>((mod as any)[view](ctx, {}));
      out[view] = rows.map(project);
    }
    return out;
  };
  const of = (got: Record<string, bigint[]>, projectId: bigint) =>
    Object.fromEntries(Object.entries(got).map(([v, ids]) => [v, ids.filter(i => i === projectId).length]));
  const whole = () => read(admin);
  return { h, call, who, pid, read, of, whole };
}

describe('visible_* views and private projects', () => {
  it('the admin reads every row; the private project has rows in most views (the test means something)', () => {
    const { pid, whole, of } = hub();
    const secret = of(whole(), pid('bob/secret'));
    for (const v of ['visibleProject', 'visibleGitRef', 'visibleGitObject', 'visibleActivity', 'visibleProjectSize', 'visiblePresence', 'visibleProjectVisibility']) {
      expect(secret[v], v).toBeGreaterThan(0);
    }
  });

  it('a member without access reads nothing of it, and all of every public project and of the hub', () => {
    const { who, pid, read, of, whole } = hub();
    const all = whole();
    const carol = read(who.carol);
    expect(Object.values(of(carol, pid('bob/secret'))).every(n => n === 0)).toBe(true);
    expect(of(carol, pid('bob/open'))).toEqual(of(all, pid('bob/open')));
    expect(of(carol, 0n)).toEqual(of(all, 0n)); // rows about no project (a builder joined, a space followed)
    expect(of(carol, 0n).visibleActivity).toBeGreaterThan(0);
  });

  it('the owner reads all of it, with no row twice', () => {
    const { who, read, whole } = hub();
    const all = whole();
    const bob = read(who.bob);
    for (const v of Object.keys(PROJECT_VIEWS)) expect(bob[v].length, v).toBe(all[v].length);
  });

  it('a stranger on an open hub reads public projects only; on a members-only hub nothing', () => {
    const { call, who, pid, read, of, whole } = hub();
    const stranger = read(who.stranger);
    expect(Object.values(of(stranger, pid('bob/secret'))).every(n => n === 0)).toBe(true);
    expect(of(stranger, pid('bob/open'))).toEqual(of(whole(), pid('bob/open')));
    call(who.alice, mod.setMembersOnly, { on: true });
    expect(Object.values(read(who.stranger)).every(rows => rows.length === 0)).toBe(true);
  });

  it('follows access: a collaborator reads it, loses it when removed, and everyone reads it once public', () => {
    const { call, who, pid, read, of, whole } = hub();
    const secret = pid('bob/secret');
    call(who.bob, mod.addProjectMember, { project: 'bob/secret', agent: 'carol' });
    expect(of(read(who.carol), secret)).toEqual(of(whole(), secret));
    call(who.bob, mod.removeProjectMember, { project: 'bob/secret', agent: 'carol' });
    expect(Object.values(of(read(who.carol), secret)).every(n => n === 0)).toBe(true);
    call(who.bob, mod.setProjectVisibility, { project: 'bob/secret', visibility: 'public' });
    expect(of(read(who.carol), secret)).toEqual(of(whole(), secret));
    expect(of(read(who.stranger), secret)).toEqual(of(whole(), secret));
  });

  it('activity of a deleted project: only the admin', () => {
    const { call, who, pid, read, of, whole } = hub();
    const open = pid('bob/open');
    call(who.bob, mod.deleteProject, { project: 'bob/open' });
    expect(of(whole(), open).visibleActivity).toBeGreaterThan(0);
    expect(of(read(who.bob), open).visibleActivity).toBe(0);
  });
});
