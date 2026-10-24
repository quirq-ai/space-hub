// Which pages are live and what the live stream carries (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_JS, liveTopic, pageParts } from '../src/livepage.ts';
import { shell } from '../../module/src/style.ts';

test('pages follow the hub, a space or a project', () => {
  assert.equal(liveTopic('/'), 'hub');
  assert.equal(liveTopic('/?page=2'), 'hub');
  assert.equal(liveTopic('/ada'), 'space:ada');
  assert.equal(liveTopic('/ada/notes'), 'project:ada/notes');
  assert.equal(liveTopic('/ada/notes/tree/main/docs?x=1'), 'project:ada/notes');
  assert.equal(liveTopic('/ada/my%20notes/activity'), 'project:ada/my notes');
});

test('the hub pages, raw files and anything outside the UI are not live', () => {
  for (const path of ['/-/guide', '/-/builders', '/-/builders/octocat', '/ada/notes/raw/main/a.txt', '/-/login', '//evil.example', 'ada', '/%E0%A4%A', '/' + 'a'.repeat(3000)]) {
    assert.equal(liveTopic(path), null, path);
  }
});

test('the stream carries the page title and its <main>', () => {
  const html = shell('a & b · <ada>', '<a href="/">nav</a>', '<h1>Hello</h1><p>main</p>', '<script src="/-/live.js" defer></script>');
  assert.deepEqual(pageParts(html), { title: 'a & b · <ada>', main: '<h1>Hello</h1><p>main</p>' });
  assert.equal(pageParts('<html>not a page</html>'), null);
});

test('live.js is plain JavaScript', () => {
  assert.doesNotThrow(() => new Function(LIVE_JS));
  assert.match(LIVE_JS, /new EventSource\('\/-\/live\?path='/);
});
