// The activity journal: every activity row also on disk, append-only, each
// once, catching up after a restart (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityJournal, activityJournalDir, attachJournal, journalFiles, readJournal, type ActivityRowIn, type JournalConn } from '../src/activityjournal.ts';

const row = (id: number, kind = 'ref_updated', at = 1_800_000_000): ActivityRowIn => ({
  id: BigInt(id), at: { microsSinceUnixEpoch: BigInt(at) * 1_000_000n }, projectId: 7n, path: 'quirq/quirq',
  agent: 'euler', kind, subject: 'refs/heads/main', oid: 'abc', count: 1, text: `push ${id}`,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'activity-journal-'));

test('where the journal goes: beside the data, somewhere else, or off', () => {
  assert.equal(activityJournalDir({ SPACEHUB_DATA_ROOT: '/data' }), '/data/activity');
  assert.equal(activityJournalDir({ SPACEHUB_DATA_ROOT: '/data', SPACEHUB_ACTIVITY_DIR: '/logs/feed' }), '/logs/feed');
  assert.equal(activityJournalDir({ SPACEHUB_DATA_ROOT: '/data', SPACEHUB_ACTIVITY_DIR: 'off' }), null);
  assert.equal(activityJournalDir({}), null);
});

test('appends every row once, oldest first, and picks up after a restart', () => {
  const dir = tmp();
  const journal = new ActivityJournal(dir, () => new Date('2026-11-06T12:00:00Z'));
  assert.equal(journal.insert([row(3), row(1), row(2)]), 3);
  // The same rows again (a reconnect replays the subscription) add nothing.
  assert.equal(journal.insert([row(2), row(3)]), 0);
  assert.equal(journal.lastId, 3n);
  // A restart reads where it stopped.
  const again = new ActivityJournal(dir, () => new Date('2026-12-01T00:00:00Z'));
  assert.equal(again.lastId, 3n);
  assert.equal(again.insert([row(3), row(4)]), 1);
  assert.deepEqual(journalFiles(dir).map(file => path.basename(file)), ['activity-2026-11.jsonl', 'activity-2026-12.jsonl']);
  const lines = readJournal(dir);
  assert.deepEqual(lines.map(line => `${line.op} ${line.id}`), ['insert 1', 'insert 2', 'insert 3', 'insert 4']);
  assert.deepEqual({ ...lines[0], journaledAt: '' }, {
    op: 'insert', id: '1', at: new Date(1_800_000_000_000).toISOString(), projectId: '7', path: 'quirq/quirq',
    agent: 'euler', kind: 'ref_updated', subject: 'refs/heads/main', oid: 'abc', count: 1, text: 'push 1', journaledAt: '',
  });
});

test('changes and removals add lines; nothing already written changes', () => {
  const dir = tmp();
  const journal = new ActivityJournal(dir, () => new Date('2026-11-06T12:00:00Z'));
  journal.insert([row(1), row(2)]);
  const before = fs.readFileSync(journalFiles(dir)[0], 'utf8');
  journal.update({ ...row(1), path: 'renamed/quirq' });
  journal.delete(row(2));
  const after = fs.readFileSync(journalFiles(dir)[0], 'utf8');
  assert.ok(after.startsWith(before));
  assert.deepEqual(readJournal(dir).map(line => `${line.op} ${line.id} ${line.path}`), ['insert 1 quirq/quirq', 'insert 2 quirq/quirq', 'update 1 renamed/quirq', 'delete 2 quirq/quirq']);
  // An update or delete does not move the catch-up point.
  assert.equal(new ActivityJournal(dir).lastId, 2n);
});

test('a line torn by a crash is skipped, and writing goes on from a fresh line', () => {
  const dir = tmp();
  const journal = new ActivityJournal(dir, () => new Date('2026-11-06T12:00:00Z'));
  journal.insert([row(1)]);
  fs.appendFileSync(journalFiles(dir)[0], '{"op":"insert","id":"2","at');
  const again = new ActivityJournal(dir, () => new Date('2026-11-06T12:00:00Z'));
  assert.equal(again.lastId, 1n);
  again.insert([row(2)]);
  assert.deepEqual(readJournal(dir).map(line => line.id), ['1', '2']);
});

test('fed from a connection: the catch-up in one append, then live changes', async () => {
  const dir = tmp();
  const journal = new ActivityJournal(dir, () => new Date('2026-11-06T12:00:00Z'));
  const handlers: Record<string, (...args: never[]) => void> = {};
  const conn = { db: { activity: {
    onInsert: (cb: never) => { handlers.insert = cb; },
    onUpdate: (cb: never) => { handlers.update = cb; },
    onDelete: (cb: never) => { handlers.delete = cb; },
  } } } as unknown as JournalConn;
  const errors: string[] = [];
  attachJournal(journal, conn, message => errors.push(message));
  const applied = { event: { tag: 'SubscribeApplied' } } as never;
  const reducer = { event: { tag: 'Reducer' } } as never;
  for (const id of [1, 2, 3]) (handlers.insert as (ctx: never, r: ActivityRowIn) => void)(applied, row(id));
  // The subscription's own unsubscribe is no removal.
  (handlers.delete as (ctx: never, r: ActivityRowIn) => void)({ event: { tag: 'UnsubscribeApplied' } } as never, row(1));
  await new Promise(resolve => setImmediate(resolve));
  (handlers.insert as (ctx: never, r: ActivityRowIn) => void)(reducer, row(4));
  (handlers.update as (ctx: never, o: ActivityRowIn, r: ActivityRowIn) => void)(reducer, row(2), { ...row(2), agent: 'renamed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readJournal(dir).map(line => `${line.op} ${line.id}`), ['insert 1', 'insert 2', 'insert 3', 'insert 4', 'update 2']);
  assert.deepEqual(errors, []);
});

test('no code deletes an activity row: not a reducer, a command or an admin path', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['node_modules', 'module_bindings', 'dist'].includes(e.name) ? [] : files(path.join(dir, e.name))) : /\.(ts|tsx|sh|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const sources = ['module/src', 'cli/src', 'app/src', 'scripts', 'docker'].flatMap(dir => files(path.join(root, dir)));
  assert.ok(sources.length > 20);
  const offenders = sources.filter(file => /\.activity\.(\w+\.)?delete\(|activity\.clear\(|delete\s+from\s+activity|truncate\s+activity|drop\s+table\s+activity/i.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
