// GitHub to the hub, for the web service:
//
//   - GitHub's API: an account, its public repositories, one repository;
//   - mirrorProject: bring one project in step with a GitHub repository by
//     refplan's rules (work done on the hub is never thrown away);
//   - GithubSync: keep every space linked to a GitHub user or organization
//     in step, as the hub admin, on request and every so often.
//
// SPACEHUB_GITHUB_API points at another API (tests use a stand-in, whose
// clone URLs are then used as they are); SPACEHUB_GITHUB_TOKEN raises
// GitHub's rate limit.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectTo, errorMessage, listRefs, projectsIn, snapshot, tables, type Conn } from './conn';
import { planRefs, pushPlan, readRefs } from './refplan';

// A problem to show the person who asked, as it is.
export class Fail extends Error {}

const GIT_TIMEOUT_MS = 30 * 60 * 1000;
// git finds git-remote-quirq on PATH; also look next to this bundle.
const HELPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin');

// git runs on repositories from anywhere: it never sees the xo key or the
// admin's token, except as SPACEHUB_TOKEN when it pushes into the hub.
function childEnv() {
  const { SPACEHUB_XO_KEY: _key, SPACEHUB_ADMIN_TOKEN: _admin, ...rest } = process.env;
  return rest;
}

export function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0', PATH: `${HELPER_DIR}:${process.env.PATH ?? ''}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        const text = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' ');
        reject(new Error(text || `${cmd} ${args[0]} failed (${code ?? 'killed'})`));
      }
    });
  });
}

// ---------------------------------------------------------------- the API

export interface GithubApi {
  base: string;
  token: string;
  standIn: boolean; // not GitHub itself: use its clone URLs as they are
}

export function githubApi(): GithubApi {
  const set = process.env.SPACEHUB_GITHUB_API;
  return { base: (set ?? 'https://api.github.com').replace(/\/+$/, ''), token: process.env.SPACEHUB_GITHUB_TOKEN ?? '', standIn: !!set };
}

async function getJson(api: GithubApi, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.base}${url}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'spacehub', ...(api.token ? { authorization: `Bearer ${api.token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

// Best effort: description, size and visibility. When the API is unreachable
// or rate-limited the import still goes ahead.
export async function githubInfo(api: GithubApi, owner: string, repo: string) {
  try {
    const { status, body } = await getJson(api, `/repos/${owner}/${repo}`);
    if (status === 404) throw new Fail(`github.com/${owner}/${repo} was not found (only public repositories can be imported)`);
    if (!body) return null;
    const info = body as { description?: string | null; size?: number; private?: boolean; owner?: { login?: string } };
    return { description: info.description ?? '', sizeKb: info.size ?? 0, private: !!info.private, ownerLogin: info.owner?.login ?? owner };
  } catch (err) {
    if (err instanceof Fail) throw err;
    return null;
  }
}

// The GitHub account that built a repository, with its display name when
// GitHub has one ("Anthropic" for anthropics). Throws when GitHub says the
// account does not exist; if GitHub is unreachable the login is used as is.
export async function githubBuilder(api: GithubApi, login: string) {
  let name = login;
  const got = await getJson(api, `/users/${login}`).catch(() => null);
  if (got?.status === 404) throw new Fail(`There is no GitHub user or organization named "${login}".`);
  if (got?.body) {
    const user = got.body as { login?: string; name?: string | null };
    login = user.login ?? login;
    name = user.name?.trim() || login;
  }
  return { handle: login, name, url: `https://github.com/${login}` };
}

export interface GithubRepo {
  name: string;
  source: string; // https://github.com/<owner>/<name>
  cloneUrl: string;
  description: string;
  sizeKb: number;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// A GitHub user's or organization's public repositories, at most `max`.
export async function listRepos(api: GithubApi, login: string, max: number): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (let page = 1; repos.length < max; page++) {
    const { status, body } = await getJson(api, `/users/${login}/repos?per_page=100&page=${page}&sort=full_name`);
    if (status === 404) throw new Fail(`There is no GitHub user or organization named "${login}".`);
    if (!Array.isArray(body)) throw new Fail(`GitHub did not list the repositories of ${login} (HTTP ${status})`);
    for (const r of body as { name?: string; html_url?: string; clone_url?: string; description?: string | null; size?: number; private?: boolean }[]) {
      if (r.private || !r.name || !REPO_NAME.test(r.name) || !r.html_url) continue;
      const source = `https://github.com/${login}/${r.name}`;
      repos.push({ name: r.name, source, cloneUrl: api.standIn && r.clone_url ? r.clone_url : `${source}.git`, description: r.description ?? '', sizeKb: r.size ?? 0 });
    }
    if (body.length < 100) break;
  }
  return repos.slice(0, max);
}

// ---------------------------------------------------------------- one project

export interface MirrorResult {
  refs: number;
  moved: number;
  diverged: number;
  failed: number;
  head: string; // GitHub's default branch
}

// Bring `project` in step with the repository at `cloneUrl`, pushing as the
// identity in `pushEnv` (SPACEHUB_TOKEN). `conn` is that identity's
// connection: it reads the hub's refs and records ref_sync rows.
export async function mirrorProject(conn: Conn, project: { id: bigint; fullName: string }, cloneUrl: string, pushEnv: Record<string, string>): Promise<MirrorResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spacehub-mirror-'));
  try {
    const repo = path.join(tmp, 'repo.git');
    await run('git', ['clone', '--bare', '--quiet', cloneUrl, repo]);
    const github = await readRefs(repo);
    const hub = new Map((await listRefs(conn, project.id)).map(r => [r.name, r.oid]));
    const last = await snapshot(conn, tables.refSync.where(r => r.projectId.eq(project.id)), () => {
      const rows = [...conn.db.refSync.iter()].filter(r => r.projectId === project.id);
      return new Map(rows.map(r => [r.ref, r.githubOid]));
    });
    const plan = await planRefs(repo, github, hub, last);
    const moved = await pushPlan(repo, `quirq://${project.fullName}`, plan, { ...pushEnv, SPACEHUB_HOME: path.join(tmp, 'home') });
    const records = [
      ...plan.synced.map(s => ({ ref: s.ref, githubOid: s.oid, status: 'synced' })),
      ...plan.update.filter(u => moved.get(u.ref)).map(u => ({ ref: u.ref, githubOid: u.oid, status: 'synced' })),
      ...plan.diverged.map(d => ({ ref: d.ref, githubOid: d.oid, status: 'diverged' })),
      ...plan.gone.filter(ref => !plan.remove.some(r => r.ref === ref) || moved.get(ref)).map(ref => ({ ref, githubOid: '', status: 'gone' })),
    ];
    for (let i = 0; i < records.length; i += 500) await conn.reducers.recordRefSync({ project: project.fullName, refs: records.slice(i, i + 500) });
    const head = (await run('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
    const tried = plan.update.length + plan.remove.length;
    const ok = [...moved.values()].filter(Boolean).length;
    return { refs: github.size, moved: ok, diverged: plan.diverged.length, failed: tried - ok, head };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- linked spaces

export interface GithubSyncConfig {
  server: string;
  db: string;
  adminToken: string;
  api: GithubApi;
  maxRepos: number;
  maxImportMb: number;
  everyMinutes: number; // 0: only on request
}

// Syncs spaces linked to GitHub accounts, one at a time, as the hub admin:
// when an owner links or asks (status "requested"), and every so often.
export class GithubSync {
  private config: GithubSyncConfig;
  private conn: Conn | null = null;
  private waiting: string[] = [];
  private busy = false;

  constructor(config: GithubSyncConfig) {
    this.config = config;
  }

  start() {
    const attempt = () =>
      this.connect().catch(err => {
        process.stderr.write(`spacehub-web: GitHub sync: ${errorMessage(err)}; retrying\n`);
        setTimeout(attempt, 5000);
      });
    void attempt();
    if (this.config.everyMinutes > 0) setInterval(() => this.due(), 60_000).unref();
  }

  private async connect() {
    const { conn } = await connectTo(this.config.server, this.config.db, this.config.adminToken, { reconnect: true });
    this.conn = conn;
    const wanted = (r: { space: string; status: string }) => {
      if (r.status === 'requested') this.enqueue(r.space);
    };
    conn.db.spaceLink.onInsert((_ctx, r) => wanted(r));
    conn.db.spaceLink.onUpdate((_ctx, _old, r) => wanted(r));
    await new Promise<void>((resolve, reject) =>
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          // A sync cut short by a restart starts again.
          for (const r of conn.db.spaceLink.iter()) if (r.status === 'running') this.enqueue(r.space);
          resolve();
        })
        .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
        .subscribe(tables.spaceLink)
    );
  }

  // Spaces whose last sync is older than everyMinutes.
  private due() {
    if (!this.conn) return;
    const cutoff = BigInt(Date.now() - this.config.everyMinutes * 60_000) * 1000n;
    for (const r of this.conn.db.spaceLink.iter()) {
      if ((r.status === 'done' || r.status === 'failed') && r.updatedAt.microsSinceUnixEpoch < cutoff) this.enqueue(r.space);
    }
  }

  private enqueue(space: string) {
    if (!this.waiting.includes(space)) this.waiting.push(space);
    void this.next();
  }

  private async next() {
    if (this.busy || !this.conn) return;
    const space = this.waiting.shift();
    if (!space) return;
    this.busy = true;
    try {
      await this.sync(this.conn, space);
    } catch (err) {
      process.stderr.write(`spacehub-web: GitHub sync of ${space}: ${errorMessage(err)}\n`);
    }
    this.busy = false;
    void this.next();
  }

  private async sync(conn: Conn, space: string) {
    const link = [...conn.db.spaceLink.iter()].find(r => r.space === space);
    if (!link) return;
    const status = (s: string, message: string, projects = 0) => conn.reducers.setLinkStatus({ space, status: s, message, projects });
    const login = link.source.replace(/^https:\/\/github\.com\//, '');
    try {
      await status('running', 'listing repositories');
      const repos = await listRepos(this.config.api, login, this.config.maxRepos);
      const builder = await githubBuilder(this.config.api, login);
      const existing = new Set((await projectsIn(conn, space)).map(p => p.name));
      const pushEnv = { SPACEHUB_TOKEN: this.config.adminToken, SPACEHUB_SERVER: this.config.server, SPACEHUB_DB: this.config.db };
      let done = 0;
      let diverged = 0;
      const skipped: string[] = [];
      const failed: string[] = [];
      for (const [i, repo] of repos.entries()) {
        if (repo.sizeKb > this.config.maxImportMb * 1024) {
          skipped.push(repo.name);
          continue;
        }
        await status('running', `syncing ${i + 1} of ${repos.length}: ${repo.name}`);
        const full = `${space}/${repo.name}`;
        const fresh = !existing.has(repo.name);
        try {
          if (fresh) {
            await conn.reducers.createProject({ space, name: repo.name, description: repo.description });
            await conn.reducers.setBuilder({ space: full, ...builder });
            await conn.reducers.startImport({ space: full, source: repo.source });
          }
          const project = (await projectsIn(conn, space)).find(p => p.name === repo.name);
          if (!project) throw new Error(`project ${full} is missing`);
          const result = await mirrorProject(conn, project, repo.cloneUrl, pushEnv);
          diverged += result.diverged;
          if (result.failed) failed.push(`${repo.name} (${result.failed} refs not pushed; the next sync tries again)`);
          if (fresh) {
            if (result.head) await conn.reducers.editSpace({ space: full, description: undefined, defaultBranch: result.head }).catch(() => undefined);
            await conn.reducers.updateImport({ space: full, status: 'done', message: 'imported' });
          }
          done++;
        } catch (err) {
          failed.push(`${repo.name} (${errorMessage(err).slice(0, 200)})`);
          if (fresh) await conn.reducers.updateImport({ space: full, status: 'failed', message: errorMessage(err).slice(-500) }).catch(() => undefined);
        }
      }
      const parts = [`${done} of ${repos.length} repositories`];
      if (diverged) parts.push(`${diverged} refs diverged (kept here)`);
      if (skipped.length) parts.push(`skipped as too large: ${skipped.join(', ')}`);
      if (failed.length) parts.push(`failed: ${failed.join('; ')}`);
      await status(failed.length && !done ? 'failed' : 'done', parts.join('; '), done);
    } catch (err) {
      await status('failed', errorMessage(err).slice(-500)).catch(() => undefined);
    }
  }
}
