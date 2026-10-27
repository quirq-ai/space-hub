// Sign up and sign in with GitHub, served by the web service:
//
//   GET  /-/api/auth/github/app
//     200 {"client_id": "..."}: this hub has a GitHub OAuth App; sign in with
//     GitHub's device flow for it. 404: it has none (send a gh token).
//   POST /-/api/auth/github   Authorization: Bearer <a GitHub token>
//     200 {"builder": "octocat", "token": "...", "created": true | false}
//     401 GitHub does not take the token as a user's (or, with an app, as one
//     made for it); 403 not a user account, or builders come from xo; 409 the
//     name is taken or reserved here
//
// With an OAuth App (SPACEHUB_GITHUB_CLIENT_ID and _SECRET), `spacehub auth
// login` gets a token with no scopes from GitHub's device flow for that app:
// it can read nothing private and act as no one, and this service accepts
// only tokens GitHub says were made for its own app, so a token sent to some
// other hub cannot sign in here. Without an app, the CLI sends the token of
// the GitHub account logged in on that machine (gh auth token, or GH_TOKEN).
// This service asks GitHub whose it is, then answers with that account's builder and hub token, making the
// builder on the first call: named after the GitHub login, with a new
// identity whose token the hub keeps (the private github_account table), so
// the same account signs in again on any machine. The GitHub token is used
// for that one question and never kept or logged.
//
// It acts as the hub admin over SpacetimeDB's HTTP API (admin.ts, imported
// with its extension so the tests run it as it is).
import http from 'node:http';
import { type AdminHttp, call, json, newIdentity, Reply, select } from './admin.ts';
import type { GithubApi } from './github';

export const SIGNIN_ROUTE = '/-/api/auth/github';
export const APP_ROUTE = '/-/api/auth/github/app';

// The hub's GitHub OAuth App, for the device flow. The secret is only ever
// sent to GitHub, to ask whether a token was made for this app.
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface SignInConfig extends AdminHttp {
  github: GithubApi;
  app?: OAuthApp;
}

export const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

// SPACEHUB_GITHUB_CLIENT_ID and SPACEHUB_GITHUB_CLIENT_SECRET, both or neither.
export function oauthApp(env: NodeJS.ProcessEnv = process.env): OAuthApp | undefined {
  const clientId = (env.SPACEHUB_GITHUB_CLIENT_ID ?? '').trim();
  const clientSecret = (env.SPACEHUB_GITHUB_CLIENT_SECRET ?? '').trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret || !CLIENT_ID.test(clientId)) {
    throw new Error('SPACEHUB_GITHUB_CLIENT_ID and SPACEHUB_GITHUB_CLIENT_SECRET go together: set both (an OAuth App\'s client id and secret), or neither');
  }
  return { clientId, clientSecret };
}

// Needs the hub admin's token; without it there is no GitHub sign-in.
export function signInConfig(db: string, http: string, github: GithubApi, app = oauthApp()): SignInConfig | null {
  const adminToken = process.env.SPACEHUB_ADMIN_TOKEN ?? '';
  return adminToken ? { adminToken, http, db, github, ...(app ? { app } : {}) } : null;
}

// Whose GitHub token this is. Only a user account signs in.
export async function githubUser(api: GithubApi, token: string): Promise<{ id: number; login: string }> {
  let res: Response;
  try {
    res = await fetch(`${api.base}/user`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'spacehub', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Reply(502, 'GitHub did not answer; try again');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Reply(401, 'GitHub did not accept that token as a user\'s login; log in again with "gh auth login"');
  }
  if (!res.ok) throw new Reply(502, `GitHub answered ${res.status} when asked whose token this is`);
  return checkedUser((await res.json().catch(() => null)) as { id?: unknown; login?: unknown; type?: unknown } | null);
}

// Whose token this is, asked as the hub's OAuth App: GitHub answers only for a
// token made for this app (POST /applications/{client_id}/token), so a token
// of another app (gh's, or another hub's) does not sign in.
export async function appUser(api: GithubApi, app: OAuthApp, token: string): Promise<{ id: number; login: string }> {
  let res: Response;
  try {
    res = await fetch(`${api.base}/applications/${encodeURIComponent(app.clientId)}/token`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'spacehub',
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: token }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Reply(502, 'GitHub did not answer; try again');
  }
  if (res.status === 404 || res.status === 422) {
    throw new Reply(401, 'GitHub did not take that token as one made for this hub\'s sign-in; run spacehub auth login again');
  }
  if (res.status === 401) throw new Reply(502, 'GitHub refused this hub\'s OAuth App (check its client id and secret)');
  if (!res.ok) throw new Reply(502, `GitHub answered ${res.status} when asked whose token this is`);
  const body = (await res.json().catch(() => null)) as { user?: { id?: unknown; login?: unknown; type?: unknown } } | null;
  return checkedUser(body?.user ?? null);
}

function checkedUser(body: { id?: unknown; login?: unknown; type?: unknown } | null): { id: number; login: string } {
  const id = body?.id;
  if (typeof body?.login !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Reply(502, 'GitHub sent an account without a login or id');
  }
  if (body.type !== 'User') throw new Reply(403, `${body.login} is not a GitHub user account; sign in as yourself`);
  return { id, login: body.login };
}

// Where builders come from on this hub (hub_state "accounts"; none is open).
export async function accountsSetting(cfg: AdminHttp): Promise<string> {
  const [row] = await select(cfg, "SELECT value FROM hub_state WHERE key = 'accounts'");
  return row ? String(row.value) : 'open';
}

// `id` is a checked whole number, so it goes into the SQL as it is.
async function builderOf(cfg: AdminHttp, id: number) {
  const [row] = await select(cfg, `SELECT username, token FROM github_account WHERE github_id = ${id}`);
  return row ? { builder: String(row.username), token: String(row.token) } : null;
}

export async function signIn(cfg: SignInConfig, githubToken: string) {
  const user = cfg.app ? await appUser(cfg.github, cfg.app, githubToken) : await githubUser(cfg.github, githubToken);
  const known = await builderOf(cfg, user.id);
  if (known) return { ...known, created: false };
  if ((await accountsSetting(cfg)) === 'xo') throw new Reply(403, 'builders on this hub are made by xo: run xo login');
  const made = await newIdentity(cfg);
  try {
    await call(cfg, 'github_link_builder', [user.id, user.login, made.identity, made.token]);
  } catch (err) {
    // Another sign-in for the same account made it first: that one stands.
    const raced = await builderOf(cfg, user.id);
    if (raced) return { ...raced, created: false };
    if (err instanceof Reply && /is taken|is reserved|a name is/.test(err.message)) {
      const why = /"[^"]*" is (taken|reserved)/.exec(err.message)?.[0] ?? err.message;
      throw new Reply(409, `cannot sign up ${user.login}: the name ${why} on this hub; ask the hub's admin`);
    }
    throw err;
  }
  return { builder: user.login.toLowerCase(), token: made.token, created: true };
}

// At most SIGNIN_LIMIT sign-ins a minute across all callers, so the route
// cannot be used to make GitHub API calls (or builders) in bulk. Counted per
// process; the hub runs one web service.
export const SIGNIN_LIMIT = 30;
let window = { start: 0, count: 0 };
function overLimit(now = Date.now()) {
  if (now - window.start >= 60_000) window = { start: now, count: 0 };
  return ++window.count > SIGNIN_LIMIT;
}
export function resetSignInLimit() {
  window = { start: 0, count: 0 };
}

// Answers the request and returns true when it is the sign-in route.
export async function handleSignIn(cfg: SignInConfig | null, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const route = new URL(req.url ?? '/', 'http://local').pathname;
  if (route === APP_ROUTE) {
    if (req.method !== 'GET') json(res, 405, { error: 'method not allowed' });
    else if (cfg?.app) json(res, 200, { client_id: cfg.app.clientId });
    else json(res, 404, { error: 'this hub has no GitHub OAuth App; sign in with the GitHub CLI\'s token' });
    return true;
  }
  if (route !== SIGNIN_ROUTE) return false;
  try {
    if (!cfg) throw new Reply(503, 'GitHub sign-in is not set up on this server (it needs the hub admin\'s token)');
    if (req.method !== 'POST') throw new Reply(405, 'method not allowed');
    if (overLimit()) throw new Reply(429, 'too many sign-ins on this hub right now; try again in a minute');
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new Reply(401, 'send a GitHub token as "Authorization: Bearer <token>"');
    json(res, 200, await signIn(cfg, m[1]));
  } catch (err) {
    // A database refusal that signIn did not turn into a 409 is not shown as it is.
    if (err instanceof Reply) json(res, err.status, { error: err.status === 530 ? 'the hub database refused this' : err.message });
    else {
      process.stderr.write(`spacehub-web: github sign-in: ${err instanceof Error ? err.message : String(err)}\n`);
      json(res, 500, { error: 'internal error' });
    }
  }
  return true;
}
