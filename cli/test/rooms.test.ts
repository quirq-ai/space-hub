// Repo rooms on the web: /gh/<owner>/<repo> opens a public repository's room
// once, and /-/api/ask asks there as the signed-in builder (npm test).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { forgetOpens, handleRooms, OPENS_PER_MINUTE, parseRepo, roomUrl, type RoomsDeps } from '../src/rooms.ts';

beforeEach(() => forgetOpens());

function fake(over: Partial<RoomsDeps> = {}) {
  const rooms = new Set<string>();
  const opened: unknown[] = [];
  const asked: unknown[] = [];
  const deps: RoomsDeps = {
    space: 'explain',
    canOpen: true,
    exists: async name => rooms.has(name),
    info: async (owner, repo) => {
      if (repo === 'missing') throw new Error('not found');
      if (repo === 'quiet') return null;
      return { owner: owner === 'octo' ? 'Octo' : owner, repo: repo === 'hello-world' ? 'Hello-World' : repo, description: 'Hi', private: repo === 'secret' };
    },
    open: async input => {
      opened.push(input);
      rooms.add(`explain/${input.owner}.${input.repo}`.toLowerCase());
    },
    sessionOf: async req => (/spacehub_session=tok/.test(req.headers.cookie ?? '') ? { token: 'tok', username: 'bob' } : null),
    ask: async (_token, input) => {
      if (input.content === 'too many') throw new Error('You asked your 5 questions here today. Ask again tomorrow.');
      asked.push(input);
    },
    page: (res, status, title) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(title);
    },
    ...over,
  };
  return { deps, rooms, opened, asked };
}

async function serve(deps: RoomsDeps) {
  const server = http.createServer((req, res) => {
    void handleRooms(deps, req, res, new URL(req.url!, 'http://x')).then(handled => {
      if (!handled) res.writeHead(418).end('not mine');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (body: unknown, cookie = 'spacehub_session=tok') => fetch(base + '/-/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  return { server, get, post };
}

test('repository names come as owner/repo or GitHub links', () => {
  assert.deepEqual(parseRepo('octo/hello-world'), { owner: 'octo', repo: 'hello-world' });
  assert.deepEqual(parseRepo('https://github.com/octo/hello-world/tree/main/src'), { owner: 'octo', repo: 'hello-world' });
  assert.deepEqual(parseRepo('github.com/octo/site.github.io.git'), { owner: 'octo', repo: 'site.github.io' });
  assert.equal(parseRepo('octo'), null);
  assert.equal(parseRepo('https://example.com/octo/x'), null);
  assert.equal(roomUrl('explain', 'octo.hello-world'), '/explain/octo.hello-world#/files?path=Chat%2Fgeneral');
});

test('the first visit opens the room, with GitHub\'s spelling; later visits go straight there', async () => {
  const { deps, opened } = fake();
  const s = await serve(deps);
  const first = await s.get('/gh/octo/hello-world', 'spacehub_session=tok');
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/explain/octo.hello-world#/files?path=Chat%2Fgeneral');
  assert.deepEqual(opened, [{ owner: 'Octo', repo: 'Hello-World', description: 'Hi', openedBy: 'bob' }]);
  const again = await s.get('/-/gh?repo=https://github.com/Octo/Hello-World');
  assert.equal(again.status, 303);
  assert.equal(opened.length, 1);
  // Signed out opens too.
  await s.get('/-/gh/octo/other');
  assert.deepEqual(opened[1], { owner: 'Octo', repo: 'other', description: 'Hi', openedBy: '' });
  s.server.close();
});

test('only public repositories GitHub knows get a room', async () => {
  const { deps, opened } = fake();
  const s = await serve(deps);
  assert.equal((await s.get('/gh/octo/missing')).status, 404);
  assert.equal((await s.get('/gh/octo/secret')).status, 404);
  assert.equal((await s.get('/gh/octo/quiet')).status, 503);
  assert.equal((await s.get('/gh/-bad/x')).status, 404);
  assert.equal(opened.length, 0);
  assert.equal((await s.get('/gh/octo')).status, 418, 'not a room path');
  s.server.close();
});

test('a hub without the admin token opens no rooms, and opening is limited per minute', async () => {
  const off = await serve(fake({ canOpen: false }).deps);
  assert.equal((await off.get('/gh/octo/hello-world')).status, 503);
  off.server.close();
  const { deps } = fake();
  const s = await serve(deps);
  for (let i = 0; i < OPENS_PER_MINUTE; i++) assert.equal((await s.get(`/gh/octo/r${i}`)).status, 303);
  assert.equal((await s.get('/gh/octo/one-more')).status, 429);
  s.server.close();
});

test('asking needs a session and passes the module\'s caps on', async () => {
  const { deps, asked } = fake();
  const s = await serve(deps);
  assert.equal((await s.post({ space: 'explain', project: 'octo.x', id: 'q1', content: 'Why?' }, '')).status, 401);
  assert.equal((await s.post({ space: 'explain', project: 'octo.x', id: 'q1' })).status, 400);
  const ok = await s.post({ space: 'explain', project: 'octo.x', id: 'q1', content: ' Why? ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(asked, [{ project: 'explain/octo.x', id: 'q1', content: 'Why?' }]);
  const capped = await s.post({ space: 'explain', project: 'octo.x', id: 'q2', content: 'too many' });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /Ask again tomorrow/);
  s.server.close();
});
