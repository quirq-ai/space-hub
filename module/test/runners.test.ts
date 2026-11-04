// Runners and workers (private, admin-only): run in SpacetimeDB's in-process module harness: npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) =>
    h.withReducerTx(auth, ctx => reducer(ctx, args));
  return { h, call };
}

const admin = as('admin');
const stranger = as('stranger');
const runner = (id: string, owner = 'priya', extra: object = {}) => ({
  id, owner, name: `${owner}'s hub`, kind: 'Agents Hub · OpenAI', url: `https://${id}.example`,
  sealedToken: 'sealed', capabilities: '{"followUp":true}', isDefault: false, ...extra,
});
const worker = (taskId: string, runnerId = 'r1') => ({
  taskId, runnerId, runnerUrl: 'https://r1.example', launcher: 'priya', space: 'acme', project: 'site',
  conversation: 'Chat/general/chat.json', title: 'Fix the login test',
});

describe('runners', () => {
  it('only the admin adds, changes or removes them', () => {
    const { call } = hub();
    expect(() => call(stranger, mod.runnerAdd, runner('r1'))).toThrow(/only the hub admin/);
    call(admin, mod.claimAdmin);
    expect(() => call(stranger, mod.runnerAdd, runner('r1'))).toThrow(/only the hub admin/);
    expect(() => call(stranger, mod.workerAdd, worker('t1'))).toThrow(/only the hub admin/);
  });

  it("a person's first runner is the default, and making another default moves it", () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.runnerAdd, runner('r1'));
    call(admin, mod.runnerAdd, runner('r2'));
    call(admin, mod.runnerAdd, runner('r3', 'arjun'));
    expect(h.db.runner.id.find('r1')?.isDefault).toBe(true);
    expect(h.db.runner.id.find('r2')?.isDefault).toBe(false);
    expect(h.db.runner.id.find('r3')?.isDefault).toBe(true);
    call(admin, mod.runnerUpdate, { id: 'r2', name: '', sealedToken: '', capabilities: '', isDefault: true, checked: false });
    expect(h.db.runner.id.find('r1')?.isDefault).toBe(false);
    expect(h.db.runner.id.find('r2')?.isDefault).toBe(true);
    expect(h.db.runner.id.find('r3')?.isDefault).toBe(true);
  });

  it('update keeps what it is not given, and remove deletes the row', () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.runnerAdd, runner('r1'));
    call(admin, mod.runnerUpdate, { id: 'r1', name: 'Work hub', sealedToken: '', capabilities: '', isDefault: false, checked: true });
    const row = h.db.runner.id.find('r1')!;
    expect(row.name).toBe('Work hub');
    expect(row.sealedToken).toBe('sealed');
    expect(row.capabilities).toBe('{"followUp":true}');
    expect(row.isDefault).toBe(true);           // still the only one
    call(admin, mod.runnerDelete, { id: 'r1' });
    expect(h.db.runner.id.find('r1')).toBeNull();
  });
});

describe('workers', () => {
  it('are added once, and their status and result copy are updated', () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    call(admin, mod.workerAdd, worker('t1'));
    expect(() => call(admin, mod.workerAdd, worker('t1'))).toThrow();
    expect(h.db.worker.taskId.find('t1')?.status).toBe('running');
    call(admin, mod.workerUpdate, { taskId: 't1', status: 'done', result: '{"summary":"ok"}', runnerId: '' });
    expect(h.db.worker.taskId.find('t1')).toMatchObject({ status: 'done', result: '{"summary":"ok"}', runnerId: 'r1' });
    call(admin, mod.workerUpdate, { taskId: 't1', status: '', result: '', runnerId: 'r9' });
    expect(h.db.worker.taskId.find('t1')).toMatchObject({ status: 'done', result: '{"summary":"ok"}', runnerId: 'r9' });
  });

  it("deleting a builder removes their runners and keeps their workers", () => {
    const { h, call } = hub();
    call(admin, mod.claimAdmin);
    const priya = as('priya-subject');
    call(priya, mod.registerUser, { username: 'priya' });
    call(admin, mod.runnerAdd, runner('r1'));
    call(admin, mod.workerAdd, worker('t1'));
    call(priya, mod.deleteBuilder);
    expect(h.db.runner.id.find('r1')).toBeNull();
    expect(h.db.worker.taskId.find('t1')).not.toBeNull();
  });
});
