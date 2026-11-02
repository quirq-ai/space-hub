// The Worker Protocol client (worker/1) against a stand-in runner (npm test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkRunnerUrl, redactToken, runner, RunnerError } from '../src/workerclient.ts';

const TOKEN = 'hub_TOKEN_abcdefghijklmnop';

// A runner whose answers each test can set.
const seen: { method: string; path: string; auth?: string; key?: string; body: string }[] = [];
let answer: (req: { method: string; path: string; body: string }) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, key: req.headers['idempotency-key'] as string | undefined, body });
  const a = answer({ method: req.method!, path: req.url!, body });
  res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('describe reads worker/1, fills missing capabilities with false and ignores unknown ones', async () => {
  answer = () => ({ status: 200, body: { protocol: 'worker/1', name: "Priya's hub", kind: 'Agents Hub · OpenAI', capabilities: { followUp: true, stop: true, shiny: true } } });
  const d = await runner(URL_, TOKEN).describe();
  assert.deepEqual(d, { protocol: 'worker/1', name: "Priya's hub", kind: 'Agents Hub · OpenAI',
    capabilities: { followUp: true, stop: true, events: false, repo: false, connect: false } });
  assert.equal(seen.at(-1)!.auth, `Bearer ${TOKEN}`);
  assert.equal(seen.at(-1)!.path, '/api/worker');
});

test('a runner speaking another protocol is refused', async () => {
  answer = () => ({ status: 200, body: { protocol: 'worker/2', name: 'x', kind: 'x', capabilities: {} } });
  await assert.rejects(runner(URL_, TOKEN).describe(), (e: RunnerError) => e.status === 400 && /speaks worker\/2; update space-hub/.test(e.message));
});

test('start sends the task with the bearer and the idempotency key', async () => {
  answer = () => ({ status: 201, body: { task: { id: 't1', status: 'running' }, result: { summary: null, links: [], error: null } } });
  const out = await runner(URL_, TOKEN).start({ text: 'fix it', title: 'Fix', repo: 'acme/site' }, 'key-123');
  assert.equal((out as { task: { id: string } }).task.id, 't1');
  const last = seen.at(-1)!;
  assert.deepEqual([last.method, last.path, last.key, JSON.parse(last.body)], ['POST', '/api/tasks', 'key-123', { text: 'fix it', title: 'Fix', repo: 'acme/site' }]);
});

test('each route goes where the protocol says', async () => {
  answer = () => ({ status: 200, body: { ok: true } });
  const r = runner(URL_, TOKEN);
  await r.list(); await r.get('t1'); await r.events('t1', 5); await r.followUp('t1', 'more', 'k2'); await r.stop('t1'); await r.teardown('t1');
  assert.deepEqual(seen.slice(-6).map(s => `${s.method} ${s.path}`), [
    'GET /api/tasks', 'GET /api/tasks/t1', 'GET /api/tasks/t1/events?after=5', 'POST /api/tasks/t1/messages', 'POST /api/tasks/t1/stop', 'DELETE /api/tasks/t1']);
  assert.equal(seen.at(-3)!.key, 'k2');
});

test('errors become what space-hub should answer, with any token removed', async () => {
  const r = runner(URL_, TOKEN);
  answer = () => ({ status: 401, body: { error: 'bad' } });
  await assert.rejects(r.get('t1'), (e: RunnerError) => e.status === 502 && e.auth === true && /not valid for this runner/.test(e.message));
  answer = () => ({ status: 404, body: { error: 'task not found' } });
  await assert.rejects(r.get('t1'), (e: RunnerError) => e.status === 404 && /ended and was torn down/.test(e.message));
  answer = () => ({ status: 409, body: { error: 'The agent is still working.' } });
  await assert.rejects(r.followUp('t1', 'x', 'k'), (e: RunnerError) => e.status === 409 && e.message === 'The agent is still working.');
  answer = () => ({ status: 500, body: { error: `boom with ${TOKEN} and Bearer ${TOKEN} and hub_OTHER_secret_value` } });
  await assert.rejects(r.get('t1'), (e: RunnerError) => e.status === 502 && !e.message.includes(TOKEN) && !/hub_[A-Za-z0-9]{8}/.test(e.message));
  await assert.rejects(runner('http://127.0.0.1:1', TOKEN).get('t1'), (e: RunnerError) => e.status === 502 && /did not answer/.test(e.message));
});

test('runner addresses: https, or http to this machine only when local runners are allowed; no trailing slash', () => {
  assert.equal(checkRunnerUrl(' https://hub.example.com/ '), 'https://hub.example.com');
  assert.equal(checkRunnerUrl('http://127.0.0.1:7090', true), 'http://127.0.0.1:7090');
  assert.equal(checkRunnerUrl('http://localhost:7090/', true), 'http://localhost:7090');
  for (const bad of ['http://127.0.0.1:7090', 'http://localhost:7090', 'http://hub.example.com', 'ftp://x', 'hub.example.com', '', 'https://user:pw@hub.example.com']) {
    assert.throws(() => checkRunnerUrl(bad), (e: RunnerError) => e.status === 400, bad);
  }
});

test('a runner that redirects is refused, and the redirect is not followed', async () => {
  let followed = false;
  const target = http.createServer((_req, res) => { followed = true; res.end('{}'); });
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
  const hop = http.createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/inside` }).end());
  await new Promise<void>(r => hop.listen(0, '127.0.0.1', r));
  await assert.rejects(runner(`http://127.0.0.1:${(hop.address() as AddressInfo).port}`, TOKEN).describe(), (e: RunnerError) => e.status === 502 && /redirect/.test(e.message));
  assert.equal(followed, false);
  hop.close(); target.close();
});

test('redactToken removes the exact token, hub_ tokens and bearer values', () => {
  assert.equal(redactToken(`a ${TOKEN} b`, TOKEN), 'a [redacted] b');
  assert.equal(redactToken('Bearer abc.def', 'x'), 'Bearer [redacted]');
  assert.equal(redactToken('hub_ABCDEFGHIJ', 'x'), '[redacted]');
});
