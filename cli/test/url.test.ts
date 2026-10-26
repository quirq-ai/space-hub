// quirq:// URLs and which token goes where (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubTokenTarget, hubUrl, parseHubUrl, serverOfHost } from '../src/url.ts';
import { loadConfig, saveToken } from '../src/config.ts';

test('quirq URLs name their hub; short and old ones mean the logged-in hub', () => {
  assert.deepEqual(parseHubUrl('quirq://hub.quirq.dev/alice/notes'), { server: 'wss://hub.quirq.dev', space: 'alice/notes' });
  assert.deepEqual(parseHubUrl('quirq://127.0.0.1:3197/a/b.git'), { server: 'ws://127.0.0.1:3197', space: 'a/b' });
  assert.deepEqual(parseHubUrl('quirq://alice/notes'), { space: 'alice/notes' });
  assert.deepEqual(parseHubUrl('spacehub://alice/notes'), { space: 'alice/notes' });
  for (const bad of ['quirq://a', 'quirq://h/a/b/c', 'spacehub://h/a/b', 'quirq://bad host/a/b', 'https://github.com/a/b', 'quirq://h/a@b/c'])
    assert.equal(parseHubUrl(bad), null, bad);
  assert.equal(hubUrl('wss://hub.quirq.dev', 'alice/notes'), 'quirq://hub.quirq.dev/alice/notes');
});

test('only this machine gets plain ws://', () => {
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3197', '[::1]:3000'])
    assert.match(serverOfHost(host), /^ws:\/\//, host);
  for (const host of ['localhost.evil.com', '127.evil.com', '127.0.0.1.evil.com', 'hub.quirq.dev', '[::1].evil.com'])
    assert.match(serverOfHost(host), /^wss:\/\//, host);
});

test('SPACEHUB_TOKEN goes only to the configured hub', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
  process.env.SPACEHUB_HOME = home;
  process.env.SPACEHUB_SERVER = 'wss://hub.quirq.dev';
  process.env.SPACEHUB_TOKEN = 'env-token';
  try {
    assert.equal(loadConfig().token, 'env-token');
    assert.equal(loadConfig('wss://hub.quirq.dev').token, 'env-token');
    assert.equal(loadConfig('wss://evil.example').token, undefined);
    saveToken('wss://other.example', 'saved-other');
    assert.equal(loadConfig('wss://other.example').token, 'saved-other');
  } finally {
    delete process.env.SPACEHUB_TOKEN;
    delete process.env.SPACEHUB_SERVER;
    delete process.env.SPACEHUB_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the GitHub token goes only over https, and to another hub only after a yes', () => {
  assert.equal(githubTokenTarget('https://hub.quirq.dev/-/api/auth/github'), 'send');
  for (const here of ['http://127.0.0.1:3002/-/api/auth/github', 'http://localhost:3000/x', 'http://[::1]:3000/x'])
    assert.equal(githubTokenTarget(here), 'send', here);
  assert.equal(githubTokenTarget('https://hub.example.com/-/api/auth/github'), 'ask');
  assert.equal(githubTokenTarget('https://hub.quirq.dev.evil.com/x'), 'ask');
  for (const bad of ['http://hub.quirq.dev/x', 'http://hub.example.com/x', 'http://localhost.evil.com/x', 'http://127.0.0.1.evil.com/x', 'ftp://hub.quirq.dev/x'])
    assert.throws(() => githubTokenTarget(bad), /only over https/, bad);
  assert.throws(() => githubTokenTarget('https://u:p@hub.quirq.dev/x'), /login in it/);
});
