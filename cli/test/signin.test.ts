// GitHub sign-in in front of stand-ins for GitHub's API and SpacetimeDB's HTTP API (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEVICE_ROUTE,
  handleSignIn,
  oauthApp,
  POLL_ROUTE,
  resetDeviceSignIns,
  resetSignInLimit,
  SIGNIN_LIMIT,
  SIGNIN_ROUTE,
  skipDeviceWaits,
  type SignInConfig,
} from '../src/signin.ts';

const USERS: Record<string, unknown> = {
  'gh-octo': { login: 'Octocat', id: 583231, type: 'User' },
  'gh-hubot': { login: 'hubot', id: 7, type: 'User' },
  'gh-org': { login: 'acme', id: 9, type: 'Organization' },
};

function listen(server: http.Server) {
  return new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// Tokens the hub's OAuth App made (the device flow); GitHub answers for these
// only when asked as that app.
const APP_TOKENS: Record<string, unknown> = {
  'app-octo': { login: 'Octocat', id: 583231, type: 'User' },
  'app-org': { login: 'acme', id: 9, type: 'Organization' },
};
const APP = { clientId: 'Iv1.hubapp', clientSecret: 'hub-secret' };

// What github.com answers the device code's next poll with (pending while empty).
const device: { next: Record<string, unknown>; polls: number } = { next: {}, polls: 0 };

// GitHub: GET /user answers for the tokens above, 401 for any other;
// POST /applications/<id>/token answers for APP_TOKENS when asked as APP;
// and github.com's two device flow endpoints, served here too.
function fakeGithub() {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/login/device/code') {
      const form = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      if (form.get('client_id') !== APP.clientId || form.get('scope') !== '') return res.end('{"error": "incorrect_client_credentials"}');
      return res.end(JSON.stringify({ device_code: 'dev-secret', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }));
    }
    if (req.url === '/login/oauth/access_token') {
      device.polls++;
      res.setHeader('content-type', 'application/json');
      if (new URLSearchParams(body).get('device_code') !== 'dev-secret') return res.end('{"error": "incorrect_device_code"}');
      return res.end(JSON.stringify(Object.keys(device.next).length ? device.next : { error: 'authorization_pending' }));
    }
    if (req.url === `/applications/${APP.clientId}/token`) {
      const basic = `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`;
      if (req.method !== 'POST' || req.headers.authorization !== basic) return res.writeHead(401).end('{"message": "Bad credentials"}');
      const user = APP_TOKENS[JSON.parse(body).access_token];
      if (!user) return res.writeHead(404).end('{"message": "Not Found"}');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ user }));
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const user = req.url === '/user' ? USERS[token] : undefined;
    if (!user) return res.writeHead(401).end('{"message": "Bad credentials"}');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(user));
  });
}

// SpacetimeDB: hub_state's accounts, github_account rows, the reducer, /v1/identity.
function fakeDb(taken: string[] = []) {
  const accounts: { value: string | null } = { value: null };
  const builders = new Map<number, { username: string; token: string }>();
  const seen: string[] = [];
  const suspended: string[] = [];
  const signedIn: unknown[] = [];
  let identities = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push(`${req.headers.authorization} ${req.url} ${body}`);
    if (req.headers.authorization !== 'Bearer admin-token') return res.writeHead(401).end('no');
    const table = (names: string[], rows: unknown[][]) =>
      res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]));
    if (req.url === '/v1/identity') return res.end(JSON.stringify({ identity: `${++identities}`.padStart(64, '0'), token: `hub-${identities}` }));
    if (req.url === '/v1/database/spacehub/sql') {
      if (body.includes('FROM hub_state')) return table(['value'], accounts.value ? [[accounts.value]] : []);
      if (body.includes('FROM builder_suspension')) {
        const name = /username = '([^']*)'/.exec(body)?.[1];
        return table(['username'], suspended.filter(s => !name || s === name).map(s => [s]));
      }
      const b = builders.get(Number(/github_id = (\d+)$/.exec(body)![1]));
      return table(['username', 'token'], b ? [[b.username, b.token]] : []);
    }
    if (req.url === '/v1/database/spacehub/call/github_signed_in') {
      signedIn.push(JSON.parse(body));
      return res.end();
    }
    const link = /^\/v1\/database\/spacehub\/call\/(github_link_builder(?:_with_invite)?)$/.exec(req.url ?? '');
    if (link) {
      const [id, login, , token, invite] = JSON.parse(body);
      const name = login.toLowerCase();
      if (taken.includes(name)) return res.writeHead(530).end(`the name "${name}" is taken`);
      // The module's join gate (mayJoin), as an invite-only hub with one good code.
      if (gate.inviteOnly) {
        if (link[1] === 'github_link_builder') return res.writeHead(530).end("Error: not allowed to join this hub: it is invite-only; ask the hub's owner for an invite code (spacehub auth login --invite <code>)");
        if (invite !== gate.code || !gate.code) return res.writeHead(530).end("Error: not allowed to join this hub: that invite code is not valid here; ask the hub's owner for a new one");
        gate.used.push(invite);
        gate.code = '';
      }
      builders.set(id, { username: name, token });
      return res.end();
    }
    res.writeHead(404).end();
  });
  const gate = { inviteOnly: false, code: '', used: [] as string[] };
  return { server, accounts, builders, seen, suspended, signedIn, gate, identities: () => identities };
}

async function setup(opts: { taken?: string[]; cfg?: boolean; app?: SignInConfig['app'] } = {}) {
  resetSignInLimit();
  resetDeviceSignIns();
  Object.assign(device, { next: {}, polls: 0 });
  const github = fakeGithub();
  const db = fakeDb(opts.taken);
  const gh = await listen(github);
  const cfg: SignInConfig = {
    adminToken: 'admin-token',
    db: 'spacehub',
    http: await listen(db.server),
    github: { base: gh, token: '', standIn: true },
    ...(opts.app ? { app: opts.app, web: gh } : {}),
  };
  const web = http.createServer(async (req, res) => {
    if (!(await handleSignIn(opts.cfg === false ? null : cfg, req, res))) res.writeHead(418).end();
  });
  const base = await listen(web);
  const signIn = async (token: string | null, method = 'POST') => {
    const res = await fetch(`${base}${SIGNIN_ROUTE}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const start = (body?: unknown) => post(DEVICE_ROUTE, body);
  const poll = (session: unknown) => post(POLL_ROUTE, { session });
  // The token route with an invite code, as spacehub auth login --invite sends it.
  const signInInvited = async (token: string, invite: string) => {
    const res = await fetch(`${base}${SIGNIN_ROUTE}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ invite }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const close = () => [github, db.server, web].forEach(s => s.close());
  return { db, signIn, signInInvited, start, poll, close };
}

test('an invite-only hub refuses a sign-up without a code, with the reason, and takes a good code once', async () => {
  const { db, signIn, signInInvited, close } = await setup();
  try {
    db.gate.inviteOnly = true;
    db.gate.code = 'good-code-0123456789';
    const refused = await signIn('gh-octo');
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /^not allowed to join this hub: it is invite-only/);
    assert.equal(refused.body.token, undefined);
    const bad = await signInInvited('gh-octo', 'wrong-code-0123456789');
    assert.equal(bad.status, 403);
    assert.match(String(bad.body.error), /invite code is not valid here/);
    const good = await signInInvited('gh-octo', ' good-code-0123456789 ');
    assert.equal(good.status, 200);
    assert.equal(good.body.created, true);
    assert.deepEqual(db.gate.used, ['good-code-0123456789']);
    // Signing in again needs no code: the builder exists.
    assert.equal((await signIn('gh-octo')).status, 200);
    assert.equal((await signInInvited('gh-hubot', 'good-code-0123456789')).status, 403, 'used once');
  } finally {
    close();
  }
});

test('a hub that lets anyone in signs up as before: the reducer without a code', async () => {
  const { db, signIn, close } = await setup();
  try {
    assert.equal((await signIn('gh-octo')).status, 200);
    assert.ok(db.seen.some(line => line.includes('/call/github_link_builder ')));
    assert.ok(db.seen.every(line => !line.includes('with_invite')));
  } finally {
    close();
  }
});

test('the device flow carries the invite code from its start to the sign-up', async () => {
  const { db, start, poll, close } = await setup({ app: APP });
  try {
    db.gate.inviteOnly = true;
    db.gate.code = 'good-code-0123456789';
    const { session } = (await start({ invite: 'good-code-0123456789' })).body;
    device.next = { access_token: 'app-octo' };
    skipDeviceWaits();
    const done = await poll(session);
    assert.equal(done.status, 200);
    assert.equal(done.body.created, true);
    assert.deepEqual(db.gate.used, ['good-code-0123456789']);
    // Without one, the hub's reason comes back.
    db.builders.clear();
    const { session: other } = (await start()).body;
    skipDeviceWaits();
    const refused = await poll(other);
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /invite-only/);
  } finally {
    close();
  }
});

test('the first sign-in makes the builder; later ones get the same token back', async () => {
  const { db, signIn, close } = await setup();
  try {
    assert.deepEqual(await signIn('gh-octo'), { status: 200, body: { builder: 'octocat', token: 'hub-1', created: true } });
    assert.deepEqual(await signIn('gh-octo'), { status: 200, body: { builder: 'octocat', token: 'hub-1', created: false } });
    assert.equal(db.identities(), 1);
    // The GitHub token never reaches the database.
    assert.ok(db.seen.every(line => !line.includes('gh-octo')));
  } finally {
    close();
  }
});

test('a returning sign-in is noted (it may be the hub owner\'s); a suspended builder is refused', async () => {
  const { db, signIn, close } = await setup();
  try {
    await signIn('gh-octo');
    assert.deepEqual(db.signedIn, [], 'a new builder is noted by github_link_builder itself');
    assert.equal((await signIn('gh-octo')).status, 200);
    assert.deepEqual(db.signedIn, [[583231, 'Octocat']]);
    db.suspended.push('octocat');
    const refused = await signIn('gh-octo');
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /octocat is suspended/);
    assert.equal(refused.body.token, undefined);
  } finally {
    close();
  }
});

test('only a GitHub user account with a valid token signs in', async () => {
  const { db, signIn, close } = await setup();
  try {
    assert.equal((await signIn('nope')).status, 401);
    assert.match(String((await signIn('nope')).body.error), /gh auth login/);
    assert.equal((await signIn(null)).status, 401);
    const org = await signIn('gh-org');
    assert.equal(org.status, 403);
    assert.match(String(org.body.error), /not a GitHub user account/);
    assert.equal((await signIn('gh-octo', 'GET')).status, 405);
    assert.equal(db.identities(), 0);
  } finally {
    close();
  }
});

test('a name taken on the hub, or builders from xo, refuse the sign-up', async () => {
  const { db, signIn, close } = await setup({ taken: ['hubot'] });
  try {
    const taken = await signIn('gh-hubot');
    assert.equal(taken.status, 409);
    assert.match(String(taken.body.error), /cannot sign up hubot: the name "hubot" is taken/);
    db.accounts.value = 'xo';
    const xo = await signIn('gh-octo');
    assert.equal(xo.status, 403);
    assert.match(String(xo.body.error), /made by xo/);
  } finally {
    close();
  }
});

test('without the admin there is no sign-in', async () => {
  const { signIn, close } = await setup({ cfg: false });
  try {
    assert.equal((await signIn('gh-octo')).status, 503);
  } finally {
    close();
  }
});

test('sign-ins are limited per minute, so the route cannot be used in bulk', async () => {
  const { signIn, close } = await setup();
  try {
    for (let i = 0; i < SIGNIN_LIMIT; i++) assert.notEqual((await signIn('bad-token')).status, 429);
    const over = await signIn('gh-octo');
    assert.equal(over.status, 429);
    assert.match(String(over.body.error), /too many sign-ins/);
  } finally {
    close();
  }
});

test('with an OAuth App the hub runs the device flow, and the token never leaves it', async () => {
  const { db, start, poll, close } = await setup({ app: APP });
  try {
    const begun = await start();
    assert.equal(begun.status, 200);
    const { session, ...shown } = begun.body;
    assert.deepEqual(shown, { user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
    assert.equal(typeof session, 'string');
    // The device code GitHub is polled with stays on the hub.
    assert.ok(!JSON.stringify(begun.body).includes('dev-secret'));
    // Polled faster than GitHub's interval: answered without asking GitHub.
    assert.deepEqual(await poll(session), { status: 200, body: { status: 'pending', interval: 5 } });
    assert.equal(device.polls, 0);
    skipDeviceWaits();
    assert.deepEqual(await poll(session), { status: 200, body: { status: 'pending', interval: 5 } });
    assert.equal(device.polls, 1);
    device.next = { access_token: 'app-octo' };
    skipDeviceWaits();
    assert.deepEqual(await poll(session), { status: 200, body: { status: 'done', builder: 'octocat', token: 'hub-1', created: true } });
    // Done once: the session is gone.
    assert.equal((await poll(session)).status, 410);
    assert.ok(db.seen.every(line => !line.includes('app-octo') && !line.includes(APP.clientSecret)));
  } finally {
    close();
  }
});

test('with an OAuth App a GitHub token sent to the hub is refused, so none can be replayed here', async () => {
  const { db, signIn, close } = await setup({ app: APP });
  try {
    for (const token of ['gh-octo', 'app-octo']) {
      const res = await signIn(token);
      assert.equal(res.status, 403);
      assert.match(String(res.body.error), /code from GitHub, not a token/);
    }
    assert.equal(db.identities(), 0);
  } finally {
    close();
  }
});

test('a device sign-in ends on a no, a code that ran out, an unknown session or an organization', async () => {
  const { db, start, poll, close } = await setup({ app: APP });
  try {
    assert.equal((await poll('made-up')).status, 410);
    assert.equal((await poll(42)).status, 410);
    const cases: [Record<string, unknown>, number][] = [
      [{ error: 'access_denied' }, 403],
      [{ error: 'expired_token' }, 410],
      [{ access_token: 'app-org' }, 403],
      [{ error: 'unsupported_grant_type' }, 502],
    ];
    for (const [answer, status] of cases) {
      const { session } = (await start()).body;
      device.next = answer;
      skipDeviceWaits();
      assert.equal((await poll(session)).status, status, JSON.stringify(answer));
    }
    // slow_down raises the wait to what GitHub asks for.
    const { session } = (await start()).body;
    device.next = { error: 'slow_down', interval: 10 };
    skipDeviceWaits();
    assert.deepEqual((await poll(session)).body, { status: 'pending', interval: 10 });
    assert.equal(db.identities(), 0);
  } finally {
    close();
  }
});

test('a wrong client secret is the hub\'s fault, not the person\'s', async () => {
  const { start, poll, close } = await setup({ app: { ...APP, clientSecret: 'wrong' } });
  try {
    const { session } = (await start()).body;
    device.next = { access_token: 'app-octo' };
    skipDeviceWaits();
    const res = await poll(session);
    assert.equal(res.status, 502);
    assert.match(String(res.body.error), /OAuth App/);
  } finally {
    close();
  }
});

test('a hub without an OAuth App answers 404 to the device flow, and the client id and secret go together', async () => {
  for (const opts of [{}, { cfg: false }]) {
    const { start, poll, close } = await setup(opts);
    try {
      assert.equal((await start()).status, 404);
      assert.equal((await poll('x')).status, 404);
    } finally {
      close();
    }
  }
  assert.equal(oauthApp({}), undefined);
  assert.deepEqual(oauthApp({ SPACEHUB_GITHUB_CLIENT_ID: ' Iv1.x ', SPACEHUB_GITHUB_CLIENT_SECRET: 's' }), { clientId: 'Iv1.x', clientSecret: 's' });
  assert.throws(() => oauthApp({ SPACEHUB_GITHUB_CLIENT_ID: 'Iv1.x' }), /go together/);
  assert.throws(() => oauthApp({ SPACEHUB_GITHUB_CLIENT_SECRET: 's' }), /go together/);
  assert.throws(() => oauthApp({ SPACEHUB_GITHUB_CLIENT_ID: 'a/b', SPACEHUB_GITHUB_CLIENT_SECRET: 's' }), /go together/);
});
