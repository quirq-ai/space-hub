// Sign in to the website with GitHub, against stand-ins for github.com, its
// API and SpacetimeDB's HTTP API (npm test).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Reply } from '../src/admin.ts';
import { finishSignIn, resetGithubSignIns, startSignIn, START_LIMIT } from '../src/githubsignin.ts';
import type { SignInConfig } from '../src/signin.ts';

const APP = { clientId: 'Iv1.hubapp', clientSecret: 'hub-secret' };
const CALLBACK = 'https://hub.example/-/login/github/callback';

const listen = async (server: http.Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

// github.com and its API in one: codes[code] = the PKCE challenge the browser
// was sent with; the swap needs the app's secret, the verifier and the same
// redirect, and answers a token the app can ask about.
function fakeGithub() {
  const state = { codes: new Map<string, string>(), swaps: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/login/oauth/access_token') {
      state.swaps++;
      const form = new URLSearchParams(body);
      const challenge = state.codes.get(form.get('code') ?? '');
      state.codes.delete(form.get('code') ?? '');
      const proof = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (form.get('client_id') !== APP.clientId || form.get('client_secret') !== APP.clientSecret) return res.end('{"error": "incorrect_client_credentials"}');
      if (!challenge || challenge !== proof || form.get('redirect_uri') !== CALLBACK) return res.end('{"error": "bad_verification_code", "error_description": "The code passed is incorrect or expired."}');
      return res.end(JSON.stringify({ access_token: 'app-octo', token_type: 'bearer', scope: '' }));
    }
    if (req.url === `/applications/${APP.clientId}/token`) {
      const basic = `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== basic || JSON.parse(body).access_token !== 'app-octo') return res.writeHead(404).end('{}');
      return res.end(JSON.stringify({ user: { login: 'Octocat', id: 583231, type: 'User' } }));
    }
    res.writeHead(404).end('{}');
  });
  return { server, state };
}

// SpacetimeDB: hub_state, github_account and the reducer that makes a builder.
function fakeDb() {
  const builders = new Map<number, { username: string; token: string }>();
  let identities = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.headers.authorization !== 'Bearer admin-token') return res.writeHead(401).end('no');
    const table = (names: string[], rows: unknown[][]) => res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]));
    if (req.url === '/v1/identity') return res.end(JSON.stringify({ identity: `${++identities}`.padStart(64, '0'), token: `hub-${identities}` }));
    if (req.url === '/v1/database/spacehub/sql') {
      if (body.includes('FROM hub_state')) return table(['value'], []);
      const b = builders.get(Number(/github_id = (\d+)$/.exec(body)![1]));
      return table(['username', 'token'], b ? [[b.username, b.token]] : []);
    }
    if (req.url === '/v1/database/spacehub/call/github_link_builder') {
      const [id, login, , token] = JSON.parse(body);
      builders.set(id, { username: login.toLowerCase(), token });
      return res.end();
    }
    res.writeHead(404).end();
  });
  return { server, builders };
}

let github: ReturnType<typeof fakeGithub>;
let db: ReturnType<typeof fakeDb>;
let cfg: SignInConfig;

beforeEach(async () => {
  resetGithubSignIns();
  github?.server.close();
  db?.server.close();
  github = fakeGithub();
  db = fakeDb();
  const gh = await listen(github.server);
  cfg = { adminToken: 'admin-token', http: await listen(db.server), db: 'spacehub', github: { base: gh, token: '', standIn: true }, app: APP, web: gh };
});

// The browser's trip to GitHub and back: GitHub sends it back with a code
// for the challenge it was sent with.
function approve(location: string) {
  const u = new URL(location);
  const code = `code-${github.state.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
  github.state.codes.set(code, u.searchParams.get('code_challenge')!);
  return code;
}

test('the trip to GitHub: the app, this callback, a state and a PKCE challenge, and no scopes', () => {
  const { state, location } = startSignIn(cfg, CALLBACK, '/quirq');
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, `${cfg.web}/login/oauth/authorize`);
  assert.equal(u.searchParams.get('client_id'), APP.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), null);
  assert.ok(!location.includes(APP.clientSecret));
  assert.throws(() => startSignIn({ ...cfg, app: undefined }, CALLBACK, '/'), (e: Reply) => e.status === 404);
});

test('back from GitHub: makes the builder once, then signs in as it', async () => {
  const first = startSignIn(cfg, CALLBACK, '/quirq');
  const out = await finishSignIn(cfg, { state: first.state, cookie: first.state, code: approve(first.location), error: null });
  assert.deepEqual(out, { username: 'octocat', token: 'hub-1', next: '/quirq', created: true });
  const again = startSignIn(cfg, CALLBACK, '/');
  const back = await finishSignIn(cfg, { state: again.state, cookie: again.state, code: approve(again.location), error: null });
  assert.deepEqual(back, { username: 'octocat', token: 'hub-1', next: '/', created: false });
  assert.equal(db.builders.size, 1);
});

test('another browser, a used state, a cancel or a bad code are refused', async () => {
  const s = startSignIn(cfg, CALLBACK, '/');
  const code = approve(s.location);
  await assert.rejects(finishSignIn(cfg, { state: s.state, cookie: 'someone-else', code, error: null }), /not the one this browser started/);
  // The state is spent by the first try, right or wrong.
  const t = startSignIn(cfg, CALLBACK, '/');
  await finishSignIn(cfg, { state: t.state, cookie: t.state, code: approve(t.location), error: null });
  await assert.rejects(finishSignIn(cfg, { state: t.state, cookie: t.state, code: 'x', error: null }), /already used/);
  const u = startSignIn(cfg, CALLBACK, '/');
  await assert.rejects(finishSignIn(cfg, { state: u.state, cookie: u.state, code: null, error: 'access_denied' }), /cancelled on GitHub/);
  const v = startSignIn(cfg, CALLBACK, '/');
  await assert.rejects(finishSignIn(cfg, { state: v.state, cookie: v.state, code: 'not-from-github', error: null }), (e: Reply) => e.status === 502 && /incorrect or expired/.test(e.message));
  const w = startSignIn(cfg, CALLBACK, '/', 0);
  await assert.rejects(finishSignIn(cfg, { state: w.state, cookie: w.state, code: approve(w.location), error: null }), /more than 10 minutes/);
});

test('sign-ins started a minute are capped', () => {
  for (let i = 0; i < START_LIMIT; i++) startSignIn(cfg, CALLBACK, '/', 1_000);
  assert.throws(() => startSignIn(cfg, CALLBACK, '/', 1_000), (e: Reply) => e.status === 429);
  github.server.close();
  db.server.close();
});
