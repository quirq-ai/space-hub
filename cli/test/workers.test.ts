// Runners and workers through space-hub's routes, in front of stand-in runners that speak worker/1 and scope
// tokens like the Agents Hub (npm test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { handleWorkers, type WorkersDeps } from '../src/workers.ts';
import { memoryStore } from '../src/runnerstore.ts';
import { sealKey } from '../src/seal.ts';

// ---------------------------------------------------------------- a stand-in runner
// Tokens it knows: each sees only the tasks it started (worker/1 §5.2).
// leak: it echoes the caller's token in its name, task titles and results; fixedId: every task gets this id;
// connect: it offers the Connect button (worker/1 §6.3), with approve() standing in for the owner's consent page;
// full: Connect hits the runner's token limit; failTasks: tokens it hands out are refused on /api/tasks.
function fakeRunner(tokens: string[], capabilities: Record<string, boolean> = { followUp: true, stop: true, events: true, repo: true }, opts: { leak?: boolean; fixedId?: string; connect?: boolean; full?: boolean; failTasks?: boolean } = {}) {
  const tasks = new Map<string, { id: string; title: string; status: string; repo: string | null; by: string }>();
  const seen: { method: string; path: string; auth: string }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const revoked: string[] = [];
  let next = 1;
  let describeOnly: string | null = null;            // a token valid for /api/worker but refused on /api/tasks
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const auth = String(req.headers.authorization ?? '');
    seen.push({ method: req.method!, path: req.url!, auth });
    const send = (s: number, v: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const token = auth.replace(/^Bearer /, '');
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/worker' && !auth) return send(200, { protocol: 'worker/1', capabilities: { ...capabilities, connect: !!opts.connect } });
    if (url.pathname === '/api/connect/token' && req.method === 'POST' && opts.connect) {
      const { code, codeVerifier, redirectUri } = JSON.parse(body);
      const c = codes.get(code);
      codes.delete(code);
      const s256 = createHash('sha256').update(String(codeVerifier)).digest('base64url');
      if (!c || c.challenge !== s256 || c.redirect !== redirectUri) return send(400, { error: 'This connection expired or was already used; connect again.' });
      if (opts.full) return send(409, { error: 'You have 10 tokens; revoke one first.' });
      const made = `cn-${randomBytes(6).toString('hex')}`;
      tokens.push(made);
      return send(200, { token: made });
    }
    if (url.pathname === '/api/tokens/self' && req.method === 'DELETE' && tokens.includes(token)) {
      tokens.splice(tokens.indexOf(token), 1);
      revoked.push(token);
      return send(200, { revoked: true });
    }
    if (url.pathname === '/api/worker' && (tokens.includes(token) || token === describeOnly)) {
      return send(200, { protocol: 'worker/1', name: opts.leak ? `A hub ${token}` : 'A hub', kind: 'Agents Hub · OpenAI', capabilities: { ...capabilities, connect: !!opts.connect } });
    }
    if (!tokens.includes(token)) return send(401, { error: `bad token ${token}` });
    if (opts.failTasks) return send(500, { error: 'tasks are broken' });
    const m = /^\/api\/tasks(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'no' });
    const [, id, action] = m;
    if (!id && req.method === 'GET') return send(200, { tasks: [...tasks.values()].filter(t => t.by === token) });
    if (!id && req.method === 'POST') {
      const input = JSON.parse(body);
      const t = { id: opts.fixedId ?? `task-${next++}-${randomBytes(3).toString('hex')}`, title: opts.leak ? `${input.title} ${token}` : input.title, status: 'running', repo: input.repo ?? null, by: token };
      tasks.set(t.id, t);
      return send(201, { task: t, result: { summary: null, links: [], error: null } });
    }
    const t = tasks.get(id!);
    if (!t || t.by !== token) return send(404, { error: 'task not found' });
    if (!action && req.method === 'GET') return send(200, { task: t, result: t.status === 'done' ? { summary: opts.leak ? `Fixed it with ${token}.` : 'Fixed it.', links: ['https://github.com/acme/site/pull/7'], error: opts.leak ? `no ${token}` : null } : { summary: null, links: [], error: null } });
    if (!action && req.method === 'DELETE') return tasks.delete(id!), send(200, { deleted: true });
    if (action === 'events') return send(200, { events: [{ seq: 1, kind: 'user', text: 'go' }], next: 1 });
    if (action === 'stop') return (t.status = 'stopped'), send(202, { ok: true, stopped: true });
    if (action === 'messages') return t.status === 'running' ? send(409, { error: 'The agent is still working.' }) : ((t.status = 'running'), send(202, { ok: true }));
    send(404, { error: 'no' });
  });
  return {
    server, seen, tasks, tokens, revoked,
    // The owner pressed Approve on the runner's /connect page for this request.
    approve: (redirectTo: string) => {
      const u = new URL(redirectTo);
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
      return { code, state: u.searchParams.get('state')! };
    },
    finish: (id: string) => { tasks.get(id)!.status = 'done'; },
    allowDescribeOnly: (token: string) => { describeOnly = token; },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

// ---------------------------------------------------------------- space-hub's routes, with stub people
const hubA = fakeRunner(['tok-priya', 'tok-arjun']);         // one Agents Hub, two people's tokens
const hubB = fakeRunner(['tok-priya-2'], { followUp: false, stop: false, events: false, repo: false });
const hubL = fakeRunner(['c-priya-1', 'c-priya-2'], undefined, { leak: true });
const hubF = fakeRunner(['f-priya', 'f-arjun'], undefined, { fixedId: 'same-1' });
const hubC = fakeRunner([], undefined, { connect: true });      // connects with the button only
const hubFull = fakeRunner([], undefined, { connect: true, full: true });
const hubBroken = fakeRunner([], undefined, { connect: true, failTasks: true });
for (const h of [hubA, hubB, hubL, hubF, hubC, hubFull, hubBroken]) await new Promise<void>(r => h.server.listen(0, '127.0.0.1', r));

const people: Record<string, { spaces: string[]; projects: string[] }> = {
  priya: { spaces: ['priya', 'acme'], projects: [] },
  arjun: { spaces: ['arjun', 'acme'], projects: [] },
  carol: { spaces: ['carol'], projects: ['acme/site'] },       // a collaborator on one project
  outsider: { spaces: ['outsider'], projects: [] },
};
const chats: { who: string; project: string; content: string }[] = [];
const deps: WorkersDeps = {
  sessionOf: async req => {
    const who = /(?:^|;\s*)spacehub_session=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1];
    return who && people[who] ? { token: `session-${who}`, username: who } : null;
  },
  placesOf: async session => people[session.username],
  appendChat: async (session, input) => { chats.push({ who: session.username, project: input.project, content: input.turns[0].content }); },
  sameOrigin: req => req.headers.origin === 'https://hub.test',
  callbackUrl: () => 'https://hub.test/-/runners/connect/callback',
};
const KEY = sealKey({ SPACEHUB_SECRET_KEY: randomBytes(48).toString('base64') });
const store = memoryStore();
const web = http.createServer((req, res) => {
  void handleWorkers({ key: KEY, store, allowLocal: true }, deps, req, res, new URL(req.url!, 'http://hub.test')).then(done => { if (!done) res.writeHead(404).end(); });
});
await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
after(() => { web.close(); for (const h of [hubA, hubB, hubL, hubF, hubC, hubFull, hubBroken]) h.server.close(); });

async function as(who: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(who ? { cookie: `spacehub_session=${who}` } : {}), origin: 'https://hub.test', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, json: (text ? JSON.parse(text) : null) as any };
}
const launch = (who: string, extra: object = {}) =>
  as(who, 'POST', '/-/api/workers', { space: 'acme', project: 'site', conversation: 'Chat/general/chat.json', text: 'Fix the login test', repo: 'acme/site', ...extra });

// ---------------------------------------------------------------- tests (they build on each other, in order)
let priyaRunner = '', arjunRunner = '', taskA = '', leakRunner = '', leakTask = '';

test('connecting a runner checks it, seals the token and never shows it', async () => {
  const bad = await as('priya', 'POST', '/-/api/runners', { url: 'http://hub.example.com', token: 'x' });
  assert.equal(bad.status, 400);
  const wrong = await as('priya', 'POST', '/-/api/runners', { url: hubA.url(), token: 'tok-nobody' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /not valid for this runner/);
  hubA.allowDescribeOnly('tok-describe-only');
  const half = await as('priya', 'POST', '/-/api/runners', { url: hubA.url(), token: 'tok-describe-only' });
  assert.deepEqual([half.status, /not valid for this runner/.test(half.json.error)], [400, true]);

  const ok = await as('priya', 'POST', '/-/api/runners', { url: `${hubA.url()}/`, token: 'tok-priya' });
  assert.equal(ok.status, 201);
  priyaRunner = ok.json.runner.id;
  assert.deepEqual([ok.json.runner.name, ok.json.runner.kind, ok.json.runner.isDefault, ok.json.runner.url], ['A hub', 'Agents Hub · OpenAI', true, hubA.url()]);
  assert.ok(!ok.text.includes('tok-priya'));
  assert.notEqual(await store.sealedTokenOf(priyaRunner), 'tok-priya');
  const listed = await as('priya', 'GET', '/-/api/runners');
  assert.deepEqual(listed.json.runners.map((r: any) => r.id), [priyaRunner]);
  assert.ok(!listed.text.includes('tok-priya'));
  assert.deepEqual((await as('arjun', 'GET', '/-/api/runners')).json.runners, []);
  arjunRunner = (await as('arjun', 'POST', '/-/api/runners', { url: hubA.url(), token: 'tok-arjun' })).json.runner.id;
});

test('only the owner renames, tests or disconnects a runner; a second runner can become the default', async () => {
  assert.equal((await as('arjun', 'PATCH', `/-/api/runners/${priyaRunner}`, { name: 'mine now' })).status, 404);
  assert.equal((await as('priya', 'PATCH', `/-/api/runners/${priyaRunner}`, { name: 'Work hub' })).json.runner.name, 'Work hub');
  assert.equal((await as('priya', 'POST', `/-/api/runners/${priyaRunner}/test`)).status, 200);
  const second = (await as('priya', 'POST', '/-/api/runners', { url: hubB.url(), token: 'tok-priya-2', name: 'Small runner' })).json.runner;
  assert.equal(second.isDefault, false);
  await as('priya', 'PATCH', `/-/api/runners/${second.id}`, { default: true });
  await as('priya', 'PATCH', `/-/api/runners/${priyaRunner}`, { default: true });
  const runners = (await as('priya', 'GET', '/-/api/runners')).json.runners;
  assert.deepEqual(runners.map((r: any) => [r.name, r.isDefault]), [['Work hub', true], ['Small runner', false]]);
});

test('the chat learns who may launch where', async () => {
  const p = (await as('priya', 'GET', '/-/api/workers?space=acme&project=site')).json;
  assert.equal(p.canLaunch, true);
  assert.deepEqual(p.runners.map((r: any) => r.name), ['Work hub', 'Small runner']);
  assert.equal((await as('carol', 'GET', '/-/api/workers?space=acme&project=site')).json.canLaunch, false);   // no runner
  assert.equal((await as('outsider', 'GET', '/-/api/workers?space=acme&project=site')).json.canLaunch, false);
  assert.equal((await as(null, 'GET', '/-/api/workers?space=acme&project=site')).json.canLaunch, false);
});

test('launch runs on the launcher\'s default runner, records the worker, then saves the chat turn', async () => {
  const before = hubA.seen.length;
  const r = await launch('priya');
  assert.equal(r.status, 201);
  taskA = r.json.task.id;
  assert.equal(r.json.saved, true);
  assert.equal(hubA.seen.slice(before).find(s => s.method === 'POST')!.auth, 'Bearer tok-priya');
  const w = await store.getWorker(taskA);
  assert.deepEqual([w!.launcher, w!.space, w!.project, w!.runnerId], ['priya', 'acme', 'site', priyaRunner]);
  assert.match(chats.at(-1)!.content, new RegExp(`<!-- agenthub:task=${taskA} -->$`));
  assert.equal(chats.at(-1)!.who, 'priya');
  assert.equal((await launch('outsider')).status, 403);
  assert.equal((await launch('carol')).status, 409);                        // may write, has no runner
  assert.match((await launch('carol')).json.error, /Connect a runner in Settings/);
});

test('launch on a runner without the repo capability drops the repository', async () => {
  const small = (await as('priya', 'GET', '/-/api/runners')).json.runners.find((r: any) => r.name === 'Small runner');
  const r = await launch('priya', { runner: small.id });
  assert.equal(r.status, 201);
  assert.equal(hubB.tasks.get(r.json.task.id)!.repo, null);
  assert.equal((await launch('arjun', { runner: small.id })).status, 404);     // not arjun's runner
});

test("every member reads a worker with the launcher's token; outsiders cannot", async () => {
  const before = hubA.seen.length;
  const seen = await as('arjun', 'GET', `/-/api/workers/${taskA}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.json.task.id, taskA);
  assert.deepEqual([seen.json.launcher, seen.json.mine, seen.json.runner.kind], ['priya', false, 'Agents Hub · OpenAI']);
  assert.ok(hubA.seen.slice(before).every(s => s.auth === 'Bearer tok-priya'), 'arjun reads it with priya\'s token, not his own');
  assert.equal((await as('carol', 'GET', `/-/api/workers/${taskA}`)).status, 200);   // a collaborator in acme
  assert.equal((await as('outsider', 'GET', `/-/api/workers/${taskA}`)).status, 403);
  assert.equal((await as(null, 'GET', `/-/api/workers/${taskA}`)).status, 401);
  assert.equal((await as('arjun', 'GET', `/-/api/workers/${taskA}/events?after=0`)).json.events.length, 1);
  assert.equal((await as('arjun', 'GET', '/-/api/workers/unknown-task')).status, 404);
});

test('only the launcher follows up, stops or tears down', async () => {
  for (const [method, path] of [['POST', `/-/api/workers/${taskA}/stop`], ['POST', `/-/api/workers/${taskA}/messages`], ['DELETE', `/-/api/workers/${taskA}`]]) {
    const r = await as('arjun', method, path, method === 'POST' ? { text: 'x' } : undefined);
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal((await as('priya', 'POST', `/-/api/workers/${taskA}/stop`)).status, 202);
  assert.equal(hubA.tasks.get(taskA)!.status, 'stopped');
});

test('a finished turn is copied, and the copy stays after tear down', async () => {
  hubA.finish(taskA);
  const done = await as('arjun', 'GET', `/-/api/workers/${taskA}`);
  assert.equal(done.json.result.summary, 'Fixed it.');
  assert.equal((await store.getWorker(taskA))!.result!.summary, 'Fixed it.');
  assert.equal((await as('priya', 'DELETE', `/-/api/workers/${taskA}`)).status, 200);
  const gone = await as('arjun', 'GET', `/-/api/workers/${taskA}`);
  assert.equal(gone.status, 200);
  assert.deepEqual([gone.json.state, gone.json.result.summary, gone.json.result.links], ['gone', 'Fixed it.', ['https://github.com/acme/site/pull/7']]);
});

test('disconnecting shows the copy; reconnecting the same runner links the workers back', async () => {
  const t = (await launch('priya')).json.task.id;
  hubA.finish(t);
  await as('arjun', 'GET', `/-/api/workers/${t}`);                       // copies the result
  assert.equal((await as('priya', 'DELETE', `/-/api/runners/${priyaRunner}`)).status, 200);
  const off = await as('arjun', 'GET', `/-/api/workers/${t}`);
  assert.deepEqual([off.status, off.json.state, off.json.result.summary], [200, 'disconnected', 'Fixed it.']);
  assert.equal((await as('priya', 'POST', `/-/api/workers/${t}/messages`, { text: 'again' })).status, 409);
  const back = (await as('priya', 'POST', '/-/api/runners', { url: hubA.url(), token: 'tok-priya' })).json.runner;
  assert.equal((await store.getWorker(t))!.runnerId, back.id);
  assert.equal((await as('arjun', 'GET', `/-/api/workers/${t}`)).json.state, undefined);
});

test("one hub, two people's tokens: each worker is read with its own launcher's token", async () => {
  const a = (await launch('arjun')).json.task.id;
  const before = hubA.seen.length;
  assert.equal((await as('priya', 'GET', `/-/api/workers/${a}`)).status, 200);
  assert.ok(hubA.seen.slice(before).every(s => s.auth === 'Bearer tok-arjun'));
  assert.ok(arjunRunner);
});

test('a former member cannot steer the worker they launched', async () => {
  const t = (await launch('arjun')).json.task.id;
  people.arjun.spaces = ['arjun'];                                         // removed from acme
  await new Promise(r => setTimeout(r, 0));
  const r = await as('arjun', 'POST', `/-/api/workers/${t}/stop`);
  assert.equal(r.status, 403);
  people.arjun.spaces = ['arjun', 'acme'];
});

test('a runner without stop, follow up or steps refuses them; nothing secret reaches an answer', async () => {
  const small = (await as('priya', 'GET', '/-/api/runners')).json.runners.find((r: any) => r.name === 'Small runner');
  const t = (await launch('priya', { runner: small.id })).json.task.id;
  assert.equal((await as('priya', 'POST', `/-/api/workers/${t}/stop`)).status, 403);
  assert.equal((await as('priya', 'GET', `/-/api/workers/${t}/events?after=0`)).status, 404);
  const all = [await as('priya', 'GET', '/-/api/runners'), await as('priya', 'GET', `/-/api/workers/${t}`), await as('priya', 'GET', '/-/api/workers?mine=1')];
  for (const r of all) assert.ok(!/tok-/.test(r.text), r.text);
});

test('without SPACEHUB_SECRET_KEY, connecting runners is off', async () => {
  const off = http.createServer((req, res) => { void handleWorkers({ key: null, store: memoryStore(), allowLocal: true }, deps, req, res, new URL(req.url!, 'http://hub.test')); });
  await new Promise<void>(r => off.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/-/api/runners`, {
    method: 'POST', headers: { cookie: 'spacehub_session=priya', origin: 'https://hub.test', 'content-type': 'application/json' }, body: JSON.stringify({ url: hubA.url(), token: 'tok-priya' }),
  });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not set up on this hub/);
  off.close();
});

test('a runner that echoes its token: it is taken out of every answer and out of the kept copy', async () => {
  const c = await as('priya', 'POST', '/-/api/runners', { url: hubL.url(), token: 'c-priya-1' });
  assert.equal(c.status, 201);
  assert.ok(!c.text.includes('c-priya-1'), c.text);
  leakRunner = c.json.runner.id;
  const r = await launch('priya', { runner: leakRunner });
  assert.ok(!r.text.includes('c-priya-1'), r.text);
  leakTask = r.json.task.id;
  hubL.finish(leakTask);
  const got = await as('arjun', 'GET', `/-/api/workers/${leakTask}`);
  assert.equal(got.status, 200);
  assert.ok(!got.text.includes('c-priya-1'), got.text);
  assert.ok(!JSON.stringify(await store.getWorker(leakTask)).includes('c-priya-1'));
  assert.ok(!(await as('priya', 'GET', '/-/api/runners')).text.includes('c-priya-1'));
});

test('a worker the connected token cannot see is not forgotten: the right token brings it back', async () => {
  await as('priya', 'DELETE', `/-/api/runners/${leakRunner}`);
  const other = (await as('priya', 'POST', '/-/api/runners', { url: hubL.url(), token: 'c-priya-2' })).json.runner.id;
  const unseen = await as('arjun', 'GET', `/-/api/workers/${leakTask}`);
  assert.equal(unseen.json.state, 'disconnected');
  assert.notEqual((await store.getWorker(leakTask))!.status, 'gone');
  await as('priya', 'DELETE', `/-/api/runners/${other}`);
  await as('priya', 'POST', '/-/api/runners', { url: hubL.url(), token: 'c-priya-1' });
  assert.equal((await as('arjun', 'GET', `/-/api/workers/${leakTask}`)).json.state, undefined);
});

test("a runner that reuses another worker's id is refused; the first worker keeps its launcher", async () => {
  const p = (await as('priya', 'POST', '/-/api/runners', { url: hubF.url(), token: 'f-priya' })).json.runner.id;
  const a = (await as('arjun', 'POST', '/-/api/runners', { url: hubF.url(), token: 'f-arjun' })).json.runner.id;
  assert.equal((await launch('priya', { runner: p })).status, 201);
  const chatsBefore = chats.length;
  const second = await launch('arjun', { runner: a });
  assert.equal(second.status, 502);
  assert.match(second.json.error, /reused/);
  assert.equal(chats.length, chatsBefore);
  assert.equal((await store.getWorker('same-1'))!.launcher, 'priya');
});

// ---------------------------------------------------------------- the Connect button (§6.3)
// The browser's side: space-hub's answer, its Set-Cookie and where it sends the browser next.
async function browse(who: string | null, method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const cookies = [who ? `spacehub_session=${who}` : '', opts.cookie ?? ''].filter(Boolean).join('; ');
  const r = await fetch(`${BASE}${path}`, {
    method, redirect: 'manual',
    headers: { ...(cookies ? { cookie: cookies } : {}), origin: 'https://hub.test', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, location: r.headers.get('location') ?? '', setCookie: r.headers.get('set-cookie') ?? '', json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
}
// Press Connect: the URL it sends the browser to on the runner, and the state cookie it set.
async function pressConnect(who: string, runnerUrl = hubC.url()) {
  const r = await browse(who, 'POST', '/-/api/runners/connect', { body: { url: runnerUrl } });
  assert.equal(r.status, 200, r.text);
  const cookie = /^(spacehub_runner_connect=[^;]+)/.exec(r.setCookie)?.[1] ?? '';
  return { to: r.json.redirect as string, cookie, setCookie: r.setCookie };
}
const callback = (q: Record<string, string>) => `/-/runners/connect/callback?${new URLSearchParams(q)}`;

test('Connect: a runner without the button is told to paste a token', async () => {
  const r = await browse('priya', 'POST', '/-/api/runners/connect', { body: { url: hubA.url() } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /paste/i);
  assert.equal((await browse(null, 'POST', '/-/api/runners/connect', { body: { url: hubC.url() } })).status, 401);
});

test('Connect end to end: to the runner and back, connected, with no token in any URL, cookie or answer', async () => {
  const { to, cookie, setCookie } = await pressConnect('priya');
  const u = new URL(to);
  assert.equal(`${u.origin}${u.pathname}`, `${hubC.url()}/connect`);
  assert.deepEqual([u.searchParams.get('client'), u.searchParams.get('redirect_uri'), u.searchParams.get('code_challenge_method')],
    ['https://hub.test', 'https://hub.test/-/runners/connect/callback', 'S256']);
  assert.match(u.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/-\/runners\/connect/);

  const { code, state } = hubC.approve(to);
  const back = await browse('priya', 'GET', callback({ code, state }), { cookie });
  assert.equal(back.status, 303);
  assert.equal(back.location, '/?runner=connected#/settings');
  assert.match(back.setCookie, /spacehub_runner_connect=;.*Max-Age=0/);
  const made = hubC.tokens.at(-1)!;
  const listed = await as('priya', 'GET', '/-/api/runners');
  const r = listed.json.runners.find((x: any) => x.url === hubC.url());
  assert.ok(r, 'the runner is connected');
  assert.equal(r.name, 'A hub');
  for (const text of [listed.text, back.location, back.setCookie, back.text, to]) assert.ok(!text.includes(made), 'the token never leaves the server');
  assert.equal((await launch('priya', { runner: r.id })).status, 201, 'and it launches workers');
});

test('Connect refuses a callback that is not this browser’s, not this builder’s, used twice or cancelled', async () => {
  const a = await pressConnect('priya');
  const ga = hubC.approve(a.to);
  // Another builder finishing priya's connection.
  assert.equal((await browse('arjun', 'GET', callback(ga), { cookie: a.cookie })).location, '/?runner=failed#/settings');
  // The connection is used up by that attempt.
  assert.equal((await browse('priya', 'GET', callback(ga), { cookie: a.cookie })).location, '/?runner=expired#/settings');

  const b = await pressConnect('priya');
  const gb = hubC.approve(b.to);
  // Without this browser's cookie, or with another state.
  assert.equal((await browse('priya', 'GET', callback(gb))).location, '/?runner=expired#/settings');
  assert.equal((await browse('priya', 'GET', callback({ code: gb.code, state: 'nope' }), { cookie: b.cookie })).location, '/?runner=expired#/settings');

  const c = await pressConnect('priya');
  const cancelled = await browse('priya', 'GET', callback({ error: 'access_denied', state: new URL(c.to).searchParams.get('state')! }), { cookie: c.cookie });
  assert.equal(cancelled.location, '/?runner=denied#/settings');
  const runners = (await as('priya', 'GET', '/-/api/runners')).json.runners.filter((x: any) => x.url === hubC.url());
  assert.equal(runners.length, 1, 'only the connection that finished was saved');
});

test('Connect again to the same runner keeps one runner and gives back the token it replaces', async () => {
  const first = (await as('priya', 'GET', '/-/api/runners')).json.runners.filter((x: any) => x.url === hubC.url());
  assert.equal(first.length, 1);
  const before = hubC.revoked.length;
  const again = await pressConnect('priya');
  const back = await browse('priya', 'GET', callback(hubC.approve(again.to)), { cookie: again.cookie });
  assert.equal(back.location, '/?runner=connected#/settings');
  const now = (await as('priya', 'GET', '/-/api/runners')).json.runners.filter((x: any) => x.url === hubC.url());
  assert.deepEqual(now.map((x: any) => x.id), first.map((x: any) => x.id), 'the same runner, not a second one');
  assert.equal(hubC.revoked.length, before + 1, 'the replaced token was revoked on the runner');
  assert.equal((await launch('priya', { runner: now[0].id })).status, 201, 'and the new token works');
});

test('a connection that fails after the runner made a token gives that token back', async () => {
  const c = await pressConnect('priya', hubBroken.url());
  const back = await browse('priya', 'GET', callback(hubBroken.approve(c.to)), { cookie: c.cookie });
  assert.equal(back.location, '/?runner=failed#/settings');
  assert.equal(hubBroken.revoked.length, 1, 'the token it made was revoked');
  assert.deepEqual(hubBroken.tokens, []);
  assert.ok(!(await as('priya', 'GET', '/-/api/runners')).json.runners.some((x: any) => x.url === hubBroken.url()));
});

test('a runner out of tokens, or a code it no longer knows, each get their own outcome', async () => {
  const f = await pressConnect('priya', hubFull.url());
  assert.equal((await browse('priya', 'GET', callback(hubFull.approve(f.to)), { cookie: f.cookie })).location, '/?runner=full#/settings');
  const e = await pressConnect('priya');
  const state = new URL(e.to).searchParams.get('state')!;
  assert.equal((await browse('priya', 'GET', callback({ code: 'not-a-code', state }), { cookie: e.cookie })).location, '/?runner=expired#/settings');
});

test('Disconnect revokes a token it got through Connect, and leaves a pasted one alone', async () => {
  const connected = (await as('priya', 'GET', '/-/api/runners')).json.runners.find((x: any) => x.url === hubC.url());
  const before = hubC.revoked.length;
  assert.equal((await as('priya', 'DELETE', `/-/api/runners/${connected.id}`)).status, 200);
  assert.equal(hubC.revoked.length, before + 1, 'the Connect token was revoked on the runner');

  const pasted = (await as('priya', 'POST', '/-/api/runners', { url: hubB.url(), token: 'tok-priya-2', name: 'Pasted' })).json.runner;
  assert.equal((await as('priya', 'DELETE', `/-/api/runners/${pasted.id}`)).status, 200);
  assert.ok(!hubB.seen.some(s => s.path === '/api/tokens/self'), 'a pasted token is not revoked');
  assert.ok(hubB.tokens.includes('tok-priya-2'));
});
