// GitHub's device flow (run by the hub) against a stand-in for github.com (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deviceCode, githubWeb, pollToken } from '../src/device.ts';

// github.com: /login/device/code hands out a code (or `start`'s error);
// /login/oauth/access_token answers each poll with the next of `answers`.
async function fakeWeb(answers: Record<string, unknown>[], start: Record<string, unknown> = {}) {
  const forms: URLSearchParams[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    forms.push(new URLSearchParams(body));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/login/device/code') {
      return res.end(JSON.stringify({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5, ...start }));
    }
    if (req.url === '/login/oauth/access_token') return res.end(JSON.stringify(answers.shift() ?? { error: 'authorization_pending' }));
    res.writeHead(404).end('{}');
  });
  const web = await new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { web, forms, close: () => server.close() };
}

test('the code asks for no scopes, and each poll says what GitHub answered', async () => {
  const gh = await fakeWeb([
    { error: 'authorization_pending' },
    { error: 'slow_down', interval: 10 },
    { error: 'access_denied' },
    { error: 'expired_token' },
    { access_token: 'app-tok' },
    { error: 'incorrect_device_code', error_description: 'bad code' },
  ]);
  try {
    const code = await deviceCode(gh.web, 'Iv1.hubapp');
    assert.equal(code.user_code, 'ABCD-1234');
    assert.equal(gh.forms[0].get('scope'), '');
    assert.equal(gh.forms[0].get('client_id'), 'Iv1.hubapp');
    const poll = () => pollToken(gh.web, 'Iv1.hubapp', code.device_code);
    assert.deepEqual(await poll(), { kind: 'pending' });
    assert.deepEqual(await poll(), { kind: 'pending', interval: 10 });
    assert.deepEqual(await poll(), { kind: 'denied' });
    assert.deepEqual(await poll(), { kind: 'expired' });
    assert.deepEqual(await poll(), { kind: 'token', token: 'app-tok' });
    await assert.rejects(poll(), /bad code/);
    assert.equal(gh.forms[1].get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(gh.forms[1].get('device_code'), 'dev-1');
  } finally {
    gh.close();
  }
});

test('an app without the device flow ticked says what to fix', async () => {
  const gh = await fakeWeb([], { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' });
  try {
    await assert.rejects(deviceCode(gh.web, 'Iv1.hubapp'), /Enable Device Flow/);
  } finally {
    gh.close();
  }
});

test("GitHub's address is https, or http on this machine only", () => {
  assert.equal(githubWeb({}), 'https://github.com');
  assert.equal(githubWeb({ SPACEHUB_GITHUB_WEB: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
  assert.equal(githubWeb({ SPACEHUB_GITHUB_WEB: 'https://ghe.example.com' }), 'https://ghe.example.com');
  for (const bad of ['http://evil.example', 'https://u:p@github.com', 'https://github.com/x', 'ftp://github.com', 'nope']) {
    assert.throws(() => githubWeb({ SPACEHUB_GITHUB_WEB: bad }), /SPACEHUB_GITHUB_WEB/, bad);
  }
});
