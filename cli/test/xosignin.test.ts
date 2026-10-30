// Sign in to the website with xo, against stand-ins for the xo server (and
// Clerk behind it) and for SpacetimeDB's HTTP API (npm test).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Reply } from '../src/admin.ts';
import { finishSignIn, forgetOffer, MAX_PENDING, offerFor, resetXoSignIns, startSignIn, START_LIMIT, xoSignInConfig, type XoSignInConfig } from '../src/xosignin.ts';
import type { XoConfig } from '../src/xo.ts';

const KEY = 'k'.repeat(40);
const CALLBACK = 'https://hub.example/-/login/xo/callback';
const TOKEN = 'hub-token-of-alice';

const listen = async (server: http.Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

// The hub's private xo_agent table, as the admin reads it.
function fakeDb(agents: Map<string, { username: string; token: string }>) {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.headers.authorization !== 'Bearer admin-token' || !body.includes('FROM xo_agent')) return res.writeHead(400).end('no');
    const a = agents.get(/subject = '([^']*)'/.exec(body)![1]);
    res.end(JSON.stringify([{ schema: { elements: [{ name: { some: 'username' } }, { name: { some: 'token' } }] }, rows: a ? [[a.username, a.token]] : [] }]));
  });
}

// The xo server: GET /login offers the hub's callback; POST /login/hub swaps a
// code Clerk gave (codes[code] = the challenge it was asked for) and makes the
// agent in the hub, as the real one does through the hub's xo API.
function fakeXo(agents: Map<string, { username: string; token: string }>) {
  const state = {
    offer: { browser: { authorize: 'https://clerk.example/oauth/authorize', clientId: 'cli_1', scope: 'openid profile email', redirects: [] }, hub: { redirect: CALLBACK } } as unknown,
    codes: new Map<string, string>(),
    asked: { login: 0, hub: [] as { auth: string | undefined; body: Record<string, unknown> }[] },
    answer: null as null | [number, unknown],
    username: 'alice',
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/login') {
      state.asked.login++;
      return reply(200, { success: true, data: state.offer });
    }
    if (req.method === 'POST' && req.url === '/login/hub') {
      const body = JSON.parse(raw);
      state.asked.hub.push({ auth: req.headers.authorization, body });
      if (state.answer) return reply(...state.answer);
      if (req.headers.authorization !== `Bearer ${KEY}`) return reply(401, { success: false, error: 'Missing or wrong hub key' });
      const challenge = state.codes.get(body.code);
      state.codes.delete(body.code);
      const proof = createHash('sha256').update(String(body.verifier)).digest('base64url');
      if (!challenge || challenge !== proof || body.redirect !== CALLBACK) {
        return reply(401, { success: false, error: 'The sign-in did not work (it expired or was already used); sign in again' });
      }
      if (!agents.has('user_alice')) agents.set('user_alice', { username: state.username, token: TOKEN });
      return reply(200, { success: true, data: { subject: 'user_alice', agent: agents.get('user_alice')!.username } });
    }
    reply(404, { success: false, error: 'Not found' });
  });
  return { server, state };
}

async function setup() {
  const agents = new Map<string, { username: string; token: string }>();
  const db = fakeDb(agents);
  const xo = fakeXo(agents);
  const xoCfg: XoConfig = { key: KEY, adminToken: 'admin-token', db: 'spacehub', http: await listen(db) };
  const cfg: XoSignInConfig = { xo: xoCfg, server: await listen(xo.server) };
  // Clerk: the visitor signs in, and the browser comes back with a code for this challenge.
  const signIn = (location: string) => {
    const q = new URL(location).searchParams;
    const code = `code-${xo.state.codes.size + 1}`;
    xo.state.codes.set(code, q.get('code_challenge')!);
    return { state: q.get('state')!, code };
  };
  const close = () => { for (const s of [db, xo.server]) { s.close(); s.closeAllConnections(); } };
  return { cfg, xo: xo.state, agents, signIn, close };
}

beforeEach(() => {
  resetXoSignIns();
  forgetOffer();
});

test('on with the xo API, at xo.quirq.dev unless SPACEHUB_XO_URL says otherwise', () => {
  const xo: XoConfig = { key: KEY, adminToken: 'a', db: 'spacehub', http: 'http://127.0.0.1:3001' };
  assert.equal(xoSignInConfig(null, {}), null);
  assert.equal(xoSignInConfig(xo, {})?.server, 'https://xo.quirq.dev');
  assert.equal(xoSignInConfig(xo, { SPACEHUB_XO_URL: 'http://127.0.0.1:8787/' })?.server, 'http://127.0.0.1:8787');
  assert.equal(xoSignInConfig(xo, { SPACEHUB_XO_URL: 'off' }), null);
  assert.throws(() => xoSignInConfig(xo, { SPACEHUB_XO_URL: 'http://xo.example' }), /https/);
  assert.throws(() => xoSignInConfig(xo, { SPACEHUB_XO_URL: 'https://xo.example/?a=1' }), /https/);
});

test('the button shows only while the xo server offers this hub\'s own callback', async () => {
  const { cfg, xo, close } = await setup();
  assert.equal((await offerFor(cfg, CALLBACK))?.clientId, 'cli_1');
  assert.equal(await offerFor(cfg, 'http://evil.example/-/login/xo/callback'), null, 'another host gets no button');
  assert.equal(await offerFor(null, CALLBACK), null);
  assert.equal(xo.asked.login, 1, 'the answer is kept for a while');
  forgetOffer();
  xo.offer = { browser: (xo.offer as { browser: unknown }).browser };
  assert.equal(await offerFor(cfg, CALLBACK), null, 'no hub sign-in offered: no button');
  forgetOffer();
  xo.offer = { browser: { authorize: 'javascript:alert(1)', clientId: 'cli_1', scope: 'openid' }, hub: { redirect: CALLBACK } };
  assert.equal(await offerFor(cfg, CALLBACK), null, 'an offer that is not an https sign-in is ignored');
  close();
});

test('the xo server down means no button, not an error', async () => {
  const { cfg, close } = await setup();
  close();
  assert.equal(await offerFor({ ...cfg, server: 'http://127.0.0.1:1' }, CALLBACK), null);
});

test('a sign-in: PKCE to Clerk, the code to the xo server, the token from this hub', async () => {
  const { cfg, xo, signIn, close } = await setup();
  const offer = (await offerFor(cfg, CALLBACK))!;
  const { state, location } = startSignIn(offer, '/alice/notes');
  const q = new URL(location).searchParams;
  assert.equal(location.split('?')[0], 'https://clerk.example/oauth/authorize');
  assert.deepEqual(
    [q.get('response_type'), q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('state'), q.get('code_challenge_method')],
    ['code', 'cli_1', CALLBACK, 'openid profile email', state, 'S256']
  );
  assert.ok(state.length >= 43 && !location.includes('verifier'));
  const back = signIn(location);
  const out = await finishSignIn(cfg, { state: back.state, cookie: state, code: back.code, error: null });
  assert.deepEqual(out, { username: 'alice', token: TOKEN, next: '/alice/notes' });
  const [asked] = xo.asked.hub;
  assert.equal(asked.auth, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(asked.body).sort(), ['code', 'redirect', 'verifier']);
  // The state works once.
  await assert.rejects(finishSignIn(cfg, { state: back.state, cookie: state, code: back.code, error: null }), /already used/);
  close();
});

test('the state must come back with the cookie of the browser that started it', async () => {
  const { cfg, xo, signIn, close } = await setup();
  const offer = (await offerFor(cfg, CALLBACK))!;
  const mine = startSignIn(offer, '/');
  const theirs = startSignIn(offer, '/');
  const back = signIn(theirs.location);
  // A link someone else started, opened in my browser: my cookie is not theirs.
  await assert.rejects(finishSignIn(cfg, { state: back.state, cookie: mine.state, code: back.code, error: null }), (e: Reply) => e.status === 400);
  await assert.rejects(finishSignIn(cfg, { state: back.state, cookie: null, code: back.code, error: null }), /not the one this browser started/);
  await assert.rejects(finishSignIn(cfg, { state: null, cookie: mine.state, code: 'c', error: null }), /not the one/);
  assert.equal(xo.asked.hub.length, 0, 'the xo server is never asked');
  close();
});

test('a sign-in runs out after 10 minutes', async () => {
  const { cfg, signIn, close } = await setup();
  const { state, location } = startSignIn((await offerFor(cfg, CALLBACK))!, '/', Date.now() - 11 * 60_000);
  const back = signIn(location);
  await assert.rejects(finishSignIn(cfg, { state: back.state, cookie: state, code: back.code, error: null }), /10 minutes/);
  close();
});

test('a sign-in cancelled at Clerk, or with no code, asks nobody', async () => {
  const { cfg, xo, close } = await setup();
  const offer = (await offerFor(cfg, CALLBACK))!;
  let s = startSignIn(offer, '/').state;
  await assert.rejects(finishSignIn(cfg, { state: s, cookie: s, code: null, error: 'access_denied<script>' }), /not finished \(access_denied\)/);
  s = startSignIn(offer, '/').state;
  await assert.rejects(finishSignIn(cfg, { state: s, cookie: s, code: 'a b', error: null }), /no sign-in code/);
  assert.equal(xo.asked.hub.length, 0);
  close();
});

test('what the xo server refuses is shown as it says it', async () => {
  const { cfg, xo, signIn, close } = await setup();
  const offer = (await offerFor(cfg, CALLBACK))!;
  const run = async () => {
    const { state, location } = startSignIn(offer, '/');
    const back = signIn(location);
    return finishSignIn(cfg, { state: back.state, cookie: state, code: back.code, error: null });
  };
  xo.answer = [409, { success: false, error: 'Your username cannot name a hub agent: it needs 1 to 39 letters, digits or inner hyphens; change it first' }];
  await assert.rejects(run(), (e: Reply) => e.status === 400 && e.message.startsWith('XO: Your username cannot name a hub agent'));
  xo.answer = [502, { success: false, error: 'The hub did not answer' }];
  await assert.rejects(run(), (e: Reply) => e.status === 502 && e.message === 'XO: The hub did not answer');
  xo.answer = [200, { success: true, data: { subject: 'user_alice', agent: 'alice' } }];
  await assert.rejects(run(), /this hub does not have/, 'an agent missing here is not signed in');
  xo.answer = [200, { success: true, data: { subject: "x' OR 1=1", agent: 'alice' } }];
  await assert.rejects(run(), /cannot read/);
  close();
});

test('the xo server down is a 502', async () => {
  const { cfg, signIn, close } = await setup();
  const { state, location } = startSignIn((await offerFor(cfg, CALLBACK))!, '/');
  const back = signIn(location);
  close();
  await assert.rejects(finishSignIn({ ...cfg, server: 'http://127.0.0.1:1' }, { state: back.state, cookie: state, code: back.code, error: null }), (e: Reply) => e.status === 502);
});

test('sign-ins started at once are capped', async () => {
  const { cfg, close } = await setup();
  const offer = (await offerFor(cfg, CALLBACK))!;
  for (let i = 0; i < START_LIMIT; i++) startSignIn(offer, '/');
  assert.throws(() => startSignIn(offer, '/'), (e: Reply) => e.status === 429);
  assert.ok(START_LIMIT <= MAX_PENDING);
  close();
});
