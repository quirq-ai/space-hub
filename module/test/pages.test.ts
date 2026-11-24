// Private projects on the module's own pages (ui.ts) and data (workspace.ts):
// the viewer comes only from the web service's secret (reader.ts webViewer),
// and a private project the viewer may not read looks exactly like a missing
// one, in every page, listing, count, size and feed (npm test).
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { WEB_SECRET_KEY, readerDb, webViewer } from '../src/reader';
import { renderUi } from '../src/ui';
import { parseQuery, renderApi } from '../src/workspace';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const SECRET = 'a'.repeat(40);
const NOW = 1_900_000_000;

// bob has two projects made from the goal template (files, a commit, activity):
// bob/xsecretx, private, and bob/shown, public. carol is a builder of the hub
// with no access to bob/xsecretx; dave collaborates on it.
function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const admin = as('admin');
  call(admin, mod.claimAdmin);
  const who = Object.fromEntries(['bob', 'carol', 'dave'].map(n => [n, as(n)]));
  for (const n of Object.keys(who)) call(who[n], mod.registerUser, { username: n });
  for (const name of ['xsecretx', 'shown']) {
    call(who.bob, mod.createProjectFromTemplate, { space: 'bob', name, description: `${name}desc`, template: 'goal', goal: `${name}goal` });
  }
  call(who.bob, mod.addProjectMember, { project: 'bob/xsecretx', agent: 'dave' });
  call(who.bob, mod.setProjectVisibility, { project: 'bob/xsecretx', visibility: 'private' });
  call(admin, mod.setWebSecret, { secret: SECRET });
  const db = () => h.db as any;
  const page = (viewer: string | null, path: string) => renderUi(db(), { uri: 'http://hub.test/', forwardedUri: path, viewer, proto: 'https', now: NOW });
  const api = (viewer: string | null, query: string) => renderApi(db(), { query: parseQuery(query), viewer, now: NOW });
  return { h, call, who, admin, db, page, api };
}

const text = (body: string | Uint8Array) => (typeof body === 'string' ? body : new TextDecoder().decode(body));

describe('the viewer of a page', () => {
  it('is the builder the web service names, only with its secret', () => {
    const { db, call, admin } = hub();
    expect(webViewer(db(), SECRET, 'carol')).toBe('carol');
    expect(webViewer(db(), SECRET, '')).toBe(null);
    expect(webViewer(db(), null, 'carol'), 'no secret: signed out').toBe(null);
    expect(webViewer(db(), 'b'.repeat(40), 'carol'), 'a wrong secret: signed out').toBe(null);
    expect(webViewer(db(), SECRET.slice(1), 'carol'), 'a shorter one').toBe(null);
    expect(webViewer(db(), SECRET, 'nobody'), 'a name the hub does not know').toBe(null);
    // A new start's secret replaces the old one.
    call(admin, mod.setWebSecret, { secret: 'c'.repeat(64) });
    expect(webViewer(db(), SECRET, 'carol')).toBe(null);
    expect(webViewer(db(), 'c'.repeat(64), 'carol')).toBe('carol');
  });

  it('is never set by anyone but the admin, nor to a guessable secret', () => {
    const { call, who, admin } = hub();
    expect(() => call(who.bob, mod.setWebSecret, { secret: 'd'.repeat(40) })).toThrow(/permission denied/);
    expect(() => call(admin, mod.setWebSecret, { secret: 'short' })).toThrow(/32 to 256/);
  });

  it('without a secret on the hub, everyone is signed out', () => {
    const { h, db, page } = hub();
    h.withReducerTx(as('admin'), ctx => ctx.db.hubState.key.delete(WEB_SECRET_KEY));
    expect(webViewer(db(), SECRET, 'bob')).toBe(null);
    expect(page(null, '/bob/xsecretx').status).toBe(404);
  });
});

describe('a private project on the module pages', () => {
  const pages = ['', '/tree/main', '/tree/main/SPACE.md', '/blob/main/SPACE.md', '/raw/main/SPACE.md', '/commits/main', '/refs', '/branches', '/tags', '/activity'];

  it('is not found, exactly like a missing one, for those who may not read it', () => {
    const { page } = hub();
    for (const viewer of [null, 'carol']) {
      for (const p of pages) {
        const xsecretx = page(viewer, `/bob/xsecretx${p}`);
        const missing = page(viewer, `/bob/nosuch${p}`);
        expect(xsecretx.status, `${viewer} ${p}`).toBe(404);
        expect(text(xsecretx.body).replaceAll('xsecretx', 'nosuch'), `${viewer} ${p}`).toBe(text(missing.body));
      }
    }
  });

  it('is shown as before to its owner and its collaborator', () => {
    const { page } = hub();
    for (const viewer of ['bob', 'dave']) {
      for (const p of pages) expect(page(viewer, `/bob/xsecretx${p}`).status, `${viewer} ${p}`).toBe(200);
      expect(text(page(viewer, '/bob/xsecretx/raw/main/SPACE.md').body)).toContain('xsecretxgoal');
    }
  });

  it('is in no listing, count or feed for those who may not read it', () => {
    const { page, api } = hub();
    for (const viewer of [null, 'carol']) {
      for (const p of ['/', '/bob', '/-/builders', '/-/builders/bob', '/carol', '/dave']) {
        const body = text(page(viewer, p).body);
        expect(body, `${viewer} ${p}`).not.toContain('xsecretx');
      }
      for (const q of ['', 'space=bob', 'space=dave', 'activity=1', 'activity=1&space=bob', 'templates=1']) {
        const body = api(viewer, q).body;
        expect(body, `${viewer} ?${q}`).not.toContain('xsecretx');
      }
      const hubLevel = JSON.parse(api(viewer, '').body).meta;
      expect(hubLevel.projects, `${viewer}: the hub counts one project`).toBe(1);
      const space = JSON.parse(api(viewer, 'space=bob').body).meta;
      expect(space.projects).toBe(1);
      for (const q of ['space=bob&project=xsecretx', 'space=bob&project=xsecretx&view=tree&ref=main', 'activity=1&space=bob&project=xsecretx']) {
        const xsecretx = api(viewer, q);
        const missing = api(viewer, q.replace('xsecretx', 'nosuch'));
        expect(xsecretx.status, `${viewer} ?${q}`).toBe(404);
        expect(xsecretx.body.replaceAll('xsecretx', 'nosuch')).toBe(missing.body);
      }
      expect(JSON.parse(api(viewer, 'readable=bob/xsecretx').body)).toEqual({ readable: false });
      expect(JSON.parse(api(viewer, 'readable=bob/shown').body)).toEqual({ readable: true });
    }
  });

  it('sizes and counts for one who may not read it equal a hub without it', () => {
    const { page, api, call, who } = hub();
    const carol = { hub: JSON.parse(api('carol', '').body).meta, space: JSON.parse(api('carol', 'space=bob').body).meta };
    const homeCarol = text(page('carol', '/').body);
    call(who.bob, mod.deleteProject, { project: 'bob/xsecretx' });
    const after = { hub: JSON.parse(api('bob', '').body).meta, space: JSON.parse(api('bob', 'space=bob').body).meta };
    for (const key of ['projects', 'bytes']) {
      expect(carol.hub[key], `hub ${key}`).toBe(after.hub[key]);
      expect(carol.space[key], `space ${key}`).toBe(after.space[key]);
    }
    expect(homeCarol).not.toContain('xsecretx');
  });

  it('owner and collaborator see the same as the hub admin would', () => {
    const { api, db } = hub();
    const all = JSON.parse(renderApi(db(), { query: parseQuery(''), viewer: null, now: NOW }).body);
    expect(all.meta.projects, 'signed out: the public one').toBe(1);
    for (const viewer of ['bob', 'dave']) {
      const meta = JSON.parse(api(viewer, '').body).meta;
      expect(meta.projects).toBe(2);
      expect(JSON.stringify(meta.allProjects)).toContain('bob/xsecretx');
      expect(JSON.parse(api(viewer, 'readable=bob/xsecretx').body)).toEqual({ readable: true });
    }
  });

  it('says which projects are private to those who read them, and who may change it', () => {
    const { api } = hub();
    for (const viewer of ['bob', 'dave']) {
      const cards = JSON.parse(api(viewer, '').body).meta.allProjects;
      expect(cards.find((c: any) => c.fullName === 'bob/xsecretx').private, viewer).toBe(true);
      expect('private' in cards.find((c: any) => c.fullName === 'bob/shown'), 'a public card says nothing').toBe(false);
      const entries = JSON.parse(api(viewer, 'space=bob').body).snapshot.directory.entries;
      expect(entries.find((e: any) => e.name === 'xsecretx').private).toBe(true);
      expect(entries.find((e: any) => e.name === 'shown').private).toBe(undefined);
      const project = JSON.parse(api(viewer, 'space=bob&project=xsecretx').body).meta;
      expect(project.visibility).toBe('private');
      expect(project.canSetVisibility, `${viewer} owns bob?`).toBe(viewer === 'bob');
    }
    expect(JSON.parse(api('dave', 'space=dave').body).meta.privateCollaborates).toEqual(['bob/xsecretx']);
    expect(JSON.parse(api('carol', 'space=dave').body).meta.privateCollaborates, 'carol reads none of it').toEqual([]);
    const shown = JSON.parse(api('carol', 'space=bob&project=shown').body).meta;
    expect([shown.visibility, shown.canSetVisibility]).toEqual(['public', false]);
    expect(JSON.parse(api(null, 'space=bob&project=shown').body).meta.canSetVisibility).toBe(false);
  });

  it('a members-only hub shows a signed-out viewer nothing', () => {
    const { h, db } = hub();
    // Members-only straight in the table: its reducer is the hub owner's, and this hub has none.
    h.withReducerTx(as('admin'), ctx => ctx.db.hubState.insert({ key: 'membersOnly', value: 'true' }));
    const view = readerDb(db(), null);
    expect([...view.project.iter()].length).toBe(0);
    expect(view.project.count()).toBe(0n);
    expect(view.project.fullName.find('bob/shown')).toBe(null);
    expect([...readerDb(db(), 'carol').project.iter()].map(p => p.fullName)).toEqual(['bob/shown']);
  });
});
