// Who is asking: the web service's one viewer lookup (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { Identity } from 'spacetimedb';
import { bearerToken, cookieValue, viewerOf, type CheckToken } from '../src/viewer.ts';

const request = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
const alice = { toHexString: () => 'a1' } as unknown as Identity;
const admin = { toHexString: () => 'ad' } as unknown as Identity;

// A database that knows two tokens: alice's builder, and the hub's admin
// identity, which has no builder. Any other token is rejected, as the server would.
function database() {
  const asked: string[] = [];
  const check: CheckToken = async token => {
    asked.push(token);
    if (token === 'tok-alice') return { identity: alice, name: 'alice' };
    if (token === 'tok-admin') return { identity: admin, name: null };
    if (token === 'tok-bob') return { identity: alice, name: 'bob', suspended: true };
    throw new Error('invalid token');
  };
  return { asked, check };
}

test('the session cookie names the builder, checked against the database', async () => {
  const db = database();
  const v = await viewerOf(request({ cookie: 'spacehub_user=alice; spacehub_session=tok-alice' }), db.check);
  assert.deepEqual(v, { token: 'tok-alice', identity: alice, name: 'alice' });
  assert.deepEqual(db.asked, ['tok-alice']);
});

test('the cookie value is URL-decoded, as sign-in encodes it', async () => {
  const db = database();
  await viewerOf(request({ cookie: `spacehub_session=${encodeURIComponent('tok-alice')}` }), db.check);
  assert.deepEqual(db.asked, ['tok-alice']);
  assert.equal(cookieValue(request({ cookie: 'spacehub_session=%E0%A4%A' }), 'spacehub_session'), null, 'undecodable is absent');
});

test('no token is anonymous, without asking the database', async () => {
  const db = database();
  assert.equal(await viewerOf(request({}), db.check), null);
  assert.equal(await viewerOf(request({ cookie: 'spacehub_session=' }), db.check), null);
  assert.deepEqual(db.asked, []);
});

test('the display cookie alone is anonymous: it is never trusted', async () => {
  const db = database();
  assert.equal(await viewerOf(request({ cookie: 'spacehub_user=alice' }), db.check), null);
  assert.deepEqual(db.asked, []);
});

test('a token the database rejects is anonymous, not an error', async () => {
  const db = database();
  assert.equal(await viewerOf(request({ cookie: 'spacehub_session=forged' }), db.check), null);
  assert.equal(await viewerOf(request({ cookie: 'spacehub_session=forged', authorization: 'Bearer forged' }), db.check, { bearer: true }), null);
});

test("a suspended builder's session is signed out, by cookie or bearer", async () => {
  const db = database();
  assert.equal(await viewerOf(request({ cookie: 'spacehub_session=tok-bob' }), db.check), null);
  assert.equal(await viewerOf(request({ authorization: 'Bearer tok-bob' }), db.check, { bearer: true }), null);
});

test('a valid token with no builder is a viewer without a name', async () => {
  const v = await viewerOf(request({ cookie: 'spacehub_session=tok-admin' }), database().check);
  assert.deepEqual(v, { token: 'tok-admin', identity: admin, name: null });
});

test('a bearer token counts only where the route opts in, and then wins over the cookie', async () => {
  const db = database();
  const both = request({ authorization: 'Bearer tok-admin', cookie: 'spacehub_session=tok-alice' });
  assert.equal((await viewerOf(both, db.check))?.name, 'alice', 'bearer ignored by default');
  assert.equal((await viewerOf(both, db.check, { bearer: true }))?.token, 'tok-admin');
  assert.equal((await viewerOf(request({ authorization: 'Bearer tok-alice' }), db.check))?.name, undefined);
  assert.equal((await viewerOf(request({ authorization: 'Bearer tok-alice' }), db.check, { bearer: true }))?.name, 'alice');
});

test('only a well-formed bearer header is a token', () => {
  assert.equal(bearerToken(request({ authorization: 'Bearer abc' })), 'abc');
  assert.equal(bearerToken(request({ authorization: 'bearer abc' })), null);
  assert.equal(bearerToken(request({ authorization: 'Bearer a b' })), null);
  assert.equal(bearerToken(request({ authorization: 'Basic abc' })), null);
  assert.equal(bearerToken(request({})), null);
});
