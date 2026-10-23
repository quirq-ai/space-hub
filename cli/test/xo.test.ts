// The xo API in front of a stand-in for SpacetimeDB's HTTP API (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleXo, type XoConfig } from '../src/xo.ts';

const KEY = 'k'.repeat(40);
const SUBJECT = 'user_2abc';

// A tiny SpacetimeDB: xo_record and xo_agent rows, the two reducers, /v1/identity.
function fakeDb() {
  const records = new Map<string, { doc: string; version: number }>();
  const agents = new Map<string, { username: string; token: string }>();
  const seen: { path: string; auth: string | undefined; body: string }[] = [];
  let identities = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ path: req.url!, auth: req.headers.authorization, body });
    if (req.headers.authorization !== 'Bearer admin-token') return res.writeHead(401).end('no');
    const table = (names: string[], rows: unknown[][]) =>
      res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]));
    if (req.url === '/v1/identity') return res.end(JSON.stringify({ identity: `${++identities}`.padStart(64, '0'), token: `tok-${identities}` }));
    if (req.url === '/v1/database/spacehub/sql') {
      const subject = /subject = '([^']*)'/.exec(body)![1];
      if (body.includes('FROM xo_record')) {
        const r = records.get(subject);
        return table(['doc', 'version'], r ? [[r.doc, r.version]] : []);
      }
      const a = agents.get(subject);
      return table(['username', 'token'], a ? [[a.username, a.token]] : []);
    }
    const args = JSON.parse(body || '[]');
    if (req.url === '/v1/database/spacehub/call/xo_put_record') {
      const [subject, version, doc] = args;
      const at = records.get(subject)?.version ?? 0;
      if (at !== version) return res.writeHead(530).end(`stale: the record of ${subject} is at version ${at}`);
      records.set(subject, { doc, version: at + 1 });
      return res.end();
    }
    if (req.url === '/v1/database/spacehub/call/xo_link_agent') {
      const [subject, username, , token] = args;
      if ([...agents.values()].some(a => a.username === username)) return res.writeHead(530).end(`agent name "${username}" is taken`);
      agents.set(subject, { username, token });
      return res.end();
    }
    res.writeHead(404).end();
  });
  return { server, records, agents, seen };
}

async function setup() {
  const db = fakeDb();
  await new Promise<void>(r => db.server.listen(0, '127.0.0.1', r));
  const cfg: XoConfig = { key: KEY, adminToken: 'admin-token', db: 'spacehub', http: `http://127.0.0.1:${(db.server.address() as AddressInfo).port}` };
  const web = http.createServer(async (req, res) => {
    if (!(await handleXo(cfg, req, res))) res.writeHead(418).end();
  });
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}/-/api/xo/v1/`;
  const ask = async (method: string, path: string, body?: unknown, key = KEY) => {
    const resp = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: resp.status, body: await resp.json() };
  };
  const close = () => { web.close(); db.server.close(); };
  return { db, ask, close, cfg };
}

test('a wrong or missing key is refused before the database is asked', async () => {
  const { db, ask, close } = await setup();
  assert.equal((await ask('GET', `records/${SUBJECT}`, undefined, 'wrong')).status, 401);
  assert.equal(db.seen.length, 0);
  close();
});

test('records: empty, then compare-and-swap writes', async () => {
  const { ask, close } = await setup();
  assert.deepEqual(await ask('GET', `records/${SUBJECT}`), { status: 200, body: { version: 0, doc: null } });
  assert.deepEqual(await ask('PUT', `records/${SUBJECT}`, { version: 0, doc: { projects: ['a'] } }), { status: 200, body: { version: 1 } });
  assert.deepEqual(await ask('GET', `records/${SUBJECT}`), { status: 200, body: { version: 1, doc: { projects: ['a'] } } });
  const stale = await ask('PUT', `records/${SUBJECT}`, { version: 0, doc: {} });
  assert.equal(stale.status, 409);
  assert.equal((await ask('PUT', `records/${SUBJECT}`, { version: 1, doc: [] })).status, 400);
  close();
});

test('ids that could reach SQL are refused', async () => {
  const { db, ask, close } = await setup();
  assert.equal((await ask('GET', `records/${encodeURIComponent("x' OR '1'='1")}`)).status, 400);
  assert.equal(db.seen.length, 0);
  close();
});

test('agents: made once, the same token after', async () => {
  const { db, ask, close } = await setup();
  const first = await ask('POST', `agents/${SUBJECT}`, { username: 'suraj' });
  assert.deepEqual(first, { status: 200, body: { agent: 'suraj', token: 'tok-1' } });
  assert.deepEqual(await ask('POST', `agents/${SUBJECT}`, { username: 'suraj' }), first);
  const taken = await ask('POST', 'agents/user_other', { username: 'suraj' });
  assert.equal(taken.status, 409);
  assert.ok(db.seen.every(s => s.auth === 'Bearer admin-token'));
  close();
});

test('other paths are not the xo API', async () => {
  const { close, cfg } = await setup();
  const res = { writeHead() { throw new Error('answered'); } } as unknown as http.ServerResponse;
  assert.equal(await handleXo(cfg, { url: '/-/login' } as http.IncomingMessage, res), false);
  assert.equal(await handleXo(null, { url: '/-/api/xo/v1/records/a' } as http.IncomingMessage, res), false);
  close();
});
