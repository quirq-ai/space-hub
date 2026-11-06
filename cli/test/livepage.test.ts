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
  for (const frame of [null, { viewer: 'ada' }]) {
    const html = shell('a & b · <ada>', '<h1>Hello</h1><p>main</p>', '<script src="/-/live.js" defer></script>', frame);
    assert.deepEqual(pageParts(html), { title: 'a & b · <ada>', main: '<h1>Hello</h1><p>main</p>' });
  }
  assert.equal(pageParts('<html>not a page</html>'), null);
});

test('live.js is plain JavaScript', () => {
  assert.doesNotThrow(() => new Function(LIVE_JS));
  assert.match(LIVE_JS, /new EventSource\('\/-\/live\?path='/);
});

test('server pages draw the app frame: the shared stylesheet, the sidebar and the inset header, no top bar', () => {
  const html = shell('Guide · spacehub', '<h1>Guide</h1>', '', { viewer: 'ada', current: 'guide' });
  assert.match(html, /<link rel="stylesheet" href="\/-\/app\/shell.css">/);
  assert.match(html, /<script src="\/-\/app\/frame.js"><\/script>/);
  for (const part of ['class="shell server"', 'class="sidebar"', 'class="side-head"', 'class="side-content"', 'class="dock"', 'Switch space', 'class="inset-header"', 'data-frame="toggle"', 'data-theme-choice="dark"']) assert.ok(html.includes(part), part);
  assert.match(html, /class="nav-item active" href="\/-\/guide"/);
  assert.match(html, /aria-current="page">Guide</);
  assert.match(html, /Account: ada/);
  assert.doesNotMatch(html, /Search spaces, projects, files|class="topbar"|<header><a class="home"/);
  const guest = shell('Sign in · spacehub', '<p>x</p>', '', { viewer: null });
  assert.match(guest, /href="\/-\/login"/);
  assert.match(guest, /Not signed in/);
});

