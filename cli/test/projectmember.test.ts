// The app's collaborator route (POST /-/api/project-member): which reducer runs, with what, on the connection the
// web service opens with the viewer's own session (app.ts ACTIONS). Fakes stand in for that connection (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectMemberAction } from '../src/projectmember.ts';

function fakeConn(refuse?: string) {
  const calls: [string, unknown][] = [];
  const record = (name: string) => async (args: unknown) => {
    if (refuse) throw new Error(refuse);
    calls.push([name, args]);
  };
  const conn = { reducers: { addProjectMember: record('addProjectMember'), removeProjectMember: record('removeProjectMember') } } as any;
  return { conn, calls };
}

test('add and remove run the module\'s reducers, with the builder as typed in any case or with @', async () => {
  const { conn, calls } = fakeConn();
  await projectMemberAction.call({ project: 'bob/site', builder: ' @Dave ', op: 'add' })!(conn);
  await projectMemberAction.call({ project: 'bob/site', builder: 'dave-bot', op: 'remove' })!(conn);
  assert.deepEqual(calls, [
    ['addProjectMember', { project: 'bob/site', agent: 'dave' }],
    ['removeProjectMember', { project: 'bob/site', agent: 'dave-bot' }],
  ]);
});

test('a body that is not a project, a builder and add or remove runs nothing', () => {
  for (const body of [{ project: 'bob/site', builder: 'dave', op: 'invite' }, { project: 'bob/site', builder: '  ', op: 'add' }, { project: 1, builder: 'dave', op: 'add' }, { project: 'bob/site', op: 'remove' }, {}]) {
    assert.equal(projectMemberAction.call(body), null, JSON.stringify(body));
  }
  assert.match(projectMemberAction.usage, /op "add" or "remove"/);
});

test('the module decides who may: its refusal comes back as is, for the route to send', async () => {
  const { conn, calls } = fakeConn('permission denied: only owners of "bob" can change "bob/site"');
  await assert.rejects(projectMemberAction.call({ project: 'bob/site', builder: 'dave', op: 'add' })!(conn), /permission denied/);
  assert.deepEqual(calls, []);
});
