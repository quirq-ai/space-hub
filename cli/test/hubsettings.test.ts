// Settings → Hub (the owner's) and the owner and suspension reads behind it (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleHubSettings, operatorsOf, type HubSettingsDeps } from '../src/hubsettings.ts';
import { hubOwnerName, hubPeople, isSuspended } from '../src/hubowner.ts';

function listen(server: http.Server) {
  return new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// SpacetimeDB's SQL as the admin: hub_state, github_account and builder_suspension.
async function fakeSql(state: Record<string, string>, accounts: Record<string, string>, suspended: string[]) {
  const asked: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    asked.push(body);
    const table = (names: string[], rows: unknown[][]) => res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]));
    const key = /key = '([^']*)'/.exec(body)?.[1];
    if (body.includes('FROM hub_state')) return table(['value'], key && state[key] ? [[state[key]]] : []);
    if (body.includes('FROM github_account')) {
      const name = accounts[/github_id = (\d+)/.exec(body)![1]];
      return table(['username'], name ? [[name]] : []);
    }
    const name = /username = '([^']*)'/.exec(body)?.[1];
    return table(['username'], suspended.filter(s => !name || s === name).map(s => [s]));
  });
  const http_ = await listen(server);
  return { cfg: { adminToken: 'admin', http: http_, db: 'spacehub' }, asked, close: () => server.close() };
}

test('the owner is the builder holding the recorded GitHub account; none without a record', async () => {
  const db = await fakeSql({ owner: '4242', owner_login: 'alice' }, { 4242: 'alice' }, []);
  try {
    assert.equal(await hubOwnerName(db.cfg), 'alice');
  } finally {
    db.close();
  }
  const none = await fakeSql({ owner_login: 'alice' }, { 4242: 'alice' }, []);
  try {
    assert.equal(await hubOwnerName(none.cfg), null, 'a builder named after the owner login is not the owner');
  } finally {
    none.close();
  }
  const odd = await fakeSql({ owner: '1 OR 1=1' }, {}, []);
  try {
    assert.equal(await hubOwnerName(odd.cfg), null);
    assert.ok(odd.asked.every(q => !q.includes('github_account')), 'a malformed id never reaches SQL');
  } finally {
    odd.close();
  }
});

test('suspension is read by builder name, and only a valid name is asked', async () => {
  const db = await fakeSql({}, {}, ['bob']);
  try {
    assert.equal(await isSuspended(db.cfg, 'bob'), true);
    assert.equal(await isSuspended(db.cfg, 'alice'), false);
    assert.equal(await isSuspended(db.cfg, "x' OR '1'='1"), false);
    assert.equal(db.asked.length, 2);
    assert.deepEqual(await hubPeople(db.cfg, ['carol', 'bob']), { builders: [{ name: 'bob', suspended: true }, { name: 'carol', suspended: false }] });
  } finally {
    db.close();
  }
});

test('the operators are the owner, always, and the named ones', () => {
  assert.deepEqual(operatorsOf('alice', ['bob', 'alice']), ['alice', 'bob']);
  assert.deepEqual(operatorsOf(null, ['bob']), ['bob']);
});

async function site(over: Partial<HubSettingsDeps> = {}) {
  const calls: string[] = [];
  const sessions: Record<string, string> = { 'tok-alice': 'alice', 'tok-bob': 'bob' };
  const deps: HubSettingsDeps = {
    sessionOf: async req => {
      const token = /spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
      return token && sessions[token] ? { token, username: sessions[token] } : null;
    },
    ownerName: async () => 'alice',
    operators: ['ops'],
    adminFallback: false,
    people: async () => ({ builders: [{ name: 'alice', suspended: false }, { name: 'bob', suspended: false }] }),
    suspend: async (token, name) => {
      if (name === 'alice') throw new Error("Error: the hub's owner cannot be suspended");
      calls.push(`suspend ${name} as ${token}`);
    },
    restore: async (token, name) => void calls.push(`restore ${name} as ${token}`),
    ...over,
  };
  const server = http.createServer(async (req, res) => {
    if (!(await handleHubSettings(deps, req, res, new URL(req.url!, 'http://x')))) res.writeHead(418).end();
  });
  const base = await listen(server);
  const ask = async (route: string, token: string | null, body?: unknown) => {
    const res = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { cookie: `spacehub_session=${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  return { ask, calls, close: () => server.close() };
}

test('the owner sees the hub: its operators and its builders', async () => {
  const s = await site();
  try {
    const got = await s.ask('/-/api/hub', 'tok-alice');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      owner: 'alice',
      operators: ['alice', 'ops'],
      adminFallback: false,
      builders: [{ name: 'alice', suspended: false }, { name: 'bob', suspended: false }],
    });
  } finally {
    s.close();
  }
});

test('nobody else does: signed out 401, another builder 403, a hub without an owner 403', async () => {
  const s = await site();
  try {
    assert.equal((await s.ask('/-/api/hub', null)).status, 401);
    assert.equal((await s.ask('/-/api/hub', 'tok-bob')).status, 403);
    assert.equal((await s.ask('/-/api/hub/suspend', 'tok-bob', { name: 'alice' })).status, 403);
    assert.deepEqual(s.calls, []);
  } finally {
    s.close();
  }
  const none = await site({ ownerName: async () => null });
  try {
    assert.equal((await none.ask('/-/api/hub', 'tok-alice')).status, 403);
  } finally {
    none.close();
  }
});

test('the owner suspends and restores builders as itself; the module has the last word', async () => {
  const s = await site();
  try {
    assert.deepEqual(await s.ask('/-/api/hub/suspend', 'tok-alice', { name: 'bob' }), { status: 200, body: { ok: true } });
    assert.deepEqual(await s.ask('/-/api/hub/restore', 'tok-alice', { name: 'bob' }), { status: 200, body: { ok: true } });
    assert.deepEqual(s.calls, ['suspend bob as tok-alice', 'restore bob as tok-alice']);
    const self = await s.ask('/-/api/hub/suspend', 'tok-alice', { name: 'alice' });
    assert.equal(self.status, 400);
    assert.match(String(self.body?.error), /cannot be suspended/);
    assert.equal((await s.ask('/-/api/hub/suspend', 'tok-alice', {})).status, 400);
    assert.equal((await s.ask('/-/api/hub/suspend', 'tok-alice')).status, 405);
  } finally {
    s.close();
  }
});
