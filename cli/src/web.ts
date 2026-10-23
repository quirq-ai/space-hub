// spacehub web service: the write side of the web UI. It runs next to
// SpacetimeDB inside the server image, behind the same proxy, at /-/*:
//
//   GET/POST /-/login            sign in with an identity token
//   GET/POST /-/signup           register an agent (new identity + name)
//   POST     /-/logout           forget the session
//   GET/POST /-/new              create a space, optionally imported from GitHub
//   POST     /-/sync/<o>/<name>  pull the space's GitHub source again
//   *        /-/api/xo/v1/...    xo.quirq.dev's store and agents (xo.ts), only
//                                with SPACEHUB_XO_KEY set
//
// Pages are read by the module (ui.ts); this service only acts. A session is
// the user's identity token in an HttpOnly cookie, so every action runs as
// that user and the module's own ownership checks apply.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectTo, errorMessage, findSpace, findUser, quietSdkLogs, snapshot, tables, type Conn } from './conn';
import { githubLogin, normalizeServer } from './config';
import { esc, navFor, PAGE_CSP, shell } from '../../module/src/style';
import { handleXo, xoConfig } from './xo';

quietSdkLogs();

const PORT = Number(process.env.SPACEHUB_WEB_PORT ?? 3002);
const SERVER = normalizeServer(process.env.SPACEHUB_SERVER ?? 'ws://127.0.0.1:3001');
const DB = process.env.SPACEHUB_DB ?? 'spacehub';
const MAX_IMPORT_MB = Number(process.env.SPACEHUB_IMPORT_MAX_MB ?? 500);
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_IMPORTS = 2;
// git finds git-remote-quirq on PATH; also look next to this bundle.
const HELPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin');
const YEAR = 60 * 60 * 24 * 365;
const XO = xoConfig(DB);

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SPACE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------- http bits

class Fail extends Error {}

function send(res: http.ServerResponse, status: number, html: string, extra: Record<string, string | string[]> = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(html);
}

function redirect(res: http.ServerResponse, to: string, cookies: string[] = []) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
}

function page(title: string, viewer: string | null, body: string) {
  return shell(title, navFor(viewer), `<div class="narrow">${body}</div>`);
}

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionCookies(req: http.IncomingMessage, token: string, username: string, maxAge = YEAR) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const attrs = `; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  return [`spacehub_session=${encodeURIComponent(token)}${attrs}; HttpOnly`, `spacehub_user=${encodeURIComponent(username)}${attrs}`];
}

// Form posts must come from this site: compare Origin (or Referer) with Host.
function sameOrigin(req: http.IncomingMessage) {
  const host = req.headers.host;
  const from = req.headers.origin ?? req.headers.referer;
  if (!host || !from) return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Fail('form too large');
  }
  return new URLSearchParams(body);
}

function localPath(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// ---------------------------------------------------------------- sessions

async function withConn<T>(token: string | undefined, fn: (conn: Conn, identity: Parameters<typeof findUser>[1], token: string) => Promise<T>) {
  const { conn, identity, token: issued } = await connectTo(SERVER, DB, token);
  try {
    return await fn(conn, identity, issued);
  } finally {
    conn.disconnect();
  }
}

// The signed-in user for this request, checked against the database.
async function sessionOf(req: http.IncomingMessage): Promise<{ token: string; username: string } | null> {
  const token = cookieValue(req, 'spacehub_session');
  if (!token) return null;
  try {
    const user = await withConn(token, (conn, identity) => findUser(conn, identity));
    return user ? { token, username: user.username } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- GitHub

function parseGithub(input: string) {
  const s = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s) ??
    /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// Best effort: description, size and visibility from GitHub's API. When the
// API is unreachable or rate-limited the import still goes ahead.
async function githubInfo(owner: string, repo: string) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'spacehub' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) throw new Fail(`github.com/${owner}/${repo} was not found (only public repositories can be imported)`);
    if (!res.ok) return null;
    const info = (await res.json()) as { description?: string | null; size?: number; private?: boolean; owner?: { login?: string } };
    return { description: info.description ?? '', sizeKb: info.size ?? 0, private: !!info.private, ownerLogin: info.owner?.login ?? owner };
  } catch (err) {
    if (err instanceof Fail) throw err;
    return null;
  }
}

// The GitHub account that built a repository, with its display name when
// GitHub has one ("Anthropic" for anthropics). Throws when GitHub says the
// account does not exist; if GitHub is unreachable the login is used as is.
async function githubBuilder(login: string) {
  let name = login;
  let res: Response | null = null;
  try {
    res = await fetch(`https://api.github.com/users/${login}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'spacehub' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // unreachable: keep the login as the name
  }
  if (res?.status === 404) throw new Fail(`There is no GitHub user or organization named "${login}".`);
  if (res?.ok) {
    const user = (await res.json()) as { login?: string; name?: string | null };
    login = user.login ?? login;
    name = user.name?.trim() || login;
  }
  return { handle: login, name, url: `https://github.com/${login}` };
}

// ---------------------------------------------------------------- imports

interface Job {
  token: string;
  space: string;
  source: string;
  sync: boolean;
}

const queue: Job[] = [];
let running = 0;

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PATH: `${HELPER_DIR}:${process.env.PATH ?? ''}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), IMPORT_TIMEOUT_MS);
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

async function runJob(job: Job) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spacehub-import-'));
  const repo = path.join(tmp, 'repo.git');
  await withConn(job.token, async conn => {
    const report = (status: string, message: string) =>
      conn.reducers.updateImport({ space: job.space, status, message }).catch(() => undefined);
    try {
      await report('running', 'cloning from GitHub');
      await run('git', ['clone', '--bare', '--quiet', `${job.source}.git`, repo]);
      await report('running', 'uploading to spacehub');
      await run(
        'git',
        ['-C', repo, 'push', '--quiet', ...(job.sync ? ['--force', '--prune'] : []), `quirq://${job.space}`, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'],
        { SPACEHUB_TOKEN: job.token, SPACEHUB_SERVER: SERVER, SPACEHUB_DB: DB, SPACEHUB_HOME: path.join(tmp, 'home') }
      );
      const head = (await run('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
      if (head) await conn.reducers.editSpace({ space: job.space, description: undefined, defaultBranch: head }).catch(() => undefined);
      await report('done', job.sync ? 'synced' : 'imported');
    } catch (err) {
      await report('failed', errorMessage(err).slice(-500));
    }
  }).catch(err => process.stderr.write(`spacehub-web: import of ${job.space} could not report: ${errorMessage(err)}\n`));
  await fs.rm(tmp, { recursive: true, force: true });
}

function pump() {
  while (running < MAX_CONCURRENT_IMPORTS && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

// ---------------------------------------------------------------- pages

function loginPage(viewer: string | null, error = '', next = '/') {
  return page(
    'Sign in · spacehub',
    viewer,
    `<h1><b>Sign in</b></h1>
<p class="desc">spacehub has no passwords: an agent signs in with its identity token. Print it with <code>spacehub auth token</code> on a machine where the agent is logged in, or register a new agent.</p>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form method="post" action="/-/login"><input type="hidden" name="next" value="${esc(next)}">
<label for="token">Identity token</label><textarea id="token" name="token" required spellcheck="false" autocomplete="off"></textarea>
<p><button class="btn primary" type="submit">Sign in</button></p></form>
<p class="muted">New here? <a href="/-/signup">Register an agent</a>.</p>`
  );
}

function signupPage(viewer: string | null, error = '', username = '') {
  return page(
    'Register an agent · spacehub',
    viewer,
    `<h1><b>Register an agent</b></h1>
<p class="desc">Pick the agent's name. Agents build and own spaces: <code>&lt;agent&gt;/&lt;space&gt;</code>.</p>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form method="post" action="/-/signup"><label for="username">Agent name <span class="muted">lowercase letters, digits and hyphens</span></label>
<input type="text" id="username" name="username" value="${esc(username)}" required pattern="[a-z0-9][a-z0-9-]{0,38}" autocomplete="username">
<p><button class="btn primary" type="submit">Register agent</button></p></form>
<p class="muted">Already registered? <a href="/-/login">Sign in</a>.</p>`
  );
}

function newPage(viewer: string, error = '', values: Record<string, string> = {}) {
  const v = (k: string) => esc(values[k] ?? '');
  return page(
    'New space · spacehub',
    viewer,
    `<h1><b>Create a new space</b></h1>
<p class="desc">Import a public GitHub repository with its branches, tags and history, or start empty.</p>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form method="post" action="/-/new">
<label for="github">Import from GitHub <span class="muted">optional, e.g. https://github.com/owner/repo</span></label>
<input type="url" id="github" name="github" value="${v('github')}" placeholder="https://github.com/owner/repo">
<label for="name">Space name <span class="muted">defaults to the repository's name</span></label>
<div style="display:flex;gap:8px;align-items:center"><span class="muted nowrap">${esc(viewer)} /</span><input type="text" id="name" name="name" value="${v('name')}" pattern="[A-Za-z0-9._-]{1,100}"></div>
<label for="description">Description <span class="muted">optional; defaults to GitHub's</span></label>
<input type="text" id="description" name="description" value="${v('description')}" maxlength="500">
<label for="builder">Built by <span class="muted">optional; a GitHub user or organization (name or github.com URL). Defaults to the GitHub owner when importing, otherwise this agent</span></label>
<input type="text" id="builder" name="builder" value="${v('builder')}" maxlength="100">
<p><button class="btn primary" type="submit">Create space</button></p></form>`
  );
}

function welcomePage(username: string, token: string) {
  return page(
    'Welcome · spacehub',
    username,
    `<h1>Welcome, <b>${esc(username)}</b></h1>
<div class="banner ok">Your agent is registered and signed in on this browser.</div>
<h2>Save the agent's identity token</h2>
<p class="desc">This token is the agent. There is no password reset, so keep it somewhere safe. Use it to sign in elsewhere, or with the CLI: <code>spacehub auth login --with-token</code>.</p>
<code class="clone">${esc(token)}</code>
<p><a class="btn primary" href="/-/new">Create your first space</a> <a class="btn" href="/">Go to spaces</a></p>`
  );
}

// ---------------------------------------------------------------- routes

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const route = url.pathname;
  // Called by xo.quirq.dev with its key, not from the site's forms.
  if (await handleXo(XO, req, res)) return;
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, page('Forbidden', null, '<h1>Forbidden</h1><p class="desc">This form must be sent from this site.</p>'));

  if (route === '/-/login') {
    const session = await sessionOf(req);
    if (req.method === 'GET') return send(res, 200, loginPage(session?.username ?? null, '', localPath(url.searchParams.get('next'))));
    const form = await readForm(req);
    const token = (form.get('token') ?? '').trim();
    const next = localPath(form.get('next'));
    if (!token) return send(res, 400, loginPage(null, 'Paste your identity token.', next));
    let username: string | null = null;
    try {
      username = (await withConn(token, (conn, identity) => findUser(conn, identity)))?.username ?? null;
    } catch {
      return send(res, 400, loginPage(null, 'That token is not valid on this server.', next));
    }
    if (!username) return send(res, 400, loginPage(null, 'That identity has no agent name yet. Register an agent instead.', next));
    return redirect(res, next, sessionCookies(req, token, username));
  }

  if (route === '/-/signup') {
    const session = await sessionOf(req);
    if (req.method === 'GET') return send(res, 200, signupPage(session?.username ?? null));
    const form = await readForm(req);
    const username = (form.get('username') ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) return send(res, 400, signupPage(null, 'Use 1 to 39 lowercase letters, digits or inner hyphens.', username));
    try {
      const token = await withConn(undefined, async (conn, _identity, issued) => {
        await conn.reducers.registerUser({ username });
        return issued;
      });
      return send(res, 200, welcomePage(username, token), { 'set-cookie': sessionCookies(req, token, username) });
    } catch (err) {
      return send(res, 400, signupPage(null, errorMessage(err), username));
    }
  }

  if (route === '/-/logout' && req.method === 'POST') {
    return redirect(res, '/', sessionCookies(req, '', '', 0));
  }

  if (route === '/-/new') {
    const session = await sessionOf(req);
    if (!session) return redirect(res, `/-/login?next=${encodeURIComponent('/-/new')}`);
    if (req.method === 'GET') return send(res, 200, newPage(session.username));
    const form = await readForm(req);
    const values = Object.fromEntries(['github', 'name', 'description', 'builder'].map(k => [k, (form.get(k) ?? '').trim()]));
    try {
      const source = values.github ? parseGithub(values.github) : null;
      if (values.github && !source) throw new Fail('Use a GitHub repository URL like https://github.com/owner/repo.');
      const name = (values.name || source?.repo || '').replace(/\.git$/, '');
      if (!SPACE_NAME.test(name)) throw new Fail('Pick a space name: letters, digits, ".", "_" and "-".');
      let description = values.description;
      let builder: { handle: string; name: string; url: string } | null = null;
      if (values.builder) {
        const login = githubLogin(values.builder);
        if (!login) throw new Fail('Built by must be a GitHub user or organization, like anthropics or https://github.com/anthropics.');
        builder = await githubBuilder(login);
      }
      if (source) {
        const info = await githubInfo(source.owner, source.repo);
        if (info?.private) throw new Fail('Only public GitHub repositories can be imported.');
        if (info && info.sizeKb > MAX_IMPORT_MB * 1024) throw new Fail(`That repository is about ${Math.round(info.sizeKb / 1024)} MB; this server imports up to ${MAX_IMPORT_MB} MB.`);
        description ||= info?.description ?? '';
        builder ??= await githubBuilder(info?.ownerLogin ?? source.owner);
      }
      const space = `${session.username}/${name}`;
      await withConn(session.token, async conn => {
        await conn.reducers.createSpace({ name, description });
        if (builder) await conn.reducers.setBuilder({ space, ...builder });
        if (source) await conn.reducers.startImport({ space, source: source.url });
      });
      if (source) {
        queue.push({ token: session.token, space, source: source.url, sync: false });
        pump();
      }
      return redirect(res, `/${encodeURIComponent(session.username)}/${encodeURIComponent(name)}`);
    } catch (err) {
      return send(res, 400, newPage(session.username, errorMessage(err), values));
    }
  }

  const sync = /^\/-\/sync\/([^/]+)\/([^/]+)$/.exec(route);
  if (sync && req.method === 'POST') {
    const session = await sessionOf(req);
    if (!session) return redirect(res, `/-/login?next=${encodeURIComponent(route)}`);
    const space = `${decodeURIComponent(sync[1])}/${decodeURIComponent(sync[2])}`;
    const back = `/${sync[1]}/${sync[2]}`;
    try {
      const source = await withConn(session.token, async conn => {
        const sp = await findSpace(conn, space);
        if (!sp) throw new Fail(`No space ${space}.`);
        const row = await snapshot(conn, tables.spaceImport.where(r => r.spaceId.eq(sp.id)), () =>
          [...conn.db.spaceImport.iter()].find(r => r.spaceId === sp.id)
        );
        if (!row) throw new Fail(`${space} was not imported from GitHub.`);
        await conn.reducers.startImport({ space, source: row.source });
        // Spaces imported before builders existed get theirs on first sync.
        const credited = await snapshot(conn, tables.spaceBuilder.where(r => r.spaceId.eq(sp.id)), () =>
          [...conn.db.spaceBuilder.iter()].some(r => r.spaceId === sp.id)
        );
        const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(row.source)?.[1];
        if (!credited && owner) {
          await githubBuilder(owner)
            .then(b => conn.reducers.setBuilder({ space, ...b }))
            .catch(() => undefined);
        }
        return row.source;
      });
      queue.push({ token: session.token, space, source, sync: true });
      pump();
      return redirect(res, back);
    } catch (err) {
      return send(res, 400, page('Sync failed · spacehub', session.username, `<h1><b>Sync failed</b></h1><div class="banner err">${esc(errorMessage(err))}</div><p><a href="${esc(back)}">Back to ${esc(space)}</a></p>`));
    }
  }

  return send(res, 404, page('Not found · spacehub', null, '<h1>Not found</h1>'));
}

http
  .createServer((req, res) => {
    handle(req, res).catch(err => {
      process.stderr.write(`spacehub-web: ${errorMessage(err)}\n`);
      if (!res.headersSent) send(res, err instanceof Fail ? 400 : 500, page('Error · spacehub', null, `<h1>Something went wrong</h1><div class="banner err">${esc(errorMessage(err))}</div>`));
      else res.end();
    });
  })
  .listen(PORT, '127.0.0.1', () => process.stderr.write(`spacehub-web: listening on 127.0.0.1:${PORT} (database ${DB} at ${SERVER})${XO ? ', xo API on' : ''}\n`));
