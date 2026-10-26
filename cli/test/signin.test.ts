// GitHub sign-in in front of stand-ins for GitHub's API and SpacetimeDB's HTTP API (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleSignIn, SIGNIN_ROUTE, type SignInConfig } from '../src/signin.ts';

const USERS: Record<string, unknown> = {
  'gh-octo': { login: 'Octocat', id: 583231, type: 'User' },
  'gh-hubot': { login: 'hubot', id: 7, type: 'User' },
  'gh-org': { login: 'acme', id: 9, type: 'Organization' },
};

function listen(server: http.Server) {
  return new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// GitHub: GET /user answers for the tokens above, 401 for any other.
function fakeGithub() {
  return http.createServer((req, res) => {
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
      const b = builders.get(Number(/github_id = (\d+)$/.exec(body)![1]));
      return table(['username', 'token'], b ? [[b.username, b.token]] : []);
    }
    if (req.url === '/v1/database/spacehub/call/github_link_builder') {
      const [id, login, , token] = JSON.parse(body);
      const name = login.toLowerCase();
      if (taken.includes(name)) return res.writeHead(530).end(`the name "${name}" is taken`);
      builders.set(id, { username: name, token });
      return res.end();
    }
    res.writeHead(404).end();
  });
  return { server, accounts, builders, seen, identities: () => identities };
}

async function setup(opts: { taken?: string[]; cfg?: boolean } = {}) {
  const github = fakeGithub();
  const db = fakeDb(opts.taken);
  const cfg: SignInConfig = {
    adminToken: 'admin-token',
    db: 'spacehub',
    http: await listen(db.server),
    github: { base: await listen(github), token: '', standIn: true },
  };
  const web = http.createServer(async (req, res) => {
    if (!(await handleSignIn(opts.cfg === false ? null : cfg, req, res))) res.writeHead(418).end();
  });
  const base = await listen(web);
  const signIn = async (token: string | null, method = 'POST') => {
    const res = await fetch(`${base}${SIGNIN_ROUTE}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const close = () => [github, db.server, web].forEach(s => s.close());
  return { db, signIn, close };
}

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
