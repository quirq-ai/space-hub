// GitHub's device flow against a stand-in for github.com (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deviceCode, deviceToken, githubWeb } from '../src/device.ts';

// github.com: /login/device/code hands out a code; /login/oauth/access_token
// answers each poll with the next of `answers`.
async function fakeWeb(answers: Record<string, unknown>[], start: Record<string, unknown> = {}) {
  const forms: URLSearchParams[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const form = new URLSearchParams(body);
    forms.push(form);
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

test('the code asks for no scopes, and polling waits until the person says yes', async () => {
  const gh = await fakeWeb([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'app-tok' }]);
  try {
    const code = await deviceCode(gh.web, 'Iv1.hubapp');
    assert.equal(code.user_code, 'ABCD-1234');
    assert.equal(gh.forms[0].get('scope'), '');
    assert.equal(gh.forms[0].get('client_id'), 'Iv1.hubapp');
    const waits: number[] = [];
    assert.equal(await deviceToken(gh.web, 'Iv1.hubapp', code, async ms => void waits.push(ms)), 'app-tok');
    // slow_down raises the wait to what GitHub asks for.
    assert.deepEqual(waits, [5000, 5000, 10000]);
    assert.equal(gh.forms[1].get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(gh.forms[1].get('device_code'), 'dev-1');
  } finally {
    gh.close();
  }
});

test('a no on GitHub, or a code that ran out, ends the sign-in', async () => {
  const gh = await fakeWeb([{ error: 'access_denied' }, { error: 'expired_token' }]);
  try {
    const code = await deviceCode(gh.web, 'Iv1.hubapp');
    const now = async () => {};
    await assert.rejects(deviceToken(gh.web, 'Iv1.hubapp', code, now), /cancelled on GitHub/);
    await assert.rejects(deviceToken(gh.web, 'Iv1.hubapp', code, now), /ran out/);
    await assert.rejects(deviceToken(gh.web, 'Iv1.hubapp', { ...code, expires_in: -1 }, now), /ran out/);
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
  assert.equal(githubWeb({}), 'https://github.com');
  assert.equal(githubWeb({ SPACEHUB_GITHUB_WEB: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
});
