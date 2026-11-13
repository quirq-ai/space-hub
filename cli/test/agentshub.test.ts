// "Connect Agents Hub" (agentshub.ts) against stand-ins for XO's GET /login, Clerk's token endpoint, Launchpad's
// apps list and a hub's /healthz, with a stand-in for the usual Connect (npm test).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  agentsHubConfig, CANCEL_ROUTE, CHECK_GAP_MS, CHECK_ROUTE, COOKIE, handleAgentsHub, heldSteps, HOLD_MS, MAX_PER_BUILDER,
  MAX_STEPS, resetAgentsHub, START_ROUTE, WAIT_ROUTE, type AgentsHubConfig,
} from '../src/agentshub.ts';
import { CALLBACK_ROUTE } from '../src/xosignin.ts';

const CALLBACK = `https://hub.example${CALLBACK_ROUTE}`;

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// XO, Clerk and Launchpad on one stand-in server. Clerk hands out a pass and a refresh token per code;
// Launchpad accepts only passes Clerk handed out.
async function upstream() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const s = {
    passes: [] as string[],
    refreshes: [] as string[],
    seen: [] as { method: string; path: string; auth: string; body: string }[],
    apps: [] as Record<string, unknown>[],
    // Clerk's sign-in page: the person signs in and is sent back with a code.
    issue(authorize: string) {
      const u = new URL(authorize);
      const code = `code${codes.size + 1}`;
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
      return { code, state: u.searchParams.get('state')! };
    },
  };
  const srv = await listen(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const auth = String(req.headers.authorization ?? '');
    const url = new URL(req.url!, 'http://x');
    s.seen.push({ method: req.method!, path: url.pathname, auth, body });
    const send = (st: number, v: unknown) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (url.pathname === '/login') {
      return send(200, { data: { browser: { authorize: `${srv.base}/oauth/authorize`, clientId: 'client_1', scope: 'openid profile email' } } });
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      const c = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      const s256 = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
      if (!c || c.challenge !== s256 || c.redirect !== f.get('redirect_uri') || f.get('client_id') !== 'client_1' || f.get('client_secret')) {
        return send(400, { error: 'invalid_grant' });
      }
      const pass = `pass-${s.passes.length + 1}-SECRET`;
      const refresh = `refresh-${s.refreshes.length + 1}-SECRET`;
      s.passes.push(pass);
      s.refreshes.push(refresh);
      return send(200, { access_token: pass, refresh_token: refresh, token_type: 'bearer', expires_in: 86399, scope: 'openid profile email offline_access' });
    }
    if (url.pathname === '/launchpad/apps' && req.method === 'GET') {
      if (!s.passes.includes(auth.replace(/^Bearer /, ''))) return send(401, { detail: 'Not authenticated' });
      return send(200, { apps: s.apps });
    }
    send(404, { detail: 'no' });
  });
  return { state: s, base: srv.base, close: srv.close };
}

// A hub's /healthz, up or not yet.
async function hub() {
  const h = { up: true };
  const srv = await listen((req, res) => {
    if (req.url === '/healthz' && h.up) return res.writeHead(200).end('ok');
    res.writeHead(503).end();
  });
  return { h, base: srv.base, close: srv.close };
}

let up: Awaited<ReturnType<typeof upstream>>;
let theHub: Awaited<ReturnType<typeof hub>>;
let logged = '';
const realWrite = process.stderr.write.bind(process.stderr);
const cfgOf = (extra: Partial<AgentsHubConfig> = {}): AgentsHubConfig =>
  ({ launchpad: up.base, xo: up.base, template: 'agents-hub', createPage: 'https://launchpad.example/launchpad/new', ...extra });

beforeEach(async () => {
  resetAgentsHub();
  up = await upstream();
  theHub = await hub();
  logged = '';
  process.stderr.write = ((chunk: unknown) => { logged += String(chunk); return true; }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = realWrite;
  up.close();
  theHub.close();
});

// The routes as the web service serves them, for `user`; connect() is the usual Connect's stand-in.
async function serve(opts: { user?: string | null; cfg?: AgentsHubConfig | null; now?: () => number } = {}) {
  const calls: { owner: string; url: string }[] = [];
  const cfg = opts.cfg === undefined ? cfgOf() : opts.cfg;
  const srv = await listen((req, res) => {
    void handleAgentsHub(cfg, {
      sessionOf: async () => (opts.user === null ? null : { username: opts.user ?? 'alice' }),
      callbackUrl: () => CALLBACK,
      connect: async (owner, url) => {
        calls.push({ owner, url });
        return { to: `${url}/connect?state=c1`, cookie: 'spacehub_runner_connect=c1; Path=/-/runners/connect' };
      },
      page: (title, body) => `<title>${title}</title>${body}`,
      send: (r, status, html, extra = {}) => { r.writeHead(status, { 'content-type': 'text/html', ...extra }).end(html); },
      allowLocal: true,
    }, req, res, opts.now?.()).then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  const seenByBrowser: string[] = [];
  const go = async (path: string, cookie = '', method = 'GET') => {
    const res = await fetch(srv.base + path, { method, redirect: 'manual', headers: cookie ? { cookie } : {} });
    const text = await res.text();
    const out = { status: res.status, location: res.headers.get('location') ?? '', cookies: res.headers.getSetCookie(), refresh: res.headers.get('refresh'), text };
    seenByBrowser.push(JSON.stringify(out));
    return out;
  };
  return { go, calls, seenByBrowser, close: srv.close };
}

const cookieIn = (cookies: string[]) => (cookies.find(x => x.startsWith(`${COOKIE}=`)) ?? '').split(';')[0];

// Start, sign in on "Clerk", and come back to the XO callback.
async function signIn(h: Awaited<ReturnType<typeof serve>>) {
  const start = await h.go(START_ROUTE);
  const { code, state } = up.state.issue(start.location);
  const back = await h.go(`${CALLBACK_ROUTE}?code=${code}&state=${state}`, cookieIn(start.cookies));
  return { start, back, state };
}

// Nothing secret reached the browser (bodies, headers, cookies, redirects) or the logs, and the refresh token
// was never used.
function assertNothingLeaked(h: Awaited<ReturnType<typeof serve>>) {
  const everything = h.seenByBrowser.join('\n') + logged;
  for (const s of [...up.state.passes, ...up.state.refreshes]) assert.ok(!everything.includes(s), `leaked ${s}`);
  for (const r of up.state.refreshes) assert.ok(!up.state.seen.some(x => x.auth.includes(r) || x.body.includes(r)), 'refresh token was used');
}

const spentCookie = (cookies: string[]) => cookies.some(c => c.startsWith(`${COOKIE}=;`) && c.includes('Max-Age=0'));

test('start: off to XO\'s Clerk sign-in with the public client, this hub\'s XO callback, PKCE, and a state cookie', async () => {
  const h = await serve();
  const r = await h.go(START_ROUTE);
  assert.equal(r.status, 303);
  const to = new URL(r.location);
  assert.equal(to.origin + to.pathname, `${up.base}/oauth/authorize`);
  assert.equal(to.searchParams.get('client_id'), 'client_1');
  assert.equal(to.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('scope'), 'openid profile email');
  const state = to.searchParams.get('state')!;
  assert.match(r.cookies[0], new RegExp(`^${COOKIE}=${state}; Path=/-/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$`));
  h.close();
});

test('signed out: to the sign-in page, nothing started', async () => {
  const h = await serve({ user: null });
  const r = await h.go(START_ROUTE);
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/-\/login\?next=/);
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  h.close();
});

test('has an Agents Hub: found with the pass, connected, the pass not kept', async () => {
  up.state.apps.push({ id: 'a0', name: 'tetsg', template: 'agents-hub', status: 'running', url: theHub.base });
  const h = await serve();
  const { back } = await signIn(h);
  assert.equal(back.status, 303);
  assert.equal(back.location, `${theHub.base}/connect?state=c1`);
  assert.deepEqual(h.calls, [{ owner: 'alice', url: theHub.base }]);
  assert.ok(spentCookie(back.cookies), 'step cookie cleared');
  assert.equal(up.state.seen.find(x => x.path === '/launchpad/apps')!.auth, `Bearer ${up.state.passes[0]}`);
  assert.ok(!up.state.seen.some(x => x.method !== 'GET' && x.path.startsWith('/launchpad')), 'Launchpad is only read');
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assertNothingLeaked(h);
  h.close();
});

test('no Agents Hub: back to Settings with ?runner=nohub, the pass held for HOLD_MS (never sent anywhere), nothing created', async () => {
  up.state.apps.push({ id: 'x', name: 'blog', template: 'wordpress', status: 'running', url: 'https://blog.example' });
  const h = await serve();
  const { back } = await signIn(h);
  assert.equal(back.status, 303);
  assert.equal(back.location, '/?runner=nohub#/settings');
  assert.match(back.cookies[0], new RegExp(`^${COOKIE}=[^;]+; Path=/-/; HttpOnly; SameSite=Lax; Max-Age=${HOLD_MS / 1000}; Secure$`));
  assert.deepEqual(heldSteps(), { count: 1, passes: 1 });
  assert.ok(!up.state.seen.some(x => x.method !== 'GET' && x.path.startsWith('/launchpad')), 'nothing created');
  assertNothingLeaked(h);
  h.close();
});

test('no hub, then created on Launchpad: "check" finds it with the held pass (no second sign-in), drops the pass, moves on', async () => {
  theHub.h.up = false;
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  const cookie = cookieIn(back.cookies);
  now += CHECK_GAP_MS;
  const waiting = await h.go(CHECK_ROUTE, cookie, 'POST');
  assert.deepEqual(JSON.parse(waiting.text), { state: 'waiting' });
  // Created on Launchpad: still starting.
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  now += CHECK_GAP_MS;
  const found = await h.go(CHECK_ROUTE, cookie, 'POST');
  assert.deepEqual(JSON.parse(found.text), { state: 'found', go: WAIT_ROUTE });
  assert.equal(up.state.passes.length, 1); // one sign-in for the whole thing
  assert.equal(up.state.seen.filter(x => x.path === '/oauth/token').length, 1);
  assert.deepEqual(heldSteps(), { count: 1, passes: 0 }); // the pass is gone; only the wait is left
  theHub.h.up = true;
  const ready = await h.go(WAIT_ROUTE, cookieIn(found.cookies));
  assert.equal(ready.location, `${theHub.base}/connect?state=c1`);
  assert.deepEqual(h.calls, [{ owner: 'alice', url: theHub.base }]);
  assertNothingLeaked(h);
  h.close();
});

test('"check" for a hub that is up: straight to its approve page', async () => {
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'running', url: theHub.base });
  now += CHECK_GAP_MS;
  const found = await h.go(CHECK_ROUTE, cookieIn(back.cookies), 'POST');
  assert.deepEqual(JSON.parse(found.text), { state: 'found', go: `${theHub.base}/connect?state=c1` });
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  h.close();
});

test('"check" asked too often does not ask Launchpad each time', async () => {
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  const cookie = cookieIn(back.cookies);
  const lookups = () => up.state.seen.filter(x => x.path === '/launchpad/apps').length;
  const before = lookups();
  for (let i = 0; i < 5; i++) assert.deepEqual(JSON.parse((await h.go(CHECK_ROUTE, cookie, 'POST')).text), { state: 'waiting' });
  assert.equal(lookups(), before); // within CHECK_GAP_MS of the sign-in: no lookup at all
  now += CHECK_GAP_MS;
  await h.go(CHECK_ROUTE, cookie, 'POST');
  await h.go(CHECK_ROUTE, cookie, 'POST');
  assert.equal(lookups(), before + 1);
  h.close();
});

test('"check" after HOLD_MS: expired, the pass gone', async () => {
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  now += HOLD_MS + 1;
  const late = await h.go(CHECK_ROUTE, cookieIn(back.cookies), 'POST');
  assert.deepEqual(JSON.parse(late.text), { state: 'expired' });
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  h.close();
});

test('"check" finds a hub that failed or is stopped: said, the pass gone', async () => {
  for (const [status, state] of [['failed', 'failed'], ['stopped', 'stopped']]) {
    resetAgentsHub();
    up.state.apps.splice(0, up.state.apps.length);
    let now = Date.now();
    const h = await serve({ now: () => now });
    const { back } = await signIn(h);
    up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status, url: theHub.base });
    now += CHECK_GAP_MS;
    assert.deepEqual(JSON.parse((await h.go(CHECK_ROUTE, cookieIn(back.cookies), 'POST')).text), { state });
    assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
    h.close();
  }
});

test('a held pass is only for its browser and builder: anyone else gets "expired" and it stays put', async () => {
  let now = Date.now();
  const alice = await serve({ now: () => now });
  const { back } = await signIn(alice);
  const cookie = cookieIn(back.cookies);
  now += CHECK_GAP_MS;
  const bob = await serve({ user: 'bob', now: () => now });
  assert.deepEqual(JSON.parse((await bob.go(CHECK_ROUTE, cookie, 'POST')).text), { state: 'expired' });
  assert.deepEqual(JSON.parse((await alice.go(CHECK_ROUTE, '', 'POST')).text), { state: 'expired' }); // no cookie
  assert.deepEqual(heldSteps(), { count: 1, passes: 1 }); // Alice's is untouched
  assert.equal(up.state.seen.filter(x => x.path === '/launchpad/apps').length, 1); // only the sign-in's lookup
  alice.close();
  bob.close();
});

test('Close (cancel, POST) drops the held pass at once', async () => {
  const h = await serve();
  const { back } = await signIn(h);
  const r = await h.go(CANCEL_ROUTE, cookieIn(back.cookies), 'POST');
  assert.deepEqual(JSON.parse(r.text), { state: 'cancelled' });
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  h.close();
});

test('"check" is POST only (the site checks a POST comes from this site)', async () => {
  const h = await serve();
  assert.equal((await h.go(CHECK_ROUTE)).status, 405);
  h.close();
});

test('a hub made on Launchpad and still starting: found, waited for, then Connect', async () => {
  theHub.h.up = false;
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  const h = await serve();
  const { back } = await signIn(h);
  assert.equal(back.location, WAIT_ROUTE);
  assert.deepEqual(heldSteps(), { count: 1, passes: 0 }); // only the hub's address is waiting
  const cookie = cookieIn(back.cookies);
  const waiting = await h.go(WAIT_ROUTE, cookie);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.refresh, '5');
  assert.equal(h.calls.length, 0);
  theHub.h.up = true;
  const ready = await h.go(WAIT_ROUTE, cookie);
  assert.equal(ready.location, `${theHub.base}/connect?state=c1`);
  assert.deepEqual(h.calls, [{ owner: 'alice', url: theHub.base }]);
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assertNothingLeaked(h);
  h.close();
});

test('cancel while waiting: the step is gone, back to Settings', async () => {
  theHub.h.up = false;
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  const h = await serve();
  const { back } = await signIn(h);
  const cancel = await h.go(CANCEL_ROUTE, cookieIn(back.cookies));
  assert.equal(cancel.location, '/#/settings');
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  h.close();
});

test('the XO callback for a sign-in started elsewhere is not this module\'s', async () => {
  const h = await serve();
  const r = await h.go(`${CALLBACK_ROUTE}?code=x&state=someone-elses`);
  assert.equal(r.status, 404); // left to "Sign in with xo"
  h.close();
});

test('the return is taken once, only from the browser and builder that started it', async () => {
  const h = await serve();
  const start = await h.go(START_ROUTE);
  const { code, state } = up.state.issue(start.location);
  const noCookie = await h.go(`${CALLBACK_ROUTE}?code=${code}&state=${state}`);
  assert.equal(noCookie.location, '/?runner=xoexpired#/settings');
  const again = await h.go(`${CALLBACK_ROUTE}?code=${code}&state=${state}`, cookieIn(start.cookies));
  assert.equal(again.status, 404); // spent: no longer this module's
  h.close();

  const mallory = await serve({ user: 'mallory' });
  const aliceHub = await serve();
  const s2 = await aliceHub.go(START_ROUTE);
  const i2 = up.state.issue(s2.location);
  const stolen = await mallory.go(`${CALLBACK_ROUTE}?code=${i2.code}&state=${i2.state}`, cookieIn(s2.cookies));
  assert.equal(stolen.location, '/?runner=xoexpired#/settings');
  assert.equal(up.state.passes.length, 0); // no code was ever swapped
  mallory.close();
  aliceHub.close();
});

test('cancelled on XO: denied, nothing swapped', async () => {
  const h = await serve();
  const start = await h.go(START_ROUTE);
  const { state } = up.state.issue(start.location);
  const r = await h.go(`${CALLBACK_ROUTE}?error=access_denied&state=${state}`, cookieIn(start.cookies));
  assert.equal(r.location, '/?runner=xodenied#/settings');
  assert.equal(up.state.passes.length, 0);
  h.close();
});

test('Launchpad does not accept the pass (another Clerk): a plain error, nothing kept', async () => {
  const h = await serve({ cfg: cfgOf({ launchpad: `${up.base}/elsewhere` }) });
  const { back } = await signIn(h);
  assert.equal(back.status, 502);
  assert.match(back.text, /Launchpad answered 404/);
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assertNothingLeaked(h);
  h.close();
});

test('a hub that failed or is stopped: said at once, no waiting; one being deleted counts as none', async () => {
  for (const [status, code] of [['failed', 'hubfailed'], ['stopped', 'hubstopped'], ['deleting', 'nohub']]) {
    resetAgentsHub();
    up.state.apps.splice(0, up.state.apps.length, { id: 'a0', name: 'agents-hub', template: 'agents-hub', status, url: theHub.base });
    const h = await serve();
    const { back } = await signIn(h);
    assert.equal(back.location, `/?runner=${code}#/settings`, status);
    // Failed or stopped: nothing held. Being deleted counts as no hub: the pass is held while they make a new one.
    assert.deepEqual(heldSteps(), code === 'nohub' ? { count: 1, passes: 1 } : { count: 0, passes: 0 }, status);
    assert.equal(h.calls.length, 0);
    h.close();
  }
});

test('a hub that never answers: after WAIT_MS, Settings says it is slow (not "expired"); a foreign wait link stays "expired"', async () => {
  theHub.h.up = false;
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  const cookie = cookieIn(back.cookies);
  now += 15 * 60_000 + 1;
  const late = await h.go(WAIT_ROUTE, cookie);
  assert.equal(late.location, '/?runner=hubslow#/settings');
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assert.equal((await h.go(WAIT_ROUTE, `${COOKIE}=not-a-step`)).location, '/?runner=xoexpired#/settings');
  h.close();
});

test('never asks Clerk for offline_access, even if XO lists it', async () => {
  const h = await serve();
  const r = await h.go(START_ROUTE);
  assert.doesNotMatch(new URL(r.location).searchParams.get('scope') ?? '', /offline_access/);
  h.close();
});

test('one builder cannot fill the table: past MAX_PER_BUILDER, their oldest steps go and others still get in', async () => {
  const mallory = await serve({ user: 'mallory' });
  for (let i = 0; i < MAX_STEPS + 20; i++) await mallory.go(START_ROUTE);
  assert.deepEqual(heldSteps(), { count: MAX_PER_BUILDER, passes: 0 });
  const alice = await serve();
  const r = await alice.go(START_ROUTE);
  assert.equal(r.status, 303); // not "Too many connections are waiting"
  assert.match(r.location, /\/oauth\/authorize\?/);
  mallory.close();
  alice.close();
});

test('the wait page probes /healthz once per visit', async () => {
  theHub.h.up = false;
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  const h = await serve();
  const { back } = await signIn(h);
  theHub.h.up = true;
  let probes = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/healthz')) probes++;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const ready = await h.go(WAIT_ROUTE, cookieIn(back.cookies));
    assert.equal(ready.location, `${theHub.base}/connect?state=c1`);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(probes, 1);
  h.close();
});

test('a wait that ran out still says "slow" after other people started flows', async () => {
  theHub.h.up = false;
  up.state.apps.push({ id: 'a0', name: 'agents-hub', template: 'agents-hub', status: 'deploying', url: theHub.base });
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  now += 15 * 60_000 + 1;
  const bob = await serve({ user: 'bob', now: () => now });
  await bob.go(START_ROUTE); // starting a step clears out expired ones
  assert.equal((await h.go(WAIT_ROUTE, cookieIn(back.cookies))).location, '/?runner=hubslow#/settings');
  h.close();
  bob.close();
});

test('the old create routes are gone', async () => {
  const h = await serve();
  for (const method of ['GET', 'POST']) assert.equal((await h.go('/-/runners/agents-hub/create', '', method)).status, 404);
  h.close();
});

test('off: without SPACEHUB_LAUNCHPAD_API, or with XO sign-in off; addresses checked', () => {
  assert.equal(agentsHubConfig({}), null);
  assert.equal(agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://lp.example', SPACEHUB_XO_URL: 'off' }), null);
  assert.deepEqual(agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://launchpad-beta-api.xo.builders/' }),
    { launchpad: 'https://launchpad-beta-api.xo.builders', xo: 'https://xo.quirq.dev', template: 'agents-hub', createPage: null });
  assert.equal(agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://lp.example', SPACEHUB_LAUNCHPAD_CREATE_PAGE: 'https://launchpad-beta.xo.builders/launchpad/new' })!.createPage,
    'https://launchpad-beta.xo.builders/launchpad/new');
  assert.throws(() => agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'http://lp.example' }), /https/);
  assert.throws(() => agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://lp.example', SPACEHUB_LAUNCHPAD_CREATE_PAGE: 'javascript:alert(1)' }), /https/);
});
