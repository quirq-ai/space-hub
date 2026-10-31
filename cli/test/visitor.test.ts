// A visitor who is not signed in lands on the hub's front project (npm test).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { forgetVisitorLanding, visitorHome, visitorLanding } from '../src/visitor.ts';

// The module's API: quirq/quirq is on the hub, nothing else.
async function module() {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url!);
    const q = new URL(req.url!, 'http://x').searchParams;
    res.writeHead(q.get('space') === 'quirq' && ['', 'quirq'].includes(q.get('project') ?? '') ? 200 : 404).end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, asked, deps: { internalHttp: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db: 'spacehub' } };
}
const visitor = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as http.IncomingMessage;

beforeEach(() => forgetVisitorLanding());

test('the front project is quirq/quirq unless SPACEHUB_VISITOR_HOME says otherwise; off turns it off', () => {
  assert.equal(visitorHome({}), 'quirq/quirq');
  assert.equal(visitorHome({ SPACEHUB_VISITOR_HOME: 'acme' }), 'acme');
  assert.equal(visitorHome({ SPACEHUB_VISITOR_HOME: 'off' }), null);
  assert.equal(visitorHome({ SPACEHUB_VISITOR_HOME: '//evil.example' }), null);
  assert.equal(visitorHome({ SPACEHUB_VISITOR_HOME: 'quirq/..' }), null, 'never back to / itself');
});

test('a visitor lands there; a signed-in builder stays home', async () => {
  const m = await module();
  assert.equal(await visitorLanding(m.deps, visitor(), {}), '/quirq/quirq');
  assert.equal(await visitorLanding(m.deps, visitor('theme=dark'), {}), '/quirq/quirq');
  assert.equal(await visitorLanding(m.deps, visitor('theme=dark; spacehub_session=tok'), {}), null);
  // A signed-out browser's emptied cookie is no session.
  assert.equal(await visitorLanding(m.deps, visitor('spacehub_session='), {}), '/quirq/quirq');
  assert.equal(m.asked.length, 1, 'asked once a minute');
  m.server.close();
});

test('a hub without the place, or one that does not answer, shows its home page', async () => {
  const m = await module();
  assert.equal(await visitorLanding(m.deps, visitor(), { SPACEHUB_VISITOR_HOME: 'acme/site' }), null);
  forgetVisitorLanding();
  assert.equal(await visitorLanding(m.deps, visitor(), { SPACEHUB_VISITOR_HOME: 'off' }), null);
  m.server.close();
  forgetVisitorLanding();
  assert.equal(await visitorLanding(m.deps, visitor(), {}), null);
});
