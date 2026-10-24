// Autosync keeps a working copy and its branch on the hub converged while
// several agents edit the same space. Each step:
//
//   1. commits every local change (git add -A) as one checkpoint commit;
//   2. if the hub's branch holds commits this copy lacks, rebases the local
//      commits onto it (git pull --rebase);
//   3. pushes when this copy is ahead.
//
// `space sync --watch --auto` runs a step every few seconds and on every push
// the hub reports. A rebase that conflicts stops autosync and leaves git's own
// conflict state in place (git status lists the files), so nothing is lost.
// This file only uses git, so its tests need no hub.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

export function runGit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
  });
}

// Autosync cannot go on by itself: a conflict to resolve, or a push the hub
// will never accept.
export class AutosyncStop extends Error {
  readonly files: string[];
  constructor(message: string, files: string[] = []) {
    super(message);
    this.files = files;
  }
}

function lastLines(text: string, n = 3) {
  return text.trim().split('\n').slice(-n).join(' ').trim();
}

export function checkpointMessage(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return `autosync: ${shown}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
}

export function conflictHelp(files: string[], branch: string, restart: string): string {
  const list = files.length ? files.map(f => `  ${f}`).join('\n') : '  (see git status)';
  return [
    `autosync stopped: your commits conflict with the hub's ${branch} in:`,
    list,
    'The rebase is paused with conflict markers in those files (git status shows it). Either:',
    '  fix them, then: git add <files> && git rebase --continue',
    '  or undo the rebase and keep your commits: git rebase --abort',
    `Then start again: ${restart}`,
  ].join('\n');
}

// Files left to resolve in `cwd`, or null when no rebase or merge is in
// progress there.
export async function unfinishedWork(cwd: string): Promise<string[] | null> {
  const gitPath = async (name: string) => path.resolve(cwd, (await runGit(cwd, ['rev-parse', '--git-path', name])).out.trim());
  const busy = fs.existsSync(await gitPath('rebase-merge')) || fs.existsSync(await gitPath('rebase-apply')) || fs.existsSync(await gitPath('MERGE_HEAD'));
  const files = (await runGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).out.split('\0').filter(Boolean);
  return busy || files.length ? files : null;
}

export const UNFINISHED = 'this copy has an unfinished rebase or merge; finish it (git status) before starting autosync';

export interface AutosyncOptions {
  cwd: string; // the working copy's top level
  remote: string; // the quirq remote
  branch: string;
  agent: string; // committer name when git has none configured
  log: (line: string) => void;
  env?: Record<string, string>; // for git, e.g. the hub token to push with
}

export class Autosync {
  private o: AutosyncOptions;
  private identity: string[] = [];
  private pushed = '';

  constructor(options: AutosyncOptions) {
    this.o = options;
  }

  private git(args: string[]) {
    return runGit(this.o.cwd, args, this.o.env);
  }

  // Commits need an author; agents in fresh sandboxes often have none, so
  // fall back to the agent's name.
  async init() {
    const name = (await this.git(['config', 'user.name'])).out.trim();
    const email = (await this.git(['config', 'user.email'])).out.trim();
    this.identity = [...(name ? [] : ['-c', `user.name=${this.o.agent}`]), ...(email ? [] : ['-c', `user.email=${this.o.agent}@spacehub`])];
    const state = await this.conflictState();
    if (state) throw new AutosyncStop(UNFINISHED, state);
  }

  conflictState() {
    return unfinishedWork(this.o.cwd);
  }

  private async head() {
    const r = await this.git(['rev-parse', '-q', '--verify', 'HEAD']);
    return r.code === 0 ? r.out.trim() : '';
  }

  // Is `oid` already part of this copy's history?
  private async contains(oid: string) {
    return (await this.git(['merge-base', '--is-ancestor', oid, 'HEAD'])).code === 0;
  }

  private async commitChanges() {
    const status = await this.git(['status', '--porcelain', '-z', '--untracked-files=all']);
    if (status.code !== 0) throw new Error(`git status failed: ${lastLines(status.err)}`);
    if (!status.out) return;
    const add = await this.git(['add', '-A']);
    if (add.code !== 0) throw new Error(`git add failed: ${lastLines(add.err)}`);
    const files = (await this.git(['diff', '--cached', '--name-only', '-z'])).out.split('\0').filter(Boolean);
    if (files.length === 0) return;
    const commit = await this.git([...this.identity, 'commit', '-q', '--no-verify', '-m', checkpointMessage(files)]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${lastLines(commit.err || commit.out)}`);
    this.o.log(`committed ${files.length === 1 ? files[0] : `${files.length} files`} (${(await this.head()).slice(0, 7)})`);
  }

  private async integrate(remoteOid: string) {
    const before = await this.head();
    const pull = await this.git([...this.identity, 'pull', '--rebase', '--autostash', '-q', this.o.remote, this.o.branch]);
    if (pull.code !== 0) {
      const files = await this.conflictState();
      if (files) throw new AutosyncStop(`rebase onto ${remoteOid.slice(0, 7)} conflicts`, files);
      throw new Error(`git pull failed: ${lastLines(pull.err)}`);
    }
    const after = await this.head();
    const fastForward = !before || (await this.git(['merge-base', '--is-ancestor', before, remoteOid])).code === 0;
    this.o.log(fastForward ? `pulled ${after.slice(0, 7)}` : `rebased onto ${remoteOid.slice(0, 7)} (${after.slice(0, 7)})`);
  }

  private async push(head: string, remoteOid: string) {
    const count = (await this.git(['rev-list', '--count', head, ...(remoteOid ? [`^${remoteOid}`] : [])])).out.trim();
    const push = await this.git(['push', '-q', this.o.remote, `HEAD:refs/heads/${this.o.branch}`]);
    if (push.code !== 0) {
      const why = lastLines(push.err);
      const denied = /permission denied[^\n)]*/i.exec(push.err);
      if (denied) throw new AutosyncStop(`the hub refused the push: ${denied[0].trim()}`);
      // Usually someone pushed first; the hub reports their push and the
      // next step rebases onto it.
      if (/stale info|fetch first|non-fast-forward/.test(push.err)) this.o.log('someone pushed first; rebasing onto their push');
      else this.o.log(`push failed (${/\(([^)]*)\)/.exec(why)?.[1] ?? why}); retrying`);
      return;
    }
    this.pushed = head;
    this.o.log(`pushed ${count} commit${count === '1' ? '' : 's'} (${head.slice(0, 7)})`);
  }

  // One round. `remoteOid` is what the hub's branch holds now ("" when the
  // branch does not exist there yet).
  async step(remoteOid: string) {
    const files = await this.conflictState();
    if (files) throw new AutosyncStop('a rebase or merge is in progress', files);
    await this.commitChanges();
    let head = await this.head();
    if (!head) {
      // A clone made before anything was pushed: take the first push.
      if (remoteOid) await this.integrate(remoteOid);
      return;
    }
    if (remoteOid && remoteOid !== head && !(await this.contains(remoteOid))) {
      await this.integrate(remoteOid);
      head = await this.head();
    }
    if (head === remoteOid || head === this.pushed) return;
    if (remoteOid && !(await this.contains(remoteOid))) return;
    await this.push(head, remoteOid);
  }
}

// Runs an Autosync's steps one at a time: one now, then one every
// `intervalMs` and whenever wake() says the branch moved on the hub. Steps
// never overlap. It ends when a step stops autosync (a conflict, a refused
// push) or when stop() is called, which lets a running step finish.
export class AutosyncLoop {
  private engine: Autosync;
  private intervalMs: number;
  private remoteOid: () => string;
  private onError: (err: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private pending = true;
  private quit = false;
  private stopped: AutosyncStop | null = null;
  private finish: () => void = () => {};
  readonly done: Promise<AutosyncStop | null>;

  constructor(engine: Autosync, intervalMs: number, remoteOid: () => string, onError: (err: unknown) => void) {
    this.engine = engine;
    this.intervalMs = intervalMs;
    this.remoteOid = remoteOid;
    this.onError = onError;
    this.done = new Promise(resolve => {
      this.finish = () => resolve(this.stopped);
    });
  }

  start() {
    void this.loop();
    return this.done;
  }

  wake() {
    this.pending = true;
    if (!this.running && !this.quit) this.schedule(0);
  }

  stop() {
    this.quit = true;
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) this.finish();
    return this.done;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = true;
      void this.loop();
    }, ms);
  }

  private async loop() {
    if (this.running || this.quit) return;
    this.running = true;
    while (this.pending && !this.quit) {
      this.pending = false;
      try {
        await this.engine.step(this.remoteOid());
      } catch (err) {
        if (err instanceof AutosyncStop) {
          this.stopped = err;
          this.quit = true;
        } else this.onError(err);
      }
    }
    this.running = false;
    if (this.quit) this.finish();
    else this.schedule(this.intervalMs);
  }
}
