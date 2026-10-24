// The GitHub sync's rules, on a plain git repository (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePorcelain, planRefs, readRefs } from '../src/refplan.ts';

// history: a - b - c (main), b - d (other)
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-refplan-'));
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
const commit = (msg: string) => {
  git('commit', '-q', '--allow-empty', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const a = commit('a');
const b = commit('b');
const c = commit('c');
git('checkout', '-q', '-b', 'other', b);
const d = commit('d');

const MAIN = 'refs/heads/main';
const m = (entries: [string, string][]) => new Map(entries);

test('reads branches and tags', async () => {
  git('tag', 'v1', a);
  const refs = await readRefs(repo);
  assert.equal(refs.get(MAIN), c);
  assert.equal(refs.get('refs/tags/v1'), a);
});

test('new refs are created; equal ones are only recorded', async () => {
  const plan = await planRefs(repo, m([[MAIN, c], ['refs/tags/v1', a]]), m([['refs/tags/v1', a]]), m([]));
  assert.deepEqual(plan.update, [{ ref: MAIN, oid: c, expect: '' }]);
  assert.deepEqual(plan.synced, [{ ref: 'refs/tags/v1', oid: a }]);
});

test('a ref nobody touched here follows GitHub, even a force push', async () => {
  const plan = await planRefs(repo, m([[MAIN, d]]), m([[MAIN, c]]), m([[MAIN, c]]));
  assert.deepEqual(plan.update, [{ ref: MAIN, oid: d, expect: c }]);
  assert.deepEqual(plan.diverged, []);
});

test('work done here fast-forwards when GitHub builds on it', async () => {
  const plan = await planRefs(repo, m([[MAIN, c]]), m([[MAIN, b]]), m([[MAIN, a]]));
  assert.deepEqual(plan.update, [{ ref: MAIN, oid: c, expect: b }]);
});

test('work done here is kept when GitHub went another way', async () => {
  const plan = await planRefs(repo, m([[MAIN, d]]), m([[MAIN, c]]), m([[MAIN, b]]));
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.diverged, [{ ref: MAIN, oid: d }]);
});

test('a hub that is ahead of an unchanged GitHub stays as it is', async () => {
  const plan = await planRefs(repo, m([[MAIN, b]]), m([[MAIN, c]]), m([[MAIN, b]]));
  assert.deepEqual(plan, { update: [], remove: [], synced: [], diverged: [], gone: [] });
});

test('commits GitHub does not have count as work done here', async () => {
  const unknown = 'f'.repeat(40);
  const plan = await planRefs(repo, m([[MAIN, c]]), m([[MAIN, unknown]]), m([[MAIN, b]]));
  assert.deepEqual(plan.diverged, [{ ref: MAIN, oid: c }]);
});

test('a ref deleted here stays deleted until GitHub moves it', async () => {
  assert.deepEqual((await planRefs(repo, m([[MAIN, c]]), m([]), m([[MAIN, c]]))).update, []);
  assert.deepEqual((await planRefs(repo, m([[MAIN, d]]), m([]), m([[MAIN, c]]))).update, [{ ref: MAIN, oid: d, expect: '' }]);
});

test('a ref gone from GitHub goes here only if nothing was done to it', async () => {
  const old = 'refs/heads/old';
  const kept = 'refs/heads/kept';
  const plan = await planRefs(repo, m([]), m([[old, a], [kept, c]]), m([[old, a], [kept, b]]));
  assert.deepEqual(plan.remove, [{ ref: old, expect: a }]);
  assert.deepEqual(plan.gone, [old, kept]);
});

test('only branches and tags are mirrored', async () => {
  const plan = await planRefs(repo, m([['refs/pull/1/head', a]]), m([]), m([]));
  assert.deepEqual(plan.update, []);
});

test('reads which refs a push moved', () => {
  const out = `To quirq://acme/site\n \trefs/heads/a:refs/heads/a\t1..2\n+\t${a}:refs/heads/b\t+ 1...2 (forced update)\n-\t:refs/heads/c\t[deleted]\n*\t${a}:refs/tags/v1\t[new tag]\n!\t${b}:refs/heads/d\t[rejected] (stale info)\nDone\n`;
  assert.deepEqual(
    [...parsePorcelain(out)],
    [
      ['refs/heads/a', true],
      ['refs/heads/b', true],
      ['refs/heads/c', true],
      ['refs/tags/v1', true],
      ['refs/heads/d', false],
    ]
  );
});
