// Members-only at the front door (npm test): the flag's cache, who gets in,
// what a refusal looks like, the Caddyfile's forward_auth, and that every
// route in the code is on the leak test's list (scripts/routes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Identity } from 'spacetimedb';
import { accessOf, DENIED_HEADER, FrontDoor, pathOf, ROUTES } from '../src/frontdoor.ts';
import type { Viewer } from '../src/viewer.ts';
import { LIST, unlisted } from '../../scripts/routes.ts';

const root = path.join(import.meta.dirname, '../..');
const id = { toHexString: () => 'a1' } as unknown as Identity;
const request = (headers: http.IncomingHttpHeaders = {}, url = '/') => ({ headers, url, method: 'GET' }) as http.IncomingMessage;

// A database whose flag and sessions the test sets; it counts every read.
function hub(on: boolean) {
  const state = { on, fail: false, flagReads: 0, viewerReads: 0, turnedOn: 0, time: 0 };
  const sessions: Record<string, Viewer | null> = {
    'tok-alice': { token: 'tok-alice', identity: id, name: 'alice' },
    'tok-nobody': { token: 'tok-nobody', identity: id, name: null }, // a valid identity with no builder
    'tok-bob': null, // suspended: viewerOf answers null
  };
  const door = new FrontDoor({
    membersOnly: async () => {
      state.flagReads++;
      if (state.fail) throw new Error('database down');
      return state.on;
    },
    viewer: async req => {
      state.viewerReads++;
      const token = /spacehub_session=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
      return sessions[token] ?? null;
    },
    turnedOn: () => state.turnedOn++,
    now: () => state.time,
  });
  return { door, state };
}

// A response that records what was written.
function response() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body = '') {
      out.body = String(body);
    },
  } as unknown as http.ServerResponse;
  return { res, out };
}

test('off: everything gets in, with one flag read per interval and no viewer lookups', async () => {
  const { door, state } = hub(false);
  const asks = await Promise.all([door.allows(request(), '/alice/notes/raw/main/a.txt'), door.allows(request(), '/-/api/view'), door.allows(request(), '/')]);
  assert.deepEqual(asks, [true, true, true]);
  assert.equal(state.flagReads, 1, 'concurrent requests share one read');
  state.time = 4_999;
  await door.allows(request(), '/');
  assert.equal(state.flagReads, 1, 'reused within 5 seconds');
  state.time = 5_000;
  await door.allows(request(), '/');
  assert.equal(state.flagReads, 2, 'read again after');
  assert.equal(state.viewerReads, 0);
});

test('on: only members reach the hub; strangers, builderless identities and suspended builders do not', async () => {
  const { door } = hub(true);
  const as = (token?: string) => request(token ? { cookie: `spacehub_user=alice; spacehub_session=${token}` } : { cookie: 'spacehub_user=alice' });
  assert.equal(await door.allows(as('tok-alice'), '/alice/notes'), true);
  assert.equal(await door.allows(as(), '/alice/notes'), false, 'a forged display name is nobody');
  assert.equal(await door.allows(as('tok-nobody'), '/alice/notes'), false);
  assert.equal(await door.allows(as('tok-bob'), '/alice/notes'), false);
  assert.equal(await door.allows(as('forged'), '/-/api/view'), false);
});

test('on: sign-in, sign-up and the files they load stay open, without asking who it is', async () => {
  const { door, state } = hub(true);
  for (const uri of ['/healthz', '/-/login', '/-/login?next=/x', '/-/login/github', '/-/login/github/callback?code=1', '/-/login/xo/callback', '/-/signup?invite=abc', '/-/logout', '/-/app/shell.css', '/-/api/auth/github/device/poll', '/-/auth/check']) {
    assert.equal(await door.allows(request(), uri), true, uri);
  }
  assert.equal(state.viewerReads, 0);
});

test('a path that only starts like an open one is for members', () => {
  for (const p of ['/-/login/../alice/notes', '/-/login/../../alice/notes', '/-/app/../../alice/notes/raw/main/a', '/-/login%2F..%2Falice', '/-/loginx', '/-/login/github/x', '/-/app/a/b.css', '/-/app/', '/-/signup/x', '/-/api/xo', '/-/api/instance-recoveryx']) {
    assert.equal(accessOf(pathOf(p)), 'members', p);
  }
  assert.equal(pathOf('/-/login/../../alice?x=1'), '/alice');
  assert.equal(accessOf('/-/api/xo/v1/records/a'), 'own-auth');
  assert.equal(accessOf('/-/api/instance-recovery/status'), 'own-auth');
  assert.ok(ROUTES.every(r => r.path.source.startsWith('^')), 'every open route is anchored');
});

test('a membership is remembered per session for the interval', async () => {
  const { door, state } = hub(true);
  const alice = request({ cookie: 'spacehub_session=tok-alice' });
  await door.allows(alice, '/a');
  await door.allows(alice, '/b');
  assert.equal(state.viewerReads, 1);
  state.time = 6_000;
  await door.allows(alice, '/c');
  assert.equal(state.viewerReads, 2);
});

test('suspending a builder forgets its memberships at once, on every session, and no one else', async () => {
  const viewers: Record<string, Viewer> = {
    'tok-alice': { token: 'tok-alice', identity: id, name: 'alice' },
    'tok-carol': { token: 'tok-carol', identity: id, name: 'carol' },
    'tok-carol2': { token: 'tok-carol2', identity: id, name: 'carol' }, // carol on another browser
  };
  let reads = 0;
  let carolSuspended = false;
  const door = new FrontDoor({
    membersOnly: async () => true,
    viewer: async req => {
      reads++;
      const v = viewers[/spacehub_session=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? ''] ?? null;
      return v && v.name === 'carol' && carolSuspended ? null : v;
    },
    now: () => 0,
  });
  const [alice, carol, carol2] = ['tok-alice', 'tok-carol', 'tok-carol2'].map(t => request({ cookie: `spacehub_session=${t}` }));
  for (const r of [alice, carol, carol2]) assert.equal(await door.allows(r, '/x'), true);
  assert.equal(reads, 3);
  carolSuspended = true;
  assert.equal(await door.allows(carol, '/x'), true, 'untold, the cache still lets carol in');
  door.forgetBuilder('carol');
  assert.equal(await door.allows(carol, '/x'), false, 'carol is out on the next request');
  assert.equal(await door.allows(carol2, '/x'), false, 'on every session');
  assert.equal(await door.allows(alice, '/x'), true);
  assert.equal(reads, 5, "alice's membership is still remembered");
});

test('a membership looked up while its builder is being suspended is not remembered', async () => {
  let release!: () => void;
  let reads = 0;
  const door = new FrontDoor({
    membersOnly: async () => true,
    viewer: async () => {
      reads++;
      if (reads === 1) await new Promise<void>(r => (release = r));
      return { token: 'tok-carol', identity: id, name: 'carol' };
    },
    now: () => 0,
  });
  const carol = request({ cookie: 'spacehub_session=tok-carol' });
  const first = door.allows(carol, '/x');
  await new Promise(r => setImmediate(r));
  door.forgetBuilder('carol');
  release();
  assert.equal(await first, true, 'the answer already under way');
  await door.allows(carol, '/x');
  assert.equal(reads, 2, 'but it was not remembered');
});

test('a flag that cannot be read keeps its last answer, or is closed', async () => {
  const fresh = hub(false);
  fresh.state.fail = true;
  assert.equal(await fresh.door.membersOnly(), true, 'never read: closed');
  fresh.state.fail = false;
  fresh.state.time = 1_000;
  assert.equal(await fresh.door.membersOnly(), false, 'asked again a second later');
  const known = hub(false);
  await known.door.membersOnly();
  known.state.fail = true;
  known.state.time = 5_000;
  assert.equal(await known.door.membersOnly(), false, 'last answer kept');
});

test('turning it on is noticed once (to end live pages), and forgets memberships', async () => {
  const { door, state } = hub(false);
  await door.membersOnly();
  assert.equal(state.turnedOn, 0);
  state.on = true;
  state.time = 5_000;
  await door.membersOnly();
  state.time = 10_000;
  await door.membersOnly();
  assert.equal(state.turnedOn, 1);
});

test("the owner's own switch in Settings takes effect on the next request", async () => {
  const { door, state } = hub(false);
  await door.membersOnly();
  state.on = true;
  door.forget();
  assert.equal(await door.membersOnly(), true);
  assert.equal(state.flagReads, 2);
});

test("/-/auth/check answers Caddy's forward_auth: 204 to let through, a sign-in redirect for a page, 401 for the rest", async () => {
  const { door } = hub(true);
  const ask = async (headers: http.IncomingHttpHeaders) => {
    const { res, out } = response();
    assert.equal(await door.check(request(headers, '/-/auth/check'), res, new URL('http://x/-/auth/check')), true);
    return out;
  };
  const page = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/alice/notes/tree/main?x=1', accept: 'text/html,*/*' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, `/-/login?next=${encodeURIComponent('/alice/notes/tree/main?x=1')}`);
  assert.equal(page.headers[DENIED_HEADER], 'sign-in');
  const api = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/-/api/view', accept: 'application/json' });
  assert.equal(api.status, 401);
  assert.match(api.body, /members/);
  assert.doesNotMatch(api.body, /alice|notes/);
  const post = await ask({ 'x-forwarded-method': 'POST', 'x-forwarded-uri': '/-/new', accept: 'text/html' });
  assert.equal(post.status, 401, 'a form post is not sent to sign in');
  assert.equal((await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/-/signup?invite=x', accept: 'text/html' })).status, 204);
  assert.equal((await ask({ 'x-forwarded-uri': '/alice', cookie: 'spacehub_session=tok-alice' })).status, 204);
  const { res } = response();
  assert.equal(await door.check(request(), res, new URL('http://x/-/login')), false, 'other paths are not the check');
});

test("the web service's own guard refuses its own request the same way", async () => {
  const { door } = hub(true);
  const { res, out } = response();
  assert.equal(await door.guard(request({ accept: 'text/html' }, '/-/new?template=goal'), res), true);
  assert.equal(out.headers.location, `/-/login?next=${encodeURIComponent('/-/new?template=goal')}`);
  const open = response();
  assert.equal(await door.guard(request({ accept: 'text/html' }, '/-/login'), open.res), false);
  assert.equal(open.out.status, 0, 'nothing written');
  const off = hub(false);
  assert.equal(await off.door.guard(request({}, '/alice'), response().res), false);
});

test('the Caddyfile asks the front door before everything but /healthz and the database client endpoints, and drops forged proxy headers', () => {
  const caddy = fs.readFileSync(path.join(root, 'docker/server.Caddyfile'), 'utf8');
  assert.match(caddy, /^\t@door not path \/healthz \/v1\/identity\/websocket-token \/v1\/database\/\{\$SPACEHUB_DB:spacehub\}\/subscribe$/m);
  assert.match(caddy, /^\tforward_auth @door 127\.0\.0\.1:\{\$SPACEHUB_WEB_PORT:3002\} \{\n\t\turi \/-\/auth\/check\n\t\}$/m);
  for (const h of ['X-Forwarded-Method', 'X-Forwarded-Uri', 'X-Spacehub-Uri']) assert.match(caddy, new RegExp(`^\\trequest_header -${h}$`, 'm'));
  // forward_auth runs before every handle; it must not sit inside one.
  assert.ok(caddy.indexOf('\tforward_auth') < caddy.indexOf('\thandle'));
});

test("every route in the code is on the leak test's list (scripts/routes.ts)", () => {
  const { missing, stale } = unlisted(root);
  assert.deepEqual(missing, [], 'add these to scripts/routes.ts LIST, with the requests that cover them');
  assert.deepEqual(stale, [], 'LIST names routes the code no longer has');
  // The list and the front door agree on which routes are open.
  for (const [key, probes] of Object.entries(LIST)) {
    for (const p of probes) {
      if (key === "web '/-/auth/check'") continue; // open, but asked directly it answers for "/"
      assert.equal(accessOf(pathOf(p.path)) !== 'members', !!p.open, `${key}: ${p.path}`);
    }
  }
});
