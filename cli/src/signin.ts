// Sign up and sign in with GitHub, served by the web service.
//
// With the hub's GitHub OAuth App (SPACEHUB_GITHUB_CLIENT_ID and _SECRET),
// the hub runs GitHub's device flow itself:
//
//   POST /-/api/auth/github/device
//     200 {"session": "...", "user_code": "ABCD-1234", "verification_uri":
//     "https://github.com/login/device", "interval": 5, "expires_in": 900}
//     404: this hub has no OAuth App (sign in with a gh token below)
//   POST /-/api/auth/github/device/poll   {"session": "..."}
//     200 {"status": "pending", "interval": 5} until the person says yes on
//     GitHub, then 200 {"status": "done", "builder", "token", "created"};
//     403 they said no, or not a user account; 410 the code ran out
//
// GitHub hands the token (no scopes: it reads only the public profile) to the
// hub, which polls with a device code only it holds; it never passes through
// the CLI, so no other server can be handed one to replay here, and a bearer
// token sent to POST /-/api/auth/github is refused.
//
// Without an app:
//
//   POST /-/api/auth/github   Authorization: Bearer <a GitHub token>
//     200 {"builder": "octocat", "token": "...", "created": true | false}
//     401 GitHub does not take the token as a user's; 403 not a user account,
//     or builders come from xo; 409 the name is taken or reserved here
//
// The CLI sends the token of the GitHub account logged in on that machine
// (gh auth token, or GH_TOKEN) and this service asks GitHub whose it is.
//
// Either way the service answers with that account's builder and hub token,
// making the builder on the first sign-in: named after the GitHub login, with
// a new identity whose token the hub keeps (the private github_account table),
// so the same account signs in again on any machine. The GitHub token is used
// to ask whose it is and never kept or logged.
//
// It acts as the hub admin over SpacetimeDB's HTTP API (admin.ts, imported
// with its extension so the tests run it as it is).
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { type AdminHttp, call, json, newIdentity, readJson, Reply, select } from './admin.ts';
import { deviceCode, githubWeb, pollToken } from './device.ts';
import type { GithubApi } from './github';

export const SIGNIN_ROUTE = '/-/api/auth/github';
export const DEVICE_ROUTE = '/-/api/auth/github/device';
export const POLL_ROUTE = '/-/api/auth/github/device/poll';

// The hub's GitHub OAuth App, for the device flow. The secret is only ever
// sent to GitHub, to ask whether a token was made for this app.
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface SignInConfig extends AdminHttp {
  github: GithubApi;
  app?: OAuthApp;
  web?: string; // github.com, where the device flow runs (a stand-in in tests)
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
  return adminToken ? { adminToken, http, db, github, ...(app ? { app, web: githubWeb() } : {}) } : null;
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

// Whose token this is, asked as the hub's OAuth App (POST
// /applications/{client_id}/token): GitHub answers only for a token made for
// this app, which here is one the hub's own device flow just received.
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
  return signInUser(cfg, await githubUser(cfg.github, githubToken));
}

// The builder of a GitHub account, made on its first sign-in (also the
// website's sign-in, githubsignin.ts).
export async function signInUser(cfg: SignInConfig, user: { id: number; login: string }) {
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

// Device sign-ins in progress, by a random session id only the CLI that
// started one knows. The device code GitHub polls with stays here.
interface Pending {
  device: string;
  interval: number; // seconds between questions to GitHub
  next: number; // not asked again before this time
  until: number;
}
const pending = new Map<string, Pending>();
export const MAX_PENDING = 500;

function prune(now: number) {
  for (const [id, p] of pending) if (p.until <= now) pending.delete(id);
}

async function startDevice(cfg: SignInConfig, app: OAuthApp) {
  const now = Date.now();
  prune(now);
  if (pending.size >= MAX_PENDING) throw new Reply(429, 'too many sign-ins on this hub right now; try again in a minute');
  let code;
  try {
    code = await deviceCode(cfg.web ?? githubWeb(), app.clientId);
  } catch (err) {
    throw new Reply(502, (err as Error).message);
  }
  const session = randomBytes(32).toString('base64url');
  const interval = Math.max(1, code.interval);
  pending.set(session, { device: code.device_code, interval, next: now + interval * 1000, until: now + code.expires_in * 1000 });
  return { session, user_code: code.user_code, verification_uri: code.verification_uri, interval, expires_in: code.expires_in };
}

async function pollDevice(cfg: SignInConfig, app: OAuthApp, session: unknown) {
  const now = Date.now();
  const p = typeof session === 'string' ? pending.get(session) : undefined;
  if (!p || p.until <= now) {
    if (typeof session === 'string') pending.delete(session);
    throw new Reply(410, 'this sign-in ran out or is unknown here; run spacehub auth login again');
  }
  if (now < p.next) return { status: 'pending', interval: p.interval };
  p.next = now + p.interval * 1000;
  let poll;
  try {
    poll = await pollToken(cfg.web ?? githubWeb(), app.clientId, p.device);
  } catch (err) {
    throw new Reply(502, (err as Error).message);
  }
  if (poll.kind === 'pending') {
    if (poll.interval) {
      p.interval = Math.max(p.interval, poll.interval);
      p.next = now + p.interval * 1000;
    }
    return { status: 'pending', interval: p.interval };
  }
  pending.delete(session as string);
  if (poll.kind === 'denied') throw new Reply(403, 'sign-in was cancelled on GitHub');
  if (poll.kind === 'expired') throw new Reply(410, 'the code ran out before it was entered; run spacehub auth login again');
  return { status: 'done', ...(await signInUser(cfg, await appUser(cfg.github, app, poll.token))) };
}

export function resetDeviceSignIns() {
  pending.clear();
}

// Tests: let every pending sign-in ask GitHub again now.
export function skipDeviceWaits() {
  for (const p of pending.values()) p.next = 0;
}

// Answers the request and returns true when it is a sign-in route.
export async function handleSignIn(cfg: SignInConfig | null, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const route = new URL(req.url ?? '/', 'http://local').pathname;
  if (route !== SIGNIN_ROUTE && route !== DEVICE_ROUTE && route !== POLL_ROUTE) return false;
  try {
    if (route !== SIGNIN_ROUTE && !cfg?.app) throw new Reply(404, 'this hub has no GitHub OAuth App; sign in with the GitHub CLI\'s token');
    if (!cfg) throw new Reply(503, 'GitHub sign-in is not set up on this server (it needs the hub admin\'s token)');
    if (req.method !== 'POST') throw new Reply(405, 'method not allowed');
    if (route === POLL_ROUTE) {
      json(res, 200, await pollDevice(cfg, cfg.app!, (await readJson(req)).session));
      return true;
    }
    if (overLimit()) throw new Reply(429, 'too many sign-ins on this hub right now; try again in a minute');
    if (route === DEVICE_ROUTE) {
      json(res, 200, await startDevice(cfg, cfg.app!));
      return true;
    }
    if (cfg.app) throw new Reply(403, 'this hub signs in with a code from GitHub, not a token: update spacehub (git pull, then scripts/install-cli.sh)');
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
