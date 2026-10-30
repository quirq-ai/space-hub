// Agenthub in front of a stand-in for an Agents Hub (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentHubConfig, handleAgentHub, parseStart, type AgentHubConfig } from '../src/agenthub.ts';

const TOKEN = 'hub-secret-token';

// A tiny Agents Hub: tasks, one at a time running, with events and the Bearer check.
function fakeHub() {
  const tasks = new Map<string, { id: string; title: string; status: string; repo?: string }>();
  const events = new Map<string, { seq: number; kind: string; text?: string }[]>();
  const seen: { method: string; path: string; auth: string | undefined; key: string | undefined; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, key: req.headers['idempotency-key'] as string | undefined, body });
    const send = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'bad token' });
    const url = new URL(req.url!, 'http://x');
    const m = /^\/api\/tasks(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'no' });
    const [, id, action] = m;
    if (!id && req.method === 'GET') return send(200, { tasks: [...tasks.values()] });
    if (!id && req.method === 'POST') {
      const input = JSON.parse(body);
      const task = { id: `t${tasks.size + 1}`, title: input.title, status: 'running', repo: input.repo };
      tasks.set(task.id, task);
      events.set(task.id, [{ seq: 1, kind: 'user', text: input.text }]);
      return send(201, { task });
    }
    const task = tasks.get(id!);
    if (!task) return send(404, { error: 'gone' });
    if (!action && req.method === 'GET') return send(200, { task, result: { summary: '', links: [], error: '' } });
    if (!action && req.method === 'DELETE') return tasks.delete(id!), send(200, { ok: true });
    if (action === 'events') return send(200, { events: events.get(id!)!.filter(e => e.seq > Number(url.searchParams.get('after'))), next: events.get(id!)!.length });
    if (action === 'stop') return (task.status = 'stopped'), send(200, { task });
    if (action === 'messages') return task.status === 'running' ? send(409, { error: 'still running' }) : send(200, { task });
    send(404, { error: 'no' });
  });
  return { server, tasks, seen };
}

async function setup(builders = 'suraj') {
  const hub = fakeHub();
  await new Promise<void>(r => hub.server.listen(0, '127.0.0.1', r));
  const cfg = agentHubConfig({
    SPACEHUB_AGENTHUB_URL: `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}/`,
    SPACEHUB_AGENTHUB_TOKEN: TOKEN,
    SPACEHUB_AGENTHUB_BUILDERS: builders,
  }) as AgentHubConfig;
  // Sessions: the cookie is the builder's name.
  const deps = {
    sessionOf: async (req: http.IncomingMessage) => {
      const name = /spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
      return name ? { token: name, username: name } : null;
    },
    sameOrigin: (req: http.IncomingMessage) => req.headers.origin === `http://${req.headers.host}`,
  };
  const web = http.createServer(async (req, res) => {
    if (!(await handleAgentHub(cfg, deps, req, res, new URL(req.url!, 'http://local')))) res.writeHead(418).end();
  });
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const ask = async (method: string, path: string, { body, as = 'suraj', from = origin }: { body?: unknown; as?: string; from?: string } = {}) => {
    const resp = await fetch(origin + '/-/api/agenthub' + path, {
      method,
      headers: { ...(as ? { cookie: `spacehub_session=${as}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: from },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  };
  const close = () => { web.close(); web.closeAllConnections(); hub.server.close(); hub.server.closeAllConnections(); };
  return { hub, ask, close };
}

test('not set up: no URL or token means no Agenthub', async () => {
  assert.equal(agentHubConfig({}), null);
  assert.equal(agentHubConfig({ SPACEHUB_AGENTHUB_URL: 'https://a.example' }), null);
  assert.throws(() => agentHubConfig({ SPACEHUB_AGENTHUB_URL: 'http://a.example', SPACEHUB_AGENTHUB_TOKEN: 'x' }), /https/);
  const res = await new Promise<{ status: number; body: string }>(resolve => {
    const web = http.createServer(async (req, out) => { await handleAgentHub(null, { sessionOf: async () => null, sameOrigin: () => true }, req, out, new URL(req.url!, 'http://l')); });
    web.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}/-/api/agenthub`;
      const status = await (await fetch(base)).json();
      const tasks = await fetch(base + '/tasks');
      web.close();
      web.closeAllConnections();
      resolve({ status: tasks.status, body: JSON.stringify(status) });
    });
  });
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { enabled: false, signedIn: false, allowed: false, builder: null });
});

test('status says who may use it; only allowed builders reach the Agents Hub', async () => {
  const { hub, ask, close } = await setup('suraj, Gates');
  assert.deepEqual((await ask('GET', '')).body, { enabled: true, signedIn: true, allowed: true, builder: 'suraj' });
  assert.equal((await ask('GET', '', { as: 'gates' })).body.allowed, true);
  assert.equal((await ask('GET', '/tasks', { as: '' })).status, 401);
  assert.equal((await ask('GET', '/tasks', { as: 'mallory' })).status, 403);
  assert.equal(hub.seen.length, 0);
  close();
});

test('start, read, follow up, stop and tear down a session, with the token kept on the server', async () => {
  const { hub, ask, close } = await setup();
  const started = await ask('POST', '/tasks', { body: { text: 'Fix the README\nand open a PR', repo: 'https://github.com/quirq-ai/space-hub.git' } });
  assert.equal(started.status, 201);
  assert.equal(started.body.task.title, 'Fix the README');
  assert.equal(started.body.task.repo, 'quirq-ai/space-hub');
  const post = hub.seen.at(-1)!;
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  assert.match(post.key!, /^[0-9a-f]{32}$/);
  assert.match(JSON.parse(post.body).text, /Started from spacehub by suraj/);
  assert.ok(!JSON.stringify(started.body).includes(TOKEN));

  assert.equal((await ask('GET', '/tasks')).body.tasks.length, 1);
  assert.equal((await ask('GET', '/tasks/t1')).body.task.status, 'running');
  assert.deepEqual((await ask('GET', '/tasks/t1/events?after=0')).body.next, 1);
  assert.equal((await ask('GET', '/tasks/t1/events?after=1')).body.events.length, 0);
  assert.equal((await ask('POST', '/tasks/t1/messages', { body: { text: 'also a test' } })).status, 409);
  assert.equal((await ask('POST', '/tasks/t1/stop', { body: {} })).body.task.status, 'stopped');
  assert.equal((await ask('POST', '/tasks/t1/messages', { body: { text: 'also a test' } })).status, 200);
  assert.equal((await ask('DELETE', '/tasks/t1')).status, 200);
  assert.equal((await ask('GET', '/tasks/t1')).status, 404);
  close();
});

test('writes from another site, bad ids and bad input are refused before the Agents Hub is asked', async () => {
  const { hub, ask, close } = await setup();
  assert.equal((await ask('POST', '/tasks', { body: { text: 'x' }, from: 'https://evil.example' })).status, 403);
  assert.equal((await ask('DELETE', '/tasks/t1', { from: 'https://evil.example' })).status, 403);
  assert.equal((await ask('GET', '/tasks/..%2Fsecret')).status, 404);
  assert.equal((await ask('GET', '/tasks/a/b/c')).status, 404);
  assert.equal((await ask('POST', '/tasks', { body: { text: '  ' } })).status, 400);
  assert.equal((await ask('POST', '/tasks', { body: { text: 'x', repo: 'not a repo' } })).status, 400);
  assert.equal(hub.seen.length, 0);
  close();
});

test('the hub’s token being refused is not shown as the builder being signed out', async () => {
  const fake = fakeHub();
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const cfg = agentHubConfig({ SPACEHUB_AGENTHUB_URL: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`, SPACEHUB_AGENTHUB_TOKEN: 'wrong', SPACEHUB_AGENTHUB_BUILDERS: 'suraj' })!;
  const web = http.createServer(async (req, res) => { await handleAgentHub(cfg, { sessionOf: async () => ({ token: 'x', username: 'suraj' }), sameOrigin: () => true }, req, res, new URL(req.url!, 'http://l')); });
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
  const resp = await fetch(`http://127.0.0.1:${(web.address() as AddressInfo).port}/-/api/agenthub/tasks`, { headers: { cookie: 'spacehub_session=other' } });
  assert.equal(resp.status, 502);
  assert.match((await resp.json()).error, /SPACEHUB_AGENTHUB_TOKEN/);
  web.close();
  web.closeAllConnections();
  fake.server.close();
  fake.server.closeAllConnections();
});

test('a title defaults to the first line, and the builder is credited', () => {
  assert.deepEqual(parseStart({ text: 'Summarise issues\nin detail', title: '' }, 'suraj'), { title: 'Summarise issues', text: 'Summarise issues\nin detail\n\n(Started from spacehub by suraj.)' });
  assert.equal(parseStart({ text: 'x', title: '  My task ' }, 'a').title, 'My task');
});
