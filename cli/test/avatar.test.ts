// Avatars: GitHub pictures fetched by the hub, initials for everyone else.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { handleAvatar, initialsSvg } from '../src/avatar.ts';

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('initials: two letters, a stable color, round for builders and square-ish for orgs and agents', () => {
  const svg = initialsSvg('ada-lovelace', 'personal');
  assert.match(svg, />AL</);
  assert.match(svg, /rx="48"/);
  assert.equal(svg, initialsSvg('ada-lovelace', 'personal'));
  assert.match(initialsSvg('scout', 'agent'), /rx="22"/);
  assert.match(initialsSvg('scout', 'agent'), />SC</);
});

test('a GitHub-backed name gets its picture, others and failures get initials, bad names a 404', async t => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const github = await serve((req, res) => {
    if (req.url?.startsWith('/octocat.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    res.writeHead(404); res.end();
  });
  t.after(github.close);
  const logins: Record<string, string> = { octo: 'octocat', gone: 'nobody-on-github' };
  const app = await serve(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const handled = await handleAvatar({ lookup: async name => ({ kind: 'personal', githubLogin: logins[name] ?? '' }), githubBase: github.url }, req, res, url);
    if (!handled) { res.writeHead(418); res.end(); }
  });
  t.after(app.close);
  const get = async (path: string) => { const r = await fetch(app.url + path); return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) }; };
  assert.deepEqual((await get('/-/avatar/octo')).body, png);
  assert.equal((await get('/-/avatar/octo')).type, 'image/png');
  assert.equal((await get('/-/avatar/gone')).type, 'image/svg+xml');
  assert.match((await get('/-/avatar/plain')).body.toString(), />PL</);
  assert.equal((await get('/-/avatar/Bad%20Name')).status, 404);
  assert.equal((await get('/-/other')).status, 418);
});
