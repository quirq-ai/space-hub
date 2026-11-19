// The private hub's gate (gate.ts), against a stand-in for SpacetimeDB's SQL
// endpoint and tokens signed with a key made here (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Gate, GATE_ROUTE, handleGate, hexOf, loginTarget, MISS_REFRESH_MS, privateBuilders, verifyToken } from '../src/gate.ts';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

const id = (c: string) => c.repeat(64);
const ALICE = id('a'); // signed in with XO
const BOB = id('b'); // signed up with GitHub only
const LEGACY = id('c'); // made by xo before GitHub was needed
const SCOUT = id('d'); // alice's agent
const ROGUE = id('e'); // bob's agent
const ADMIN = id('f');
const CAROL = id('1'); // signs in with XO later

function jwt(identity: string, opts: { exp?: number; key?: KeyObject; alg?: string } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'ES256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ hex_identity: identity, sub: 'x', iss: 'localhost', aud: ['spacetimedb'], iat: 1, ...(opts.exp ? { exp: opts.exp } : {}) })).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: opts.key ?? privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const listen = async (server: http.Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

// SpacetimeDB's SQL endpoint as the admin sees it; `db.carol` adds carol's XO link.
function fakeDb() {
  const db = { carol: false, queries: 0 };
  const table = (names: string[], rows: unknown[][]) => JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]);
  const server = http.createServer(async (req, res) => {
    let q = '';
    for await (const c of req) q += c;
    if (req.headers.authorization !== 'Bearer admin-token') return res.writeHead(401).end();
    db.queries++;
    if (q.includes('FROM user')) {
      return res.end(table(['identity', 'username'], [[[`0x${ALICE}`], 'alice'], [[`0x${BOB}`], 'bob'], [[`0x${LEGACY}`], 'old'], [[`0x${CAROL}`], 'carol']]));
    }
    if (q.includes('FROM xo_link')) return res.end(table(['username'], [['alice'], ...(db.carol ? [['carol']] : [])]));
    if (q.includes('FROM xo_agent')) return res.end(table(['identity', 'username'], [[[`0x${LEGACY}`], 'old']]));
    if (q.includes('FROM agent')) return res.end(table(['identity', 'name', 'created_by'], [[[`0x${SCOUT}`], 'scout', 'alice'], [[`0x${ROGUE}`], 'rogue', 'bob']]));
    if (q.includes('FROM hub_state')) return res.end(table(['value'], [[ADMIN]]));
    res.writeHead(400).end('unknown query');
  });
  return { server, db };
}

async function gateWith(builders: Set<string> | null = null) {
  const { server, db } = fakeDb();
  const http_ = await listen(server);
  const gate = new Gate({ admin: { adminToken: 'admin-token', http: http_, db: 'spacehub' }, builders, publicKey: async () => PEM });
  return { gate, db, close: () => server.close() };
}

test('verifyToken takes only this hub\'s ES256 tokens, unexpired', () => {
  const key = publicKey;
  assert.deepEqual(verifyToken(jwt(ALICE), key), { identity: ALICE, exp: null });
  assert.equal(verifyToken(jwt(ALICE, { key: other }), key), null, 'another key');
  assert.equal(verifyToken(jwt(ALICE, { alg: 'none' }), key), null, 'another alg');
  assert.equal(verifyToken(jwt(ALICE, { exp: 100 }), key, 200_000), null, 'expired');
  assert.equal(verifyToken(jwt(ALICE, { exp: 300 }), key, 200_000)?.identity, ALICE);
  assert.equal(verifyToken('not.a.token', key), null);
  const [h, , s] = jwt(ALICE).split('.');
  const forged = Buffer.from(JSON.stringify({ hex_identity: BOB })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, key), null, 'payload changed after signing');
});

test('XO builders, their agents and the admin get in; others do not', async () => {
  const { gate, close } = await gateWith();
  try {
    assert.equal(await gate.check(jwt(ALICE)), 'alice');
    assert.equal(await gate.check(jwt(LEGACY)), 'old');
    assert.equal(await gate.check(jwt(SCOUT)), 'scout');
    assert.equal(await gate.check(jwt(ADMIN)), '(hub admin)');
    assert.equal(await gate.check(jwt(BOB)), null, 'GitHub-only builder');
    assert.equal(await gate.check(jwt(ROGUE)), null, 'agent of a builder without XO');
    assert.equal(await gate.check(jwt(id('9'))), null, 'anonymous identity');
    assert.equal(await gate.check(jwt(ALICE, { key: other })), null, 'token from another issuer');
  } finally {
    close();
  }
});

test('a fresh XO sign-in gets in at once, without hammering the database', async () => {
  const { gate, db, close } = await gateWith();
  try {
    const t0 = 1_000_000_000_000;
    assert.equal(await gate.check(jwt(CAROL), t0), null);
    const after = db.queries;
    assert.equal(await gate.check(jwt(CAROL), t0 + 10), null, 'no re-read within MISS_REFRESH_MS');
    assert.equal(db.queries, after);
    db.carol = true;
    assert.equal(await gate.check(jwt(CAROL), t0 + MISS_REFRESH_MS), 'carol');
  } finally {
    close();
  }
});

test('SPACEHUB_PRIVATE_BUILDERS narrows the list to those builders and their agents', async () => {
  assert.equal(privateBuilders({}), null);
  assert.deepEqual([...privateBuilders({ SPACEHUB_PRIVATE_BUILDERS: ' Alice, old ' })!], ['alice', 'old']);
  assert.throws(() => privateBuilders({ SPACEHUB_PRIVATE_BUILDERS: 'alice,not a name' }));
  const { gate, close } = await gateWith(new Set(['old']));
  try {
    assert.equal(await gate.check(jwt(ALICE)), null);
    assert.equal(await gate.check(jwt(SCOUT)), null);
    assert.equal(await gate.check(jwt(LEGACY)), 'old');
  } finally {
    close();
  }
});

test('no admin token: the gate cannot tell, so it fails closed', async () => {
  const gate = new Gate({ admin: null, builders: null, publicKey: async () => PEM });
  await assert.rejects(gate.check(jwt(ALICE)));
});

test('hexOf reads SQL identities', () => {
  assert.equal(hexOf([`0x${ALICE.toUpperCase()}`]), ALICE);
  assert.equal(hexOf(ALICE), ALICE);
  assert.equal(hexOf(['0x12']), '');
  assert.equal(hexOf(null), '');
});

test('loginTarget keeps where the visitor was going', () => {
  assert.equal(loginTarget(new URL('http://h/')), '/-/login');
  assert.equal(loginTarget(new URL('http://h/acme/site?view=code')), '/-/login?next=%2Facme%2Fsite%3Fview%3Dcode');
  assert.equal(loginTarget(new URL('http://h/x'), true), '/-/login?next=%2Fx&denied=1');
});

test('GET /-/gate answers forward_auth: 204, 303 for pages, 401 for the rest', async () => {
  const { gate, close } = await gateWith();
  const web = http.createServer((req, res) => {
    handleGate(gate, req, res).then(done => done || res.writeHead(418).end());
  });
  const base = await listen(web);
  const ask = (headers: Record<string, string>) => fetch(`${base}${GATE_ROUTE}`, { headers, redirect: 'manual' });
  try {
    let r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/acme', authorization: `Bearer ${jwt(ALICE)}` });
    assert.equal(r.status, 204);
    r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/acme', cookie: `spacehub_session=${jwt(ALICE)}` });
    assert.equal(r.status, 204);
    r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': `/v1/database/spacehub/subscribe?token=${jwt(SCOUT, { exp: Date.now() / 1000 + 60 })}&compression=None` });
    assert.equal(r.status, 204, 'websocket with its short-lived token');
    r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/acme/site', accept: 'text/html' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/-/login?next=%2Facme%2Fsite');
    r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/acme', accept: 'text/html', cookie: `spacehub_session=${jwt(BOB)}` });
    assert.equal(r.status, 303, 'a GitHub-only session goes back to sign in');
    assert.equal(r.headers.get('location'), '/-/login?next=%2Facme&denied=1');
    assert.match(r.headers.get('set-cookie') ?? '', /spacehub_session=; .*Max-Age=0/);
    r = await ask({ 'x-forwarded-method': 'POST', 'x-forwarded-uri': '/v1/identity/websocket-token' });
    assert.equal(r.status, 401, 'no token: no new anonymous identity');
    r = await ask({ 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/-/api/view', accept: 'text/html', authorization: `Bearer ${jwt(BOB)}` });
    assert.equal(r.status, 401);
    assert.match(await r.text(), /private/);
  } finally {
    web.close();
    close();
  }
});
