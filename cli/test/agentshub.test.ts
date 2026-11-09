// "Connect Agents Hub" (agentshub.ts) against stand-ins for XO's GET /login, Clerk's token endpoint, Launchpad's
// apps API and a hub's /healthz, with a stand-in for the usual Connect (npm test).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  agentsHubConfig, CANCEL_ROUTE, COOKIE, CREATE_ROUTE, FORM_MS, handleAgentsHub, heldSteps, resetAgentsHub,
  START_ROUTE, WAIT_ROUTE, XO_API_KEY_PLACEHOLDER, type AgentsHubConfig,
} from '../src/agentshub.ts';
import { CALLBACK_ROUTE } from '../src/xosignin.ts';

const CALLBACK = `https://hub.example${CALLBACK_ROUTE}`;
const SECRETS = { openaiApiKey: 'sk-openai-SECRET-1', environmentKey: 'env-SECRET-2', hubPassword: 'hub-password-SECRET-3', githubToken: 'ghp_SECRET4' };

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// XO, Clerk and Launchpad on one stand-in server. Clerk hands out a pass and a refresh token per code;
// Launchpad accepts only passes Clerk handed out.
async function upstream() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const passes: string[] = [];
  const refreshes: string[] = [];
  const seen: { method: string; path: string; auth: string; body: string }[] = [];
  const apps: Record<string, unknown>[] = [];
  const s = {
    hubUrl: '',
    createStatus: 201 as number,
    createBody: null as unknown,
    codes, passes, refreshes, seen, apps,
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
    seen.push({ method: req.method!, path: url.pathname, auth, body });
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
      const pass = `pass-${passes.length + 1}-SECRET`;
      const refresh = `refresh-${refreshes.length + 1}-SECRET`;
      passes.push(pass);
      refreshes.push(refresh);
      return send(200, { access_token: pass, refresh_token: refresh, token_type: 'bearer', expires_in: 86399, scope: 'openid profile email offline_access' });
    }
    if (url.pathname === '/launchpad/apps') {
      if (!passes.includes(auth.replace(/^Bearer /, ''))) return send(401, { detail: 'Not authenticated' });
      if (req.method === 'GET') return send(200, { apps });
      if (req.method === 'POST') {
        if (s.createStatus !== 201) return send(s.createStatus, s.createBody);
        const input = JSON.parse(body);
        const app = { id: 'a1', name: input.name, template: input.template, status: 'deploying', url: s.hubUrl };
        apps.push(app);
        return send(201, { app, registry: null, notes: '', release: null });
      }
    }
    send(404, { detail: 'no' });
  });
  return { ...s, state: s, base: srv.base, close: srv.close };
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

beforeEach(async () => {
  resetAgentsHub();
  up = await upstream();
  theHub = await hub();
  up.state.hubUrl = theHub.base;
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
  const pages: string[] = [];
  const cfg = opts.cfg === undefined ? { launchpad: up.base, xo: up.base, template: 'agents-hub' } : opts.cfg;
  const srv = await listen((req, res) => {
    void handleAgentsHub(cfg, {
      sessionOf: async () => (opts.user === null ? null : { username: opts.user ?? 'alice' }),
      callbackUrl: () => CALLBACK,
      connect: async (owner, url) => {
        calls.push({ owner, url });
        return { to: `${url}/connect?state=c1`, cookie: 'spacehub_runner_connect=c1; Path=/-/runners/connect' };
      },
      page: (title, body) => `<title>${title}</title>${body}`,
      send: (r, status, html, extra = {}) => { pages.push(html); r.writeHead(status, { 'content-type': 'text/html', ...extra }).end(html); },
      readForm: async r => { let b = ''; for await (const c of r) b += c; return new URLSearchParams(b); },
      allowLocal: true,
    }, req, res, opts.now?.()).then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  const seenByBrowser: string[] = [];
  const go = async (path: string, cookie = '', init: { method?: string; form?: Record<string, string> } = {}) => {
    const res = await fetch(srv.base + path, {
      method: init.method ?? 'GET', redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: init.form ? new URLSearchParams(init.form) : undefined,
    });
    const text = await res.text();
    const out = { status: res.status, location: res.headers.get('location') ?? '', cookies: res.headers.getSetCookie(), refresh: res.headers.get('refresh'), referrer: res.headers.get('referrer-policy'), text };
    seenByBrowser.push(JSON.stringify(out));
    return out;
  };
  return { go, calls, pages, seenByBrowser, close: srv.close };
}

const cookieIn = (cookies: string[]) => {
  const c = cookies.find(x => x.startsWith(`${COOKIE}=`)) ?? '';
  return c.split(';')[0];
};

// Start, sign in on "Clerk", and come back to the XO callback.
async function signIn(h: Awaited<ReturnType<typeof serve>>) {
  const start = await h.go(START_ROUTE);
  const { code, state } = up.state.issue(start.location);
  const back = await h.go(`${CALLBACK_ROUTE}?code=${code}&state=${state}`, cookieIn(start.cookies));
  return { start, back, state };
}

// Nothing secret reached the browser (bodies, headers, cookies, redirects) or the logs.
function assertNothingLeaked(h: Awaited<ReturnType<typeof serve>>) {
  const everything = h.seenByBrowser.join('\n') + logged;
  for (const s of [...up.state.passes, ...up.state.refreshes, ...Object.values(SECRETS)]) assert.ok(!everything.includes(s), `leaked ${s}`);
  // The refresh token never went anywhere: no request to Launchpad or anyone carried it.
  for (const r of up.state.refreshes) assert.ok(!up.state.seen.some(x => x.auth.includes(r) || x.body.includes(r)), 'refresh token was used');
}

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
  assert.equal(heldSteps().count, 0);
  h.close();
});

test('has an Agents Hub: found with the pass, connected, nothing created, the pass not kept', async () => {
  up.state.apps.push({ id: 'a0', name: 'tetsg', template: 'agents-hub', status: 'running', url: theHub.base });
  const h = await serve();
  const { back } = await signIn(h);
  assert.equal(back.status, 303);
  assert.equal(back.location, `${theHub.base}/connect?state=c1`);
  assert.deepEqual(h.calls, [{ owner: 'alice', url: theHub.base }]);
  assert.ok(back.cookies.some(c => c.startsWith(`${COOKIE}=;`) && c.includes('Max-Age=0')), 'step cookie cleared');
  assert.ok(!up.state.seen.some(x => x.method === 'POST' && x.path === '/launchpad/apps'), 'nothing created');
  assert.equal(up.state.seen.find(x => x.path === '/launchpad/apps')!.auth, `Bearer ${up.state.passes[0]}`);
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assertNothingLeaked(h);
  h.close();
});

test('no Agents Hub: the form, then Launchpad creates it with the keys and the placeholder XO key, then Connect', async () => {
  const h = await serve();
  const { back } = await signIn(h);
  assert.equal(back.status, 303);
  assert.equal(back.location, CREATE_ROUTE);
  assert.deepEqual(heldSteps(), { count: 1, passes: 1 }); // held in memory for the form only
  const cookie = cookieIn(back.cookies);
  const form = await h.go(CREATE_ROUTE, cookie);
  assert.equal(form.status, 200);
  // With no-referrer, the browser posts the form with `Origin: null` and the site's same-origin check refuses it.
  assert.notEqual(form.referrer, 'no-referrer');
  for (const name of ['name', 'openaiApiKey', 'environmentKey', 'hubPassword', 'githubToken']) assert.match(form.text, new RegExp(`name="${name}"`));

  const made = await h.go(CREATE_ROUTE, cookie, { method: 'POST', form: { name: 'agents-hub', ...SECRETS } });
  assert.equal(made.status, 303);
  assert.equal(made.location, `${theHub.base}/connect?state=c1`);
  const create = up.state.seen.find(x => x.method === 'POST' && x.path === '/launchpad/apps')!;
  assert.equal(create.auth, `Bearer ${up.state.passes[0]}`);
  assert.deepEqual(JSON.parse(create.body), { template: 'agents-hub', name: 'agents-hub', params: { ...SECRETS, xoApiKey: XO_API_KEY_PLACEHOLDER } });
  assert.deepEqual(h.calls, [{ owner: 'alice', url: theHub.base }]);
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 }); // the pass and the keys are gone
  assertNothingLeaked(h);
  h.close();
});

test('a new hub still starting: the wait page refreshes until /healthz answers, then Connect', async () => {
  theHub.h.up = false;
  const h = await serve();
  const { back } = await signIn(h);
  const made = await h.go(CREATE_ROUTE, cookieIn(back.cookies), { method: 'POST', form: { name: 'agents-hub', ...SECRETS } });
  assert.equal(made.location, WAIT_ROUTE);
  assert.deepEqual(heldSteps(), { count: 1, passes: 0 }); // only the hub's address is waiting
  const cookie = cookieIn(made.cookies);
  const waiting = await h.go(WAIT_ROUTE, cookie);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.refresh, '5');
  assert.equal(h.calls.length, 0);
  theHub.h.up = true;
  const ready = await h.go(WAIT_ROUTE, cookie);
  assert.equal(ready.location, `${theHub.base}/connect?state=c1`);
  assert.equal(heldSteps().count, 0);
  assertNothingLeaked(h);
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
  assert.equal(noCookie.location, '/?runner=expired#/settings');
  const again = await h.go(`${CALLBACK_ROUTE}?code=${code}&state=${state}`, cookieIn(start.cookies));
  assert.equal(again.status, 404); // spent: no longer this module's
  h.close();

  const mallory = await serve({ user: 'mallory' });
  const aliceHub = await serve();
  const s2 = await aliceHub.go(START_ROUTE);
  const i2 = up.state.issue(s2.location);
  const stolen = await mallory.go(`${CALLBACK_ROUTE}?code=${i2.code}&state=${i2.state}`, cookieIn(s2.cookies));
  assert.equal(stolen.location, '/?runner=expired#/settings');
  assert.equal(up.state.passes.length, 0); // no code was ever swapped
  mallory.close();
  aliceHub.close();
});

test('cancelled on XO: denied, nothing swapped', async () => {
  const h = await serve();
  const start = await h.go(START_ROUTE);
  const { state } = up.state.issue(start.location);
  const r = await h.go(`${CALLBACK_ROUTE}?error=access_denied&state=${state}`, cookieIn(start.cookies));
  assert.equal(r.location, '/?runner=denied#/settings');
  assert.equal(up.state.passes.length, 0);
  h.close();
});

test('Launchpad refuses the values: the form again with its reason and the name, never the keys; Cancel drops the pass', async () => {
  up.state.createStatus = 422;
  up.state.createBody = { detail: { message: 'invalid parameters', errors: ["'hubPassword': does not match the expected format"] } };
  const h = await serve();
  const { back } = await signIn(h);
  const cookie = cookieIn(back.cookies);
  const r = await h.go(CREATE_ROUTE, cookie, { method: 'POST', form: { name: 'my-hub', ...SECRETS } });
  assert.equal(r.status, 422);
  assert.match(r.text, /hubPassword&#39;: does not match the expected format/);
  assert.match(r.text, /value="my-hub"/);
  assert.equal(heldSteps().passes, 1);
  const cancel = await h.go(CANCEL_ROUTE, cookie);
  assert.equal(cancel.location, '/#/settings');
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assertNothingLeaked(h);
  h.close();
});

test('a hub made in another tab first (409): that hub is connected', async () => {
  up.state.createStatus = 409;
  up.state.createBody = { detail: 'you already have an Agents Hub' };
  const h = await serve();
  const { back } = await signIn(h);
  up.state.apps.push({ id: 'a0', name: 'other-tab', template: 'agents-hub', status: 'running', url: theHub.base });
  const r = await h.go(CREATE_ROUTE, cookieIn(back.cookies), { method: 'POST', form: { name: 'agents-hub', ...SECRETS } });
  assert.equal(r.location, `${theHub.base}/connect?state=c1`);
  assert.equal(heldSteps().passes, 0);
  h.close();
});

test('checked here first: a short hub password never reaches Launchpad', async () => {
  const h = await serve();
  const { back } = await signIn(h);
  const r = await h.go(CREATE_ROUTE, cookieIn(back.cookies), { method: 'POST', form: { name: 'agents-hub', ...SECRETS, hubPassword: 'short' } });
  assert.equal(r.status, 400);
  assert.ok(!up.state.seen.some(x => x.method === 'POST' && x.path === '/launchpad/apps'));
  h.close();
});

test('the pass is held at most FORM_MS: after that the form is gone with it', async () => {
  let now = Date.now();
  const h = await serve({ now: () => now });
  const { back } = await signIn(h);
  now += FORM_MS + 1;
  const r = await h.go(CREATE_ROUTE, cookieIn(back.cookies), { method: 'POST', form: { name: 'agents-hub', ...SECRETS } });
  assert.equal(r.location, '/?runner=expired#/settings');
  assert.deepEqual(heldSteps(), { count: 0, passes: 0 });
  assert.ok(!up.state.seen.some(x => x.method === 'POST' && x.path === '/launchpad/apps'));
  h.close();
});

test('Launchpad does not accept the pass (another Clerk): a plain error, nothing kept', async () => {
  const h = await serve({ cfg: { launchpad: `${up.base}/elsewhere`, xo: up.base, template: 'agents-hub' } });
  const { back } = await signIn(h);
  assert.equal(back.status, 502);
  assert.match(back.text, /Launchpad answered 404|did not accept/);
  assert.equal(heldSteps().count, 0);
  assertNothingLeaked(h);
  h.close();
});

test('off: without SPACEHUB_LAUNCHPAD_API, or with XO sign-in off; addresses checked', () => {
  assert.equal(agentsHubConfig({}), null);
  assert.equal(agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://lp.example', SPACEHUB_XO_URL: 'off' }), null);
  assert.deepEqual(agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'https://launchpad-beta-api.xo.builders/' }),
    { launchpad: 'https://launchpad-beta-api.xo.builders', xo: 'https://xo.quirq.dev', template: 'agents-hub' });
  assert.throws(() => agentsHubConfig({ SPACEHUB_LAUNCHPAD_API: 'http://lp.example' }), /https/);
});
