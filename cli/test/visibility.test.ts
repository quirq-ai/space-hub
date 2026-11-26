// Private projects from the terminal: the flags, the arguments and which reducer runs (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseVisibility, parseVisibilityArgs, privateIds, takeVisibilityFlag, visibilityField, visibilityLine, VisibilityUsage, type CreateReducers } from '../src/visibility.ts';

// Reducers that record what they were called with.
function fakeReducers() {
  const calls: [string, unknown][] = [];
  const record = (name: string) => async (args: unknown) => { calls.push([name, args]); };
  const reducers: CreateReducers = {
    createProject: record('createProject'),
    createProjectFromTemplate: record('createProjectFromTemplate'),
    createProjectWithVisibility: record('createProjectWithVisibility'),
    createProjectFromTemplateWithVisibility: record('createProjectFromTemplateWithVisibility'),
  };
  return { reducers, calls };
}

test('a visibility is public or private, as typed in any case', () => {
  assert.equal(parseVisibility('private'), 'private');
  assert.equal(parseVisibility(' Public '), 'public');
  assert.equal(parseVisibility('secret'), null);
  assert.equal(parseVisibility(undefined), null);
});

test('--private and --public come out of the arguments; the rest stay as they were', () => {
  const args = ['notes', '--private', '-d', 'my notes'];
  assert.equal(takeVisibilityFlag(args), 'private');
  assert.deepEqual(args, ['notes', '-d', 'my notes']);
  const before = ['--public', 'acme/site'];
  assert.equal(takeVisibilityFlag(before), 'public');
  assert.deepEqual(before, ['acme/site'], 'a flag before the name is taken too, so the name is args[0]');
  const none = ['notes', '--push'];
  assert.equal(takeVisibilityFlag(none), undefined);
  assert.deepEqual(none, ['notes', '--push']);
  assert.throws(() => takeVisibilityFlag(['notes', '--private', '--public']), VisibilityUsage);
});

test('without a flag the older reducers run (the hub default applies), with one the new ones', async () => {
  const empty = fakeReducers();
  await createProject(empty.reducers, { space: 'alice', name: 'notes', description: 'd' });
  assert.deepEqual(empty.calls, [['createProject', { space: 'alice', name: 'notes', description: 'd' }]]);

  const priv = fakeReducers();
  await createProject(priv.reducers, { space: 'alice', name: 'notes', description: '', visibility: 'private' });
  assert.deepEqual(priv.calls, [['createProjectWithVisibility', { space: 'alice', name: 'notes', description: '', visibility: 'private' }]]);

  const tpl = fakeReducers();
  await createProject(tpl.reducers, { space: 'acme', name: 'launch', description: '', template: 'goal', goal: 'Ship it' });
  assert.deepEqual(tpl.calls, [['createProjectFromTemplate', { space: 'acme', name: 'launch', description: '', template: 'goal', goal: 'Ship it' }]]);

  const tplPub = fakeReducers();
  await createProject(tplPub.reducers, { space: 'acme', name: 'launch', description: '', template: '', visibility: 'public' });
  assert.deepEqual(tplPub.calls, [['createProjectFromTemplateWithVisibility', { space: 'acme', name: 'launch', description: '', template: '', goal: '', visibility: 'public' }]]);
});

test('project visibility takes [<project>] [public|private]', () => {
  assert.deepEqual(parseVisibilityArgs([]), {});
  assert.deepEqual(parseVisibilityArgs(['acme/site']), { project: 'acme/site' });
  assert.deepEqual(parseVisibilityArgs(['private']), { visibility: 'private' }, 'one word that is a visibility: the clone here');
  assert.deepEqual(parseVisibilityArgs(['acme/site', 'Public']), { project: 'acme/site', visibility: 'public' });
  assert.throws(() => parseVisibilityArgs(['acme/site', 'hidden']), /not public or private/);
  assert.throws(() => parseVisibilityArgs(['a', 'private', 'b']), /usage/);
});

test("the New project page's choice checks the hub's default, or nothing when it is unknown", () => {
  const checked = (html: string) => [...html.matchAll(/value="(\w+)" checked/g)].map(m => m[1]);
  assert.deepEqual(checked(visibilityField('private')), ['private']);
  assert.deepEqual(checked(visibilityField('public')), ['public']);
  assert.deepEqual(checked(visibilityField(null)), [], 'no box: the form sends nothing and the module applies the default');
  const html = visibilityField('public');
  assert.equal((html.match(/type="radio" name="visibility"/g) ?? []).length, 2);
  assert.match(html, /Who can see it/);
  assert.match(html, /its collaborators and their agents/);
});

test('the line says who can see it; private ids come from the view rows', () => {
  assert.match(visibilityLine('private'), /^private: only its space's owners and members/);
  assert.match(visibilityLine('public'), /^public: anyone/);
  assert.deepEqual(privateIds([{ projectId: 1n, visibility: 'private' }, { projectId: 2n, visibility: 'public' }]), new Set([1n]));
});
