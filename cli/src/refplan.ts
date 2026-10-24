// What a GitHub sync changes in one project. Each ref is seen three ways:
// GitHub's value now (G), the hub's value now (H), and GitHub's value at the
// last sync (L, from ref_sync). Work done on the hub is never thrown away:
//
//   H == G             nothing to change
//   no H               create it, unless L == G (it was deleted here on purpose)
//   G == L             GitHub has not moved: keep the hub's (it may be ahead)
//   H == L             nothing was done here: follow GitHub, force pushes included
//   H is part of G     fast-forward
//   otherwise          keep the hub's and mark it diverged
//
// A ref gone from GitHub is deleted here only if it still holds L.
// This file only uses git, so its tests need no hub.
import { spawn } from 'node:child_process';

export interface RefPlan {
  update: { ref: string; oid: string; expect: string }[]; // expect: the hub's value now ("" for none)
  remove: { ref: string; expect: string }[];
  synced: { ref: string; oid: string }[]; // already the same; record GitHub's value
  diverged: { ref: string; oid: string }[]; // kept as the hub has it
  gone: string[]; // gone from GitHub: forget its last value
}

function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
  });
}

// Is `ancestor` part of `tip`'s history in `repo`? False when either is unknown there.
export async function isAncestor(repo: string, ancestor: string, tip: string) {
  return (await git(repo, ['merge-base', '--is-ancestor', ancestor, tip])).code === 0;
}

// Branches and tags of a repository, as ref name -> object id.
export async function readRefs(repo: string): Promise<Map<string, string>> {
  const r = await git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']);
  if (r.code !== 0) throw new Error(`git for-each-ref failed: ${r.err.trim()}`);
  return new Map(
    r.out
      .split('\n')
      .filter(Boolean)
      .map(line => [line.slice(41), line.slice(0, 40)] as [string, string])
  );
}

const MIRRORED = /^refs\/(heads|tags)\//;

export async function planRefs(
  repo: string,
  github: Map<string, string>,
  hub: Map<string, string>,
  last: Map<string, string>,
  ancestor: (a: string, b: string) => Promise<boolean> = (a, b) => isAncestor(repo, a, b)
): Promise<RefPlan> {
  const plan: RefPlan = { update: [], remove: [], synced: [], diverged: [], gone: [] };
  for (const [ref, g] of github) {
    if (!MIRRORED.test(ref)) continue;
    const h = hub.get(ref);
    const l = last.get(ref);
    if (h === g) {
      if (l !== g) plan.synced.push({ ref, oid: g });
    } else if (h === undefined) {
      if (l !== g) plan.update.push({ ref, oid: g, expect: '' });
    } else if (g === l) {
      // GitHub has not moved since the last sync; whatever the hub did stays.
    } else if (h === l || (await ancestor(h, g))) {
      plan.update.push({ ref, oid: g, expect: h });
    } else {
      plan.diverged.push({ ref, oid: g });
    }
  }
  for (const [ref, l] of last) {
    if (github.has(ref)) continue;
    const h = hub.get(ref);
    if (h !== undefined && h === l) plan.remove.push({ ref, expect: h });
    plan.gone.push(ref);
  }
  return plan;
}

// Push a plan to `url` (one project on the hub) from `repo`, which holds
// GitHub's objects. Every ref carries a lease on the value the plan saw, so a
// push someone made in between wins and this sync leaves that ref for next
// time. Returns which refs moved.
export async function pushPlan(repo: string, url: string, plan: RefPlan, env: Record<string, string>): Promise<Map<string, boolean>> {
  const steps = [
    ...plan.update.map(u => ({ ref: u.ref, spec: `+${u.oid}:${u.ref}`, expect: u.expect })),
    ...plan.remove.map(r => ({ ref: r.ref, spec: `:${r.ref}`, expect: r.expect })),
  ];
  const moved = new Map<string, boolean>();
  for (let i = 0; i < steps.length; i += 200) {
    const batch = steps.slice(i, i + 200);
    const r = await git(repo, ['push', '--porcelain', url, ...batch.map(s => `--force-with-lease=${s.ref}:${s.expect}`), ...batch.map(s => s.spec)], env);
    const done = parsePorcelain(r.out);
    for (const s of batch) moved.set(s.ref, done.get(s.ref) === true);
    if (r.code !== 0 && done.size === 0) throw new Error(`push failed: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
  }
  return moved;
}

// `git push --porcelain` lines: "<flag>\t<from>:<to>\t<summary>"; "!" is a
// rejected or failed ref.
export function parsePorcelain(out: string): Map<string, boolean> {
  const done = new Map<string, boolean>();
  for (const line of out.split('\n')) {
    const m = /^([ +\-*!=])\t([^\t]*):([^\t]+)\t/.exec(line);
    if (m) done.set(m[3], m[1] !== '!');
  }
  return done;
}
