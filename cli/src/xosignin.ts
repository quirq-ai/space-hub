// Sign in to this website with xo, served by the web service:
//
//   GET /-/login/xo?next=/path    off to XO's own sign-in (Clerk), the one xo login uses
//   GET /-/login/xo/callback      back from it, signed in as the visitor's xo builder
//
// This hub is a client of xo login's Clerk OAuth application (public, with
// PKCE), and the xo server swaps the code: POST <xo>/login/hub, with this
// hub's xo key, answers the Clerk user id and their builder: the builder of
// the GitHub account they connected to XO, which the xo server has the hub
// make on the first sign-in (xo.ts). Without a connected GitHub account the
// xo server says where to connect one (ConnectGithub), and the page sends
// the visitor there. The builder's token
// never leaves this server: it comes from the private xo_agent table and goes
// only into the HttpOnly session cookie. Only the state and the code travel in
// URLs; the code works once, and only with the verifier kept here.
//
// The button shows only while the xo server's GET /login offers this hub's
// callback, which it does once the callback is a redirect URL of the Clerk
// application (XO_HUB_LOGIN_REDIRECT there).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Reply } from './admin.ts';
import { agentOf, type XoConfig } from './xo.ts';

export const START_ROUTE = '/-/login/xo';
export const CALLBACK_ROUTE = '/-/login/xo/callback';
// Ties a sign-in to the browser that started it (HttpOnly, sent only to the two routes).
export const STATE_COOKIE = 'spacehub_xo_signin';
export const WAIT_SECONDS = 600;
// How long the xo server's answer to GET /login is kept: the button's state.
const OFFER_SECONDS = 300;
const NO_OFFER_SECONDS = 60;

const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SCOPE = /^[a-z ]{1,100}$/;
const CODE = /^[A-Za-z0-9._~-]{1,512}$/; // as the xo server takes it
const SUBJECT = /^[A-Za-z0-9_]{1,64}$/;

export interface XoSignInConfig {
  xo: XoConfig;
  server: string; // the xo server, https://xo.quirq.dev
}

// https, or http to this machine (tests).
function upstream(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SPACEHUB_XO_URL is not an address: ${raw}`);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.username || u.search || u.hash) {
    throw new Error('SPACEHUB_XO_URL must be an https address with nothing after the path');
  }
  return u.href.replace(/\/+$/, '');
}

// On whenever the xo API is (SPACEHUB_XO_KEY): the xo server is
// SPACEHUB_XO_URL, by default https://xo.quirq.dev; "off" turns it off.
export function xoSignInConfig(xo: XoConfig | null, env: NodeJS.ProcessEnv = process.env): XoSignInConfig | null {
  if (!xo) return null;
  const raw = (env.SPACEHUB_XO_URL ?? '').trim() || 'https://xo.quirq.dev';
  return raw === 'off' ? null : { xo, server: upstream(raw) };
}

// ---------------------------------------------------------------- the offer

export interface Offer {
  authorize: string; // Clerk's /oauth/authorize
  clientId: string;
  scope: string;
  redirect: string; // this hub's callback, as registered with Clerk
}

let cache: { until: number; offer: Offer | null } | null = null;
let asking: Promise<Offer | null> | null = null;

function offerIn(body: unknown): Offer | null {
  const data = (body as { data?: { browser?: Record<string, unknown> | null; hub?: Record<string, unknown> } } | null)?.data;
  const browser = data?.browser;
  const redirect = data?.hub?.redirect;
  if (!browser || typeof redirect !== 'string') return null;
  const { authorize, clientId, scope } = browser;
  if (typeof authorize !== 'string' || typeof clientId !== 'string' || typeof scope !== 'string') return null;
  if (!CLIENT_ID.test(clientId) || !SCOPE.test(scope)) return null;
  try {
    const u = new URL(authorize);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) return null;
    if (u.search || u.hash || u.username) return null;
  } catch {
    return null;
  }
  return { authorize, clientId, scope, redirect };
}

async function askXo(cfg: XoSignInConfig): Promise<Offer | null> {
  try {
    const res = await fetch(`${cfg.server}/login`, {
      headers: { accept: 'application/json', 'user-agent': 'spacehub' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? offerIn(await res.json()) : null;
  } catch {
    return null;
  }
}

// The sign-in the xo server offers this hub, if its callback is `callback`
// (this hub as the browser reached it): else there is no button.
export async function offerFor(cfg: XoSignInConfig | null, callback: string, now = Date.now()): Promise<Offer | null> {
  if (!cfg) return null;
  if (!cache || cache.until <= now) {
    asking ??= askXo(cfg).then(offer => {
      cache = { until: Date.now() + (offer ? OFFER_SECONDS : NO_OFFER_SECONDS) * 1000, offer };
      return offer;
    }).finally(() => {
      asking = null;
    });
    await asking;
  }
  const offer = cache?.offer ?? null;
  return offer && offer.redirect === callback ? offer : null;
}

export function forgetOffer() {
  cache = null;
}

// ---------------------------------------------------------------- sign-ins

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

export function resetXoSignIns() {
  pending.clear();
  window = { start: 0, count: 0 };
}

const b64url = (b: Buffer) => b.toString('base64url');

// A new sign-in: its state (for the cookie) and where to send the browser.
export function startSignIn(offer: Offer, next: string, now = Date.now()): { state: string; location: string } {
  for (const [id, p] of pending) if (p.until <= now) pending.delete(id);
  if (now - window.start >= 60_000) window = { start: now, count: 0 };
  if (++window.count > START_LIMIT || pending.size >= MAX_PENDING) {
    throw new Reply(429, 'Too many sign-ins on this hub right now; try again in a minute.');
  }
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48)); // 64 characters, within RFC 7636's 43 to 128
  pending.set(state, { verifier, redirect: offer.redirect, next, until: now + WAIT_SECONDS * 1000 });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: offer.clientId,
    redirect_uri: offer.redirect,
    scope: offer.scope,
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return { state, location: `${offer.authorize}?${query}` };
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// XO has no GitHub account for this user: the page where they connect one.
export class ConnectGithub extends Reply {
  url: string;
  next: string; // where the sign-in was going
  constructor(message: string, url: string, next = '/') {
    super(409, message);
    this.url = url;
    this.next = next;
  }
}

// An https page (http only to this machine, in tests), or "".
function pageUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 500) return '';
  try {
    const u = new URL(raw);
    const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
    return (u.protocol === 'https:' || local) && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

export interface Returned {
  state: string | null; // from the URL
  cookie: string | null; // STATE_COOKIE
  code: string | null;
  error: string | null;
}

// Back from Clerk: the builder this browser signs in as, its token, and where
// to go next. Every refusal is a Reply whose message the page shows.
export async function finishSignIn(cfg: XoSignInConfig, back: Returned, now = Date.now()): Promise<{ username: string; token: string; next: string }> {
  const p = back.state ? pending.get(back.state) : undefined;
  if (!back.state || !back.cookie || !p || !sameText(back.state, back.cookie)) {
    throw new Reply(400, 'This sign-in is not the one this browser started, or it was already used. Sign in again.');
  }
  pending.delete(back.state);
  if (p.until <= now) throw new Reply(400, 'The sign-in took more than 10 minutes. Sign in again.');
  if (back.error) {
    const why = /^[a-z_]{1,60}/.exec(back.error)?.[0]; // OAuth's error code, nothing after it
    throw new Reply(400, `The sign-in with xo was not finished${why ? ` (${why})` : ''}.`);
  }
  if (!back.code || !CODE.test(back.code)) throw new Reply(400, 'XO sent no sign-in code. Sign in again.');
  let res: Response;
  try {
    res = await fetch(`${cfg.server}/login/hub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'spacehub', authorization: `Bearer ${cfg.xo.key}` },
      body: JSON.stringify({ code: back.code, verifier: p.verifier, redirect: p.redirect }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Reply(502, 'XO did not answer. Try again.');
  }
  const body = (await res.json().catch(() => null)) as { data?: { subject?: unknown; agent?: unknown }; error?: unknown; connect?: unknown } | null;
  if (!res.ok) {
    const said = typeof body?.error === 'string' ? body.error.slice(0, 300) : '';
    const connect = pageUrl(body?.connect);
    if (res.status === 409 && connect) throw new ConnectGithub(said || 'Connect GitHub to your XO account first.', connect, p.next);
    throw new Reply(res.status < 500 ? 400 : 502, said ? `XO: ${said}` : `XO answered ${res.status}. Try again.`);
  }
  const subject = body?.data?.subject;
  const agent = body?.data?.agent;
  if (typeof subject !== 'string' || !SUBJECT.test(subject) || typeof agent !== 'string') {
    throw new Reply(502, 'XO sent an answer this hub cannot read.');
  }
  const found = await agentOf(cfg.xo, subject);
  if (!found || found.agent !== agent) throw new Reply(502, `XO named the builder ${agent}, which this hub does not have.`);
  return { username: found.agent, token: found.token, next: p.next };
}
