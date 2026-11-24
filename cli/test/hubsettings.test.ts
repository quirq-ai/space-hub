// Settings → Hub (the owner's) and the owner and suspension reads behind it (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleHubSettings, INVITE_HOURS, operatorsOf, type HubSettingsDeps } from '../src/hubsettings.ts';
import { hubMembersOnly, hubOwnerName, hubPeople, isSuspended, joinPolicy, joinSettings, type JoinSettings } from '../src/hubowner.ts';

const JOIN: JoinSettings = {
  policy: 'invite',
  allowlist: ['carol'],
  invites: [{ id: '1', createdBy: 'alice', createdAt: 1000, expiresAt: 2000, usedBy: '' }],
};

function listen(server: http.Server) {
  return new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// SpacetimeDB's SQL as the admin: hub_state, github_account and builder_suspension.
async function fakeSql(state: Record<string, string>, accounts: Record<string, string>, suspended: string[], join: { join_rule?: unknown[][]; join_invite?: unknown[][] } = {}) {
  const asked: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    asked.push(body);
    const table = (names: string[], rows: unknown[][]) => res.end(JSON.stringify([{ schema: { elements: names.map(n => ({ name: { some: n } })) }, rows }]));
    const key = /key = '([^']*)'/.exec(body)?.[1];
    if (body.includes('FROM hub_state')) return table(['value'], key && state[key] ? [[state[key]]] : []);
    if (body.includes('FROM join_rule')) return table(['login'], join.join_rule ?? []);
    if (body.includes('FROM join_invite')) return table(['id', 'created_by', 'created_at', 'expires_at', 'used_by'], join.join_invite ?? []);
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
    join: async () => JOIN,
    suspend: async (token, name) => {
      if (name === 'alice') throw new Error("Error: the hub's owner cannot be suspended");
      calls.push(`suspend ${name} as ${token}`);
    },
    restore: async (token, name) => void calls.push(`restore ${name} as ${token}`),
    setJoinPolicy: async (token, policy) => {
      if (!['anyone', 'allowlist', 'invite'].includes(policy)) throw new Error('Error: the join policy is "anyone", "allowlist" or "invite"');
      calls.push(`join ${policy} as ${token}`);
    },
    allow: async (token, login) => void calls.push(`allow ${login} as ${token}`),
    disallow: async (token, login) => void calls.push(`disallow ${login} as ${token}`),
    createInvite: async (token, code, hours) => void calls.push(`invite ${code} ${hours}h as ${token}`),
    revokeInvite: async (token, id) => void calls.push(`revoke ${id} as ${token}`),
    signupUrl: () => 'https://hub.example/-/signup',
    membersOnly: async () => false,
    setMembersOnly: async (token, on) => void calls.push(`members-only ${on} as ${token}`),
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
      membersOnly: false,
      builders: [{ name: 'alice', suspended: false }, { name: 'bob', suspended: false }],
      join: JOIN,
    });
  } finally {
    s.close();
  }
});

test('the owner sets the join policy, edits the allowlist and makes and revokes invites, as itself', async () => {
  const s = await site();
  try {
    assert.deepEqual(await s.ask('/-/api/hub/join', 'tok-alice', { policy: 'invite' }), { status: 200, body: { ok: true } });
    assert.deepEqual(await s.ask('/-/api/hub/allow', 'tok-alice', { login: 'carol' }), { status: 200, body: { ok: true } });
    assert.deepEqual(await s.ask('/-/api/hub/disallow', 'tok-alice', { login: 'carol' }), { status: 200, body: { ok: true } });
    const made = await s.ask('/-/api/hub/invite', 'tok-alice', { hours: 48 });
    assert.equal(made.status, 200);
    const code = String(made.body?.code);
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(made.body?.link, `https://hub.example/-/signup?invite=${code}`);
    const other = await s.ask('/-/api/hub/invite', 'tok-alice', {});
    assert.notEqual(other.body?.code, code, 'every code is new');
    assert.deepEqual(await s.ask('/-/api/hub/revoke', 'tok-alice', { id: '3' }), { status: 200, body: { ok: true } });
    assert.deepEqual(s.calls, [
      'join invite as tok-alice',
      'allow carol as tok-alice',
      'disallow carol as tok-alice',
      `invite ${code} 48h as tok-alice`,
      `invite ${other.body?.code} ${INVITE_HOURS}h as tok-alice`,
      'revoke 3 as tok-alice',
    ]);
    // Bad input, and the module's refusals, come back as 400 with the reason.
    const bad = await s.ask('/-/api/hub/join', 'tok-alice', { policy: 'members' });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body?.error), /"anyone", "allowlist" or "invite"/);
    assert.equal((await s.ask('/-/api/hub/allow', 'tok-alice', {})).status, 400);
    assert.equal((await s.ask('/-/api/hub/invite', 'tok-alice', { hours: 'soon' })).status, 400);
    assert.equal((await s.ask('/-/api/hub/revoke', 'tok-alice', { id: '1 OR 1' })).status, 400);
    assert.equal((await s.ask('/-/api/hub/nothing', 'tok-alice', {})).status, 418, 'not a route');
  } finally {
    s.close();
  }
});

test('nobody but the owner edits who may join', async () => {
  const s = await site();
  try {
    for (const [route, body] of [['join', { policy: 'anyone' }], ['allow', { login: 'bob' }], ['invite', {}], ['revoke', { id: '1' }]] as const) {
      assert.equal((await s.ask(`/-/api/hub/${route}`, 'tok-bob', body)).status, 403, route);
      assert.equal((await s.ask(`/-/api/hub/${route}`, null, body)).status, 401, route);
    }
    assert.deepEqual(s.calls, []);
  } finally {
    s.close();
  }
});

test('the join settings are read from the private tables; codes never leave them', async () => {
  const db = await fakeSql({ join: 'allowlist' }, {}, [], {
    join_rule: [['zed'], ['carol']],
    join_invite: [[2, 'alice', { __timestamp_micros_since_unix_epoch__: 2_000_000 }, { __timestamp_micros_since_unix_epoch__: 9_000_000 }, ''], [1, 'alice', { __timestamp_micros_since_unix_epoch__: 1_000_000 }, [5_000_000], 'carol']],
  });
  try {
    assert.equal(await joinPolicy(db.cfg), 'allowlist');
    assert.deepEqual(await joinSettings(db.cfg), {
      policy: 'allowlist',
      allowlist: ['carol', 'zed'],
      invites: [
        { id: '2', createdBy: 'alice', createdAt: 2000, expiresAt: 9000, usedBy: '' },
        { id: '1', createdBy: 'alice', createdAt: 1000, expiresAt: 5000, usedBy: 'carol' },
      ],
    });
    assert.ok(db.asked.every(q => !/code/.test(q)), 'the code hash is never read');
  } finally {
    db.close();
  }
  for (const [value, policy] of [[undefined, 'anyone'], ['anyone', 'anyone'], ['invite', 'invite'], ['odd', 'anyone']] as const) {
    const one = await fakeSql(value ? { join: value } : {}, {}, []);
    try {
      assert.equal(await joinPolicy(one.cfg), policy, String(value));
    } finally {
      one.close();
    }
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

test('a suspension takes effect at once: the web service is told, only when the module agreed', async () => {
  const told: string[] = [];
  const s = await site({ suspended: name => void told.push(name) });
  try {
    await s.ask('/-/api/hub/suspend', 'tok-alice', { name: 'bob' });
    await s.ask('/-/api/hub/suspend', 'tok-alice', { name: 'alice' }); // refused by the module
    await s.ask('/-/api/hub/suspend', 'tok-bob', { name: 'carol' }); // not the owner
    await s.ask('/-/api/hub/restore', 'tok-alice', { name: 'bob' });
    assert.deepEqual(told, ['bob']);
  } finally {
    s.close();
  }
});

test('the owner switches members-only on and off as itself; nobody else can', async () => {
  const s = await site({ membersOnly: async () => true });
  try {
    assert.equal((await s.ask('/-/api/hub', 'tok-alice')).body?.membersOnly, true);
    assert.deepEqual(await s.ask('/-/api/hub/members-only', 'tok-alice', { on: true }), { status: 200, body: { ok: true } });
    assert.deepEqual(await s.ask('/-/api/hub/members-only', 'tok-alice', { on: false }), { status: 200, body: { ok: true } });
    assert.equal((await s.ask('/-/api/hub/members-only', 'tok-alice', { on: 'yes' })).status, 400);
    assert.equal((await s.ask('/-/api/hub/members-only', 'tok-alice', { name: 'bob' })).status, 400);
    assert.equal((await s.ask('/-/api/hub/members-only', 'tok-bob', { on: false })).status, 403);
    assert.equal((await s.ask('/-/api/hub/members-only', null, { on: false })).status, 401);
    assert.equal((await s.ask('/-/api/hub/members-only', 'tok-alice')).status, 405);
    assert.deepEqual(s.calls, ['members-only true as tok-alice', 'members-only false as tok-alice']);
  } finally {
    s.close();
  }
});

test('members-only is read from hub_state; no row is off', async () => {
  const on = await fakeSql({ membersOnly: 'true' }, {}, []);
  try {
    assert.equal(await hubMembersOnly(on.cfg), true);
  } finally {
    on.close();
  }
  const unset = await fakeSql({}, {}, []);
  try {
    assert.equal(await hubMembersOnly(unset.cfg), false);
  } finally {
    unset.close();
  }
});
