// Sign up and sign in to this website with GitHub, served by the web service:
//
//   GET /-/login/github?next=/path    off to GitHub, to approve the hub's OAuth App
//   GET /-/login/github/callback      back from it, signed in as that account's builder
//
// The same OAuth App and the same builders as the CLI's sign-in (signin.ts):
// a GitHub account's builder is named after its login, made on the first
// sign-in, and its hub token goes only into the HttpOnly session cookie.
// GitHub's token (no scopes: the public profile) is used once, to ask whose
// it is as the app, and never kept. Only the state and GitHub's code travel
// in URLs; the code works once, and only with the app's secret and the
// verifier kept here (PKCE).
//
// The app's callback URL on GitHub must be this hub's
// https://<host>/-/login/github/callback; the button shows whenever the app
// is set (SPACEHUB_GITHUB_CLIENT_ID and _SECRET).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Reply } from './admin.ts';
import { githubWeb, webToken } from './device.ts';
import { appUser, type SignInConfig, signInUser } from './signin.ts';

export const START_ROUTE = '/-/login/github';
export const CALLBACK_ROUTE = '/-/login/github/callback';
// Ties a sign-in to the browser that started it (HttpOnly, sent only to the two routes).
export const STATE_COOKIE = 'spacehub_github_signin';
export const WAIT_SECONDS = 600;

const CODE = /^[A-Za-z0-9._~-]{1,512}$/;

interface Pending {
  verifier: string;
  redirect: string;
  next: string;
  until: number;
}
const pending = new Map<string, Pending>();
export const MAX_PENDING = 500;
// Sign-ins started a minute across all visitors, so the route cannot be used
// to fill the table.
export const START_LIMIT = 60;
let window = { start: 0, count: 0 };

export function resetGithubSignIns() {
  pending.clear();
  window = { start: 0, count: 0 };
}

const b64url = (b: Buffer) => b.toString('base64url');

// A new sign-in: its state (for the cookie) and where to send the browser.
// `redirect` is this hub's callback, as the browser reached it.
export function startSignIn(cfg: SignInConfig, redirect: string, next: string, now = Date.now()): { state: string; location: string } {
  if (!cfg.app) throw new Reply(404, 'Sign-in with GitHub is not set up on this hub.');
  for (const [id, p] of pending) if (p.until <= now) pending.delete(id);
  if (now - window.start >= 60_000) window = { start: now, count: 0 };
  if (++window.count > START_LIMIT || pending.size >= MAX_PENDING) {
    throw new Reply(429, 'Too many sign-ins on this hub right now; try again in a minute.');
  }
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { verifier, redirect, next, until: now + WAIT_SECONDS * 1000 });
  const query = new URLSearchParams({
    client_id: cfg.app.clientId,
    redirect_uri: redirect,
    state,
    allow_signup: 'true',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return { state, location: `${cfg.web ?? githubWeb()}/login/oauth/authorize?${query}` };
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface Returned {
  state: string | null; // from the URL
  cookie: string | null; // STATE_COOKIE
  code: string | null;
  error: string | null;
}

// Back from GitHub: the builder this browser signs in as, its token, and
// where to go next. Every refusal is a Reply whose message the page shows.
export async function finishSignIn(cfg: SignInConfig, back: Returned, now = Date.now()): Promise<{ username: string; token: string; next: string; created: boolean }> {
  const p = back.state ? pending.get(back.state) : undefined;
  if (!back.state || !back.cookie || !p || !sameText(back.state, back.cookie)) {
    throw new Reply(400, 'This sign-in is not the one this browser started, or it was already used. Sign in again.');
  }
  pending.delete(back.state);
  if (p.until <= now) throw new Reply(400, 'The sign-in took more than 10 minutes. Sign in again.');
  if (back.error) {
    const why = /^[a-z_]{1,60}/.exec(back.error)?.[0];
    throw new Reply(400, why === 'access_denied' ? 'The sign-in was cancelled on GitHub.' : `The sign-in with GitHub was not finished${why ? ` (${why})` : ''}.`);
  }
  if (!cfg.app) throw new Reply(404, 'Sign-in with GitHub is not set up on this hub.');
  if (!back.code || !CODE.test(back.code)) throw new Reply(400, 'GitHub sent no sign-in code. Sign in again.');
  let token: string;
  try {
    token = await webToken(cfg.web ?? githubWeb(), cfg.app, back.code, p.redirect, p.verifier);
  } catch (err) {
    throw new Reply(502, (err as Error).message);
  }
  const out = await signInUser(cfg, await appUser(cfg.github, cfg.app, token));
  return { username: out.builder, token: out.token, next: p.next, created: out.created };
}
