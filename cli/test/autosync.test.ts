// Autosync against a plain bare repository standing in for the hub (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Autosync, AutosyncStop, checkpointMessage, runGit } from '../src/autosync.ts';

// No global or system git settings: autosync must bring its own identity.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-autosync-'));
const emptyConfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
async function git(cwd: string, ...args: string[]) {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`);
  return r.out.trim();
}

// A hub with one commit on main, and two clones of it whose remote is quirq.
async function setup() {
  const dir = path.join(tmp, `case${++n}`);
  const hub = path.join(dir, 'hub.git');
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-q', '--bare', '-b', 'main', hub);
  const seed = path.join(dir, 'seed');
  await git(dir, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'shared.txt'), 'one\n');
  await git(seed, 'add', '.');
  await git(seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed');
  await git(seed, 'push', '-q', hub, 'main');
  const clone = async (name: string) => {
    const cwd = path.join(dir, name);
    await git(dir, 'clone', '-q', '-o', 'quirq', hub, cwd);
    const lines: string[] = [];
    const sync = new Autosync({ cwd, remote: 'quirq', branch: 'main', agent: name, log: l => lines.push(l) });
    await sync.init();
    return { cwd, sync, lines };
  };
  const remote = async () => (await git(dir, 'ls-remote', hub, 'refs/heads/main')).split('\t')[0] ?? '';
  return { hub, remote, a: await clone('alice'), b: await clone('bob') };
}

test('checkpoint messages name the files', () => {
  assert.equal(checkpointMessage(['a.txt']), 'autosync: a.txt');
  assert.equal(checkpointMessage(['a', 'b', 'c', 'd', 'e']), 'autosync: a, b, c and 2 more');
});

test('two copies editing different files converge', async () => {
  const { remote, a, b } = await setup();
  fs.writeFileSync(path.join(a.cwd, 'from-alice.txt'), 'a\n');
  fs.mkdirSync(path.join(b.cwd, 'notes'));
  fs.writeFileSync(path.join(b.cwd, 'notes', 'from-bob.txt'), 'b\n');
  await a.sync.step(await remote()); // commits and pushes
  await b.sync.step(await remote()); // commits, rebases onto alice, pushes
  await a.sync.step(await remote()); // pulls bob's
  const head = await remote();
  assert.equal(await git(a.cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(b.cwd, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(a.cwd, 'notes', 'from-bob.txt')));
  assert.ok(fs.existsSync(path.join(b.cwd, 'from-alice.txt')));
  assert.equal(await git(a.cwd, 'log', '-1', '--format=%an %s'), 'bob autosync: notes/from-bob.txt');
  assert.match(b.lines.join('\n'), /rebased onto/);
  assert.match(a.lines.join('\n'), /pulled/);
  // Nothing new: a step does nothing.
  await a.sync.step(head);
  assert.equal(await remote(), head);
});

test('a conflicting edit stops with the rebase paused', async () => {
  const { remote, a, b } = await setup();
  fs.writeFileSync(path.join(a.cwd, 'shared.txt'), 'alice\n');
  fs.writeFileSync(path.join(b.cwd, 'shared.txt'), 'bob\n');
  await a.sync.step(await remote());
  const won = await remote();
  await assert.rejects(b.sync.step(won), (err: unknown) => err instanceof AutosyncStop && err.files.join() === 'shared.txt');
  assert.deepEqual(await b.sync.conflictState(), ['shared.txt']);
  assert.match(fs.readFileSync(path.join(b.cwd, 'shared.txt'), 'utf8'), /<<<<<<< /);
  // It stays stopped until the conflict is resolved, and the hub keeps alice's commit.
  await assert.rejects(b.sync.step(won), AutosyncStop);
  assert.equal(await remote(), won);
  // Resolving it lets autosync carry on.
  fs.writeFileSync(path.join(b.cwd, 'shared.txt'), 'alice and bob\n');
  await git(b.cwd, 'add', 'shared.txt');
  await git(b.cwd, '-c', 'core.editor=true', '-c', 'user.name=bob', '-c', 'user.email=bob@example.com', 'rebase', '--continue');
  await b.sync.step(won);
  assert.equal(await git(b.cwd, 'rev-parse', 'HEAD'), await remote());
});

test('a refused push stops autosync', async () => {
  const { hub, remote, a } = await setup();
  const hook = path.join(hub, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "permission denied: you are not the owner or a member of alice/notes" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(a.cwd, 'x.txt'), 'x\n');
  await assert.rejects(a.sync.step(await remote()), (err: unknown) => err instanceof AutosyncStop && /permission denied/.test(err.message));
});
