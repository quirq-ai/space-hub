// Which pages are live and what the live stream carries (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBuilder, LIVE_JS, liveTopic, pageParts, signedOutEvent } from '../src/livepage.ts';
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

test('live.js leaves for the sign-in page, with the reason, on a signed-out event', () => {
  const listeners: Record<string, (e: { data: string }) => void> = {};
  let closed = false;
  let went = '';
  class FakeSource {
    onopen: unknown;
    onerror: unknown;
    addEventListener(type: string, fn: (e: { data: string }) => void) { listeners[type] = fn; }
    close() { closed = true; }
  }
  const main = { innerHTML: '', textContent: '', querySelector: () => null };
  const document = { querySelector: (s: string) => (s === 'main' ? main : null), createElement: () => ({}), addEventListener() {} };
  const location = { pathname: '/ada', search: '?x=1', assign: (to: string) => { went = to; } };
  new Function('window', 'document', 'EventSource', 'location', LIVE_JS)({ EventSource: FakeSource }, document, FakeSource, location);
  listeners['signed-out']({ data: signedOutEvent('suspended').split('data: ')[1].trim() });
  assert.equal(closed, true, 'stops: no retry into a refusal');
  assert.equal(went, '/-/login?reason=suspended&next=%2Fada%3Fx%3D1');
});

test('server pages draw the app frame: the shared stylesheet, the sidebar and the inset header, no top bar', () => {
  const html = shell('Guide · spacehub', '<h1>Guide</h1>', '', { viewer: 'ada', current: 'guide' });
  assert.match(html, /<link rel="stylesheet" href="\/-\/app\/shell.css">/);
  assert.match(html, /<script src="\/-\/app\/frame.js"><\/script>/);
  for (const part of ['class="shell server"', 'class="sidebar"', 'class="side-head"', 'class="side-content"', 'class="dock"', 'Switch space', 'class="inset-header"', 'data-frame="toggle"', 'data-theme-choice="dark"']) assert.ok(html.includes(part), part);
  // Home and Search open from the dock's switcher, and the hub's pages from its account, not the sidebar.
  const bar = html.slice(html.indexOf('class="sidebar"'), html.indexOf('class="inset-header"'));
  assert.doesNotMatch(bar, />Home<|>Search<|>Guide<|>Settings<|>Builders<|Your profile|Platform/);
  const menus = html.slice(html.indexOf('class="dock"'), html.indexOf('<main>'));
  assert.ok(menus.indexOf('>Home<') > 0 && menus.indexOf('>Home<') < menus.indexOf('>Spaces<'));
  assert.ok(menus.indexOf('>Search<') > 0 && menus.indexOf('>Search<') < menus.indexOf('>Spaces<'));
  assert.match(menus, /class="on" aria-current="page" href="\/-\/guide"/);
  for (const page of ['Your profile', 'Guide', 'Settings', 'Builders', 'Sign out']) assert.ok(menus.includes(page), page);
  assert.match(html, /aria-current="page">Guide</);
  assert.match(html, /Account: ada/);
  assert.doesNotMatch(html, /Search spaces, projects, files|class="topbar"|<header><a class="home"/);
  const guest = shell('Sign in · spacehub', '<p>x</p>', '', { viewer: null });
  assert.match(guest, /href="\/-\/login"/);
  assert.match(guest, /Not signed in/);
  for (const page of ['Sign in', 'Guide', 'Settings', 'Builders']) assert.ok(guest.includes(`${page}</a>`), page);
});

test("a suspended builder's live pages are told why, then end at once; everyone else's stay open", () => {
  const ended: string[] = [];
  const sent: string[] = [];
  const clients = new Set<{ builder: string | null; res: { write(chunk: string): unknown; end(): void } }>();
  // Ending a page takes it out of the set, as live.ts does on 'close'.
  for (const [id, builder] of [['carol-1', 'carol'], ['alice', 'alice'], ['carol-2', 'carol'], ['anon', null]] as const) {
    const c = { builder, res: { write: (chunk: string) => sent.push(`${id} ${chunk}`), end: () => (ended.push(id), sent.push(`${id} end`), void clients.delete(c)) } };
    clients.add(c);
  }
  assert.equal(closeBuilder(clients, 'carol'), 2);
  assert.deepEqual(ended, ['carol-1', 'carol-2']);
  const event = signedOutEvent('suspended');
  assert.deepEqual(sent, [`carol-1 ${event}`, 'carol-1 end', `carol-2 ${event}`, 'carol-2 end'], 'the signed-out event goes before the close');
  assert.equal(event, 'event: signed-out\ndata: {"type":"signed-out","reason":"suspended"}\n\n');
  assert.deepEqual([...clients].map(c => c.builder), ['alice', null]);
  assert.equal(closeBuilder(clients, 'nobody'), 0);
});
