// Module pages asked for as a verified viewer (modulepage.ts): the headers the
// module trusts are only ever the web service's own, never a client's (npm test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { asViewer, canReadProject, proxyPage, SECRET_HEADER, VIEWER_HEADER, webSecret, type ModuleLink } from '../src/modulepage.ts';

// A stand-in for the module's HTTP routes: it records what it was sent.
const seen: http.IncomingHttpHeaders[] = [];
const fake = http.createServer((req, res) => {
  seen.push(req.headers);
  if (req.url?.includes('/route/api')) {
    const ok = req.headers[SECRET_HEADER] === 's'.repeat(40) && req.headers[VIEWER_HEADER] === 'bob';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ readable: ok && req.url.includes('bob%2Fsecret') }));
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-internal': 'dropped' });
  res.end(`page ${req.headers['x-spacehub-uri']} for ${req.headers[VIEWER_HEADER] || 'nobody'}`);
});
await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
const link: ModuleLink = { http: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, db: 'hub', secret: 's'.repeat(40) };

const web = http.createServer((req, res) => {
  void proxyPage(link, req, res, String(req.headers['x-spacehub-uri'] ?? '/'), req.headers.cookie?.includes('session=bob') ? 'bob' : null);
});
await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
after(() => {
  web.close();
  fake.close();
});

test('a page goes to the module as the verified viewer, whatever the client forged', async () => {
  seen.length = 0;
  const res = await fetch(`${BASE}/-/ui`, { headers: { 'x-spacehub-uri': '/bob/secret/tree/main', [VIEWER_HEADER]: 'alice', [SECRET_HEADER]: 'f'.repeat(40), cookie: 'spacehub_user=alice' } });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'page /bob/secret/tree/main for nobody');
  assert.equal(res.headers.get('x-internal'), null, 'only the headers a page needs come back');
  assert.equal(seen[0][VIEWER_HEADER], '');
  assert.equal(seen[0][SECRET_HEADER], link.secret, "the web service's secret, not the client's");
  assert.equal(seen[0].cookie, undefined, 'no cookie reaches the module');
  const bob = await fetch(`${BASE}/-/ui`, { headers: { 'x-spacehub-uri': '/', cookie: 'spacehub_session=bob' } });
  assert.equal(await bob.text(), 'page / for bob');
});

test('only GET and HEAD reach the module', async () => {
  assert.equal((await fetch(`${BASE}/-/ui`, { method: 'POST' })).status, 405);
});

test('whether a viewer may read a project is the module\'s answer, and no when it cannot be asked', async () => {
  assert.equal(await canReadProject(link, 'bob', 'bob/secret'), true);
  assert.equal(await canReadProject(link, 'carol', 'bob/secret'), false);
  assert.equal(await canReadProject({ ...link, secret: null }, 'bob', 'bob/secret'), false, 'no secret: signed out');
  assert.equal(await canReadProject({ ...link, http: 'http://127.0.0.1:9' }, 'bob', 'bob/secret'), false);
});

test('the secret: a given one when it is one, else a new random one', () => {
  assert.equal(webSecret({ SPACEHUB_WEB_SECRET: 'x'.repeat(40) }), 'x'.repeat(40));
  assert.throws(() => webSecret({ SPACEHUB_WEB_SECRET: 'short' }), /32 to 256/);
  const a = webSecret({});
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, webSecret({}));
  assert.deepEqual(asViewer({ ...link, secret: null }, 'bob'), {}, 'without a secret, nothing to vouch with');
});
