// The CLI's device sign-in against a stand-in hub (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deviceSignIn } from '../src/devicelogin.ts';

// A hub: POST .../device answers `start`; each poll answers the next of `polls`.
async function fakeHub(start: { status: number; body: unknown }, polls: { status: number; body: unknown }[] = []) {
  const seen: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push(`${req.url} ${body}`);
    const answer = req.url === '/-/api/auth/github/device' ? start : (polls.shift() ?? { status: 500, body: {} });
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  const web = await new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { web, seen, close: () => server.close() };
}

const CODE = { session: 's1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 };
const run = (web: string, notes: string[] = [], waits: number[] = []) =>
  deviceSignIn(web, 'hub.example', line => void notes.push(line), async () => {}, async ms => void waits.push(ms));

test('shows GitHub\'s code, waits as asked, and returns the hub\'s answer', async () => {
  const hub = await fakeHub({ status: 200, body: CODE }, [
    { status: 200, body: { status: 'pending', interval: 10 } },
    { status: 200, body: { status: 'done', builder: 'octocat', token: 'hub-1', created: true } },
  ]);
  try {
    const notes: string[] = [];
    const waits: number[] = [];
    assert.deepEqual(await run(hub.web, notes, waits), { status: 'done', builder: 'octocat', token: 'hub-1', created: true });
    assert.match(notes[0], /open https:\/\/github\.com\/login\/device and enter the code ABCD-1234/);
    assert.deepEqual(waits, [5000, 10000]);
    assert.equal(hub.seen[1], '/-/api/auth/github/device/poll {"session":"s1"}');
  } finally {
    hub.close();
  }
});

test('only a 404 means "no OAuth App"; a hub that fails stops the sign-in', async () => {
  const none = await fakeHub({ status: 404, body: { error: 'no app' } });
  try {
    assert.equal(await run(none.web), null);
  } finally {
    none.close();
  }
  for (const status of [500, 502, 503, 429]) {
    const hub = await fakeHub({ status, body: { error: `down ${status}` } });
    try {
      await assert.rejects(run(hub.web), new RegExp(`down ${status}`));
    } finally {
      hub.close();
    }
  }
});

test('a code or page that is not GitHub\'s is not shown', async () => {
  for (const bad of [
    { verification_uri: 'https://evil.example/login/device' },
    { verification_uri: 'http://github.com/login/device' },
    { verification_uri: 'https://github.com.evil.example/' },
    { user_code: 'open evil.example' },
    { session: 7 },
  ]) {
    const hub = await fakeHub({ status: 200, body: { ...CODE, ...bad } });
    const notes: string[] = [];
    try {
      await assert.rejects(run(hub.web, notes), /not GitHub's/);
      assert.deepEqual(notes, []);
    } finally {
      hub.close();
    }
  }
});

test('a no on GitHub, or a code that ran out, ends with the hub\'s reason', async () => {
  const hub = await fakeHub({ status: 200, body: CODE }, [{ status: 403, body: { error: 'sign-in was cancelled on GitHub' } }]);
  try {
    await assert.rejects(run(hub.web), /cancelled on GitHub/);
  } finally {
    hub.close();
  }
});

test('a no at the confirm question shows no code and asks the hub nothing more', async () => {
  const hub = await fakeHub({ status: 200, body: CODE });
  const notes: string[] = [];
  try {
    const no = async () => {
      throw new Error('nothing was done');
    };
    await assert.rejects(deviceSignIn(hub.web, 'hub.example', line => void notes.push(line), no, async () => {}), /nothing was done/);
    assert.deepEqual(notes, []);
    assert.equal(hub.seen.length, 1);
  } finally {
    hub.close();
  }
});
