// "Connect Agents Hub": one button that finds the person's Agents Hub on Launchpad and connects it as their runner.
// Served by the web service.
//
//   GET  /-/runners/agents-hub/start    a signed-in builder: off to XO's sign-in (Clerk), the one "Sign in with
//                                       xo" uses; already signed in there, it comes straight back
//   GET  /-/login/xo/callback           back with a code (the XO sign-in's own callback, already registered with
//                                       Clerk; web.ts sends states started here to this module). This hub swaps
//                                       the code itself for a short-lived pass (Clerk's public client and PKCE:
//                                       no secret), and asks Launchpad for the person's apps:
//                                       - has an Agents Hub (even one still starting): the pass is dropped, on to
//                                         "wait"
//                                       - has none (or one being deleted): the pass is held (HOLD_MS at most) and
//                                         back to Settings (?runner=nohub), whose dialog links Launchpad's own
//                                         create page (it fills the hub's XO API key) and asks "check" meanwhile
//                                       - has one that failed or is stopped: the pass is dropped, Settings
//                                         (?runner=hubfailed / hubstopped), to fix it on Launchpad
//   POST /-/runners/agents-hub/check    Settings' dialog, every few seconds: with the held pass, is the hub there
//                                       yet? JSON {state: "waiting" | "found" (+ go: where to send the browser) |
//                                       "failed" | "stopped" | "expired"}. Found, failed or stopped drops the pass;
//                                       so does HOLD_MS running out ("expired": the dialog offers a new sign-in)
//   GET|POST /-/runners/agents-hub/cancel   drops whatever this browser started here (and a held pass)
//   GET  /-/runners/agents-hub/wait     until the hub answers /healthz (refreshes itself), then the usual Connect
//                                       (workers.ts), where the person approves on their hub; after WAIT_MS,
//                                       Settings (?runner=hubslow)
//
// Nothing here is written down. The pass lives only in this process's memory: for the one request that lists the
// person's apps, or, when they have no hub yet, held for at most HOLD_MS while they create one on Launchpad, so they
// sign in to XO once per connect. It is never logged, never put in a cookie or a URL, never stored in the database,
// never sent to the browser. The only thing kept afterwards is what Connect always keeps: the runner and its connect
// token, sealed (workers.ts). The refresh token Clerk may also send (offline_access) is never even read.
//
// Each step is a random id kept here with the builder who started it, tied to the browser by an HttpOnly cookie.
// A step is taken only from that browser and that builder, so a link someone else made connects nothing. Outcomes
// reach Settings as ?runner=<code>, like Connect's.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { CALLBACK_ROUTE } from './xosignin.ts';
import { checkRunnerUrl } from './workerclient.ts';

export const START_ROUTE = '/-/runners/agents-hub/start';
export const CANCEL_ROUTE = '/-/runners/agents-hub/cancel';
export const WAIT_ROUTE = '/-/runners/agents-hub/wait';
export const CHECK_ROUTE = '/-/runners/agents-hub/check';
const ROUTES = new Set([START_ROUTE, CANCEL_ROUTE, WAIT_ROUTE, CHECK_ROUTE]);
export const COOKIE = 'spacehub_agents_hub';
const COOKIE_PATH = '/-/'; // reaches the XO callback and these routes
export const SIGNIN_MS = 10 * 60_000; // to sign in on XO
export const WAIT_MS = 15 * 60_000; // a new hub takes minutes to start
export const HOLD_MS = 10 * 60_000; // the most a pass is held, while the person creates their hub on Launchpad
export const CHECK_GAP_MS = 5_000; // at most one Launchpad lookup per held pass this often, however often "check" is asked
export const MAX_STEPS = 500;
export const MAX_PER_BUILDER = 5; // one person's flows in progress: a new one pushes out their oldest
const WAIT_GRACE_MS = 30 * 60_000; // an expired wait keeps its address this long, so its page can still say "slow"
const SETTINGS = '/#/settings';

const TEMPLATE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CODE = /^[A-Za-z0-9._~-]{1,512}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SCOPE = /^[a-z_ ]{1,100}$/;

export interface AgentsHubConfig {
  launchpad: string; // Launchpad's API, without /launchpad
  xo: string; // the XO server whose public GET /login names Clerk's sign-in
  template: string; // the template an Agents Hub is made from
  createPage: string | null; // Launchpad's page to create an Agents Hub on, linked from Settings when someone has none
}

function address(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not an address: ${raw}`);
  }
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (!(u.protocol === 'https:' || local) || u.username || u.password || u.search || u.hash) {
    throw new Error(`${name} must be an https address with nothing after the path`);
  }
  return u.href.replace(/\/+$/, '');
}

// On with SPACEHUB_LAUNCHPAD_API (and XO sign-in not turned off). The XO server is SPACEHUB_XO_URL, as for
// "Sign in with xo" (default https://xo.quirq.dev); the template SPACEHUB_LAUNCHPAD_TEMPLATE (default agents-hub).
// SPACEHUB_LAUNCHPAD_CREATE_PAGE (optional): where on Launchpad's website an Agents Hub is created, linked when someone
// has none yet (prod: https://app.xo.builders/launchpad/create/agents-hub; beta: .../launchpad/new, its catalog).
export function agentsHubConfig(env: NodeJS.ProcessEnv = process.env): AgentsHubConfig | null {
  const raw = (env.SPACEHUB_LAUNCHPAD_API ?? '').trim();
  if (!raw) return null;
  const xo = (env.SPACEHUB_XO_URL ?? '').trim() || 'https://xo.quirq.dev';
  if (xo === 'off') return null;
  const template = (env.SPACEHUB_LAUNCHPAD_TEMPLATE ?? '').trim() || 'agents-hub';
  if (!TEMPLATE.test(template)) throw new Error(`SPACEHUB_LAUNCHPAD_TEMPLATE is not a template name: ${template}`);
  const page = (env.SPACEHUB_LAUNCHPAD_CREATE_PAGE ?? '').trim();
  return {
    launchpad: address('SPACEHUB_LAUNCHPAD_API', raw), xo: address('SPACEHUB_XO_URL', xo), template,
    createPage: page ? address('SPACEHUB_LAUNCHPAD_CREATE_PAGE', page) : null,
  };
}

export interface AgentsHubDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<{ username: string } | null>;
  /** The XO sign-in callback (CALLBACK_ROUTE) as the browser reached this hub: Clerk sends the code there. */
  callbackUrl: (req: http.IncomingMessage) => string;
  /** The usual Connect for `owner` to `url` (workers.ts beginConnect): the consent page and its cookie. */
  connect: (owner: string, url: string, req: http.IncomingMessage) => Promise<{ to: string; cookie: string }>;
  /** A whole HTML page in the site's style. */
  page: (title: string, body: string) => string;
  /** Sends HTML with the site's headers. */
  send: (res: http.ServerResponse, status: number, html: string, extra?: Record<string, string | string[]>) => void;
  allowLocal?: boolean; // hubs at http://127.0.0.1 (tests and local development only)
}

// ---------------------------------------------------------------- steps, in memory only

type Step =
  | { kind: 'signin'; owner: string; verifier: string; redirect: string; until: number }
  | { kind: 'hold'; owner: string; pass: string; until: number; checked: number } // the only step with a pass
  | { kind: 'wait'; owner: string; url: string; until: number };
const steps = new Map<string, Step>();

export function resetAgentsHub() {
  steps.clear();
  clerkCache = null;
}

/** For tests: how many steps are held, and how many of them hold a pass. */
export function heldSteps(): { count: number; passes: number } {
  let passes = 0;
  for (const s of steps.values()) if (s.kind === 'hold') passes++;
  return { count: steps.size, passes };
}

/** Removes a step. A held pass is blanked first, so nothing refers to it any more. */
function drop(id: string) {
  const s = steps.get(id);
  if (s?.kind === 'hold') s.pass = '';
  steps.delete(id);
}

function newStep(step: Step, now: number): string {
  for (const [k, s] of steps) if (s.until + (s.kind === 'wait' ? WAIT_GRACE_MS : 0) <= now) drop(k);
  // One builder can't fill the table for everyone: past MAX_PER_BUILDER, their oldest steps go (Map order = oldest first).
  const theirs = [...steps].filter(([, s]) => s.owner === step.owner).map(([k]) => k);
  for (const k of theirs.slice(0, Math.max(0, theirs.length - MAX_PER_BUILDER + 1))) drop(k);
  if (steps.size >= MAX_STEPS) throw new Busy();
  const id = randomBytes(32).toString('base64url');
  steps.set(id, step);
  return id;
}

class Busy extends Error {}

// Each held pass is dropped at HOLD_MS by a timer that knows only the step's id, never the pass (unref: it never keeps
// the process alive). Ids are random and never reused.
function dropHoldLater(id: string) {
  setTimeout(() => { if (steps.get(id)?.kind === 'hold') drop(id); }, HOLD_MS).unref();
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieOf(req: http.IncomingMessage): string {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** This browser's own step of `kind`, for this builder, still in time; else null. */
function mine<K extends Step['kind']>(req: http.IncomingMessage, id: string, kind: K, owner: string, now: number): Extract<Step, { kind: K }> | null {
  const s = id ? steps.get(id) : undefined;
  const fromCookie = cookieOf(req);
  if (!s || s.kind !== kind || !fromCookie || !same(id, fromCookie) || s.owner !== owner) return null;
  if (s.until <= now) {
    drop(id);
    return null;
  }
  return s as Extract<Step, { kind: K }>;
}

/** Whether `url` is the XO callback coming back from a sign-in this module started (web.ts asks first). */
export function isAgentsHubReturn(url: URL): boolean {
  if (url.pathname !== CALLBACK_ROUTE) return false;
  const s = steps.get(url.searchParams.get('state') ?? '');
  return s?.kind === 'signin';
}

// ---------------------------------------------------------------- XO's sign-in (Clerk)

interface Clerk {
  authorize: string;
  token: string;
  clientId: string;
  scope: string;
}
let clerkCache: { until: number; clerk: Clerk | null } | null = null;

// What XO's public GET /login offers for browser sign-in: Clerk's address and the public client id.
async function clerkOf(cfg: AgentsHubConfig, now: number): Promise<Clerk | null> {
  if (clerkCache && clerkCache.until > now) return clerkCache.clerk;
  let clerk: Clerk | null = null;
  try {
    const res = await fetch(`${cfg.xo}/login`, { headers: { accept: 'application/json', 'user-agent': 'spacehub' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
    const b = res.ok ? ((await res.json()) as { data?: { browser?: Record<string, unknown> } })?.data?.browser : null;
    const { authorize, clientId, scope } = b ?? {};
    if (typeof authorize === 'string' && typeof clientId === 'string' && typeof scope === 'string' && CLIENT_ID.test(clientId) && SCOPE.test(scope)) {
      const u = new URL(authorize);
      const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if ((u.protocol === 'https:' || local) && !u.search && !u.hash && !u.username && u.pathname.endsWith('/oauth/authorize')) {
        clerk = { authorize: u.href, token: u.href.replace(/\/oauth\/authorize$/, '/oauth/token'), clientId, scope };
      }
    }
  } catch {
    clerk = null;
  }
  clerkCache = { until: now + (clerk ? 300_000 : 30_000), clerk };
  return clerk;
}

// The code, swapped for the pass. Only access_token is read: a refresh token, if Clerk sends one, is not kept.
async function passFor(clerk: Clerk, code: string, verifier: string, redirect: string): Promise<string> {
  const res = await fetch(clerk.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'spacehub' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clerk.clientId, code_verifier: verifier }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  const pass = body?.access_token;
  if (!res.ok || typeof pass !== 'string' || !pass) throw new Failure(`XO's sign-in answered ${res.status}.`);
  return pass;
}

// ---------------------------------------------------------------- Launchpad, with the pass (read only)

class Failure extends Error {}
class Refused extends Failure {} // Launchpad would not take the pass (401/403): a held one has run out

// The person's Agents Hub on Launchpad (its address and Launchpad's status for it), if they have one. One being
// deleted counts as none.
async function findHub(cfg: AgentsHubConfig, pass: string): Promise<{ url: string; status: string } | null> {
  const res = await fetch(`${cfg.launchpad}/launchpad/apps`, {
    headers: { authorization: `Bearer ${pass}`, accept: 'application/json', 'user-agent': 'spacehub' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) throw new Refused('Launchpad did not accept your XO sign-in.');
  const body = (await res.json().catch(() => null)) as { apps?: unknown } | null;
  if (res.status !== 200 || !Array.isArray(body?.apps)) throw new Failure(`Launchpad answered ${res.status}.`);
  const hub = (body.apps as Record<string, unknown>[]).find(a => a?.template === cfg.template && typeof a.url === 'string' && a.status !== 'deleting');
  return hub ? { url: String(hub.url), status: String(hub.status ?? '') } : null;
}

// ---------------------------------------------------------------- pages

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const waitPage = `<div class="page-title"><h1>Starting your Agents Hub</h1><p>Launchpad is starting it; this takes a few minutes. This page checks again by itself, then asks you to approve this hub on your Agents Hub.</p></div>
<p><a class="btn" href="${CANCEL_ROUTE}">Cancel</a></p>`;

function errorPage(text: string) {
  return `<div class="page-title"><h1>Connect Agents Hub</h1></div>
<div class="banner err">${esc(text)}</div>
<p><a class="btn primary" href="${START_ROUTE}">Try again</a> <a class="btn" href="${SETTINGS}">Back to Settings</a></p>`;
}

// ---------------------------------------------------------------- the routes

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Answers the request and returns true when it is one of this module's routes (or the XO callback for one of its
// sign-ins: see isAgentsHubReturn).
export async function handleAgentsHub(cfg: AgentsHubConfig | null, deps: AgentsHubDeps, req: http.IncomingMessage, res: http.ServerResponse, now = Date.now()): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://local');
  const isReturn = isAgentsHubReturn(url);
  if (!ROUTES.has(url.pathname) && !isReturn) return false;
  const methods = url.pathname === CHECK_ROUTE ? ['POST'] : url.pathname === CANCEL_ROUTE ? ['GET', 'POST'] : ['GET'];
  if (!methods.includes(req.method ?? '')) {
    if (isReturn) return false;
    res.writeHead(405, { allow: methods.join(', ') });
    res.end();
    return true;
  }

  const https = deps.callbackUrl(req).startsWith('https:');
  const cookie = (value: string, ms: number) =>
    `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ms / 1000)}${https ? '; Secure' : ''}`;
  const spent = cookie('', 0);
  const go = (location: string, cookies: string[] = []) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end();
    return true;
  };
  // For "check": a small JSON answer, never with a pass in it.
  const answer = (status: number, body: Record<string, string>, cookies: string[] = []) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end(JSON.stringify(body));
    return true;
  };
  // Settings says how it went (app: lib/agentshub.ts, lib/workers.ts). xodenied: "Allow access" was refused on XO;
  // xoexpired: an old, used or foreign step; xofailed: not set up here, or the hub could not be reached; nohub: none
  // yet; hubfailed / hubstopped: Launchpad has it but it failed to start or is stopped; hubslow: it did not answer
  // within WAIT_MS. (Connect's own codes, about the runner's consent page, stay workers.ts's.)
  type Outcome = 'xodenied' | 'xoexpired' | 'xofailed' | 'nohub' | 'hubfailed' | 'hubstopped' | 'hubslow';
  const settings = (code: Outcome) => `/?runner=${code}#/settings`;
  const outcome = (code: Outcome) => go(settings(code), [spent]);
  // Pages keep the site's own referrer policy. (Only redirects, whose next address may carry a code, send none.)
  const show = (status: number, body: string, extra: Record<string, string | string[]> = {}) => {
    deps.send(res, status, deps.page('Connect Agents Hub · spacehub', body), extra);
    return true;
  };

  const session = await deps.sessionOf(req).catch(() => null);
  if (!session) {
    if (url.pathname === CHECK_ROUTE) return answer(401, { state: 'expired' }, [spent]);
    return go(`/-/login?next=${encodeURIComponent(SETTINGS)}`, [spent]);
  }
  if (!cfg) return url.pathname === CHECK_ROUTE ? answer(404, { state: 'expired' }, [spent]) : outcome('xofailed');
  const owner = session.username;

  // The hub is (being) made: where the browser goes next. It answers: the usual Connect. Not yet: the wait page,
  // which checks again every few seconds. `up`: already seen answering, so it is not asked again.
  const nextFor = async (hubUrl: string, up = false): Promise<{ to: string; cookies: string[] }> => {
    let checked: string;
    try {
      checked = checkRunnerUrl(hubUrl, deps.allowLocal);
    } catch {
      process.stderr.write(`spacehub-web: agents hub: Launchpad named an address this hub will not use\n`);
      return { to: settings('xofailed'), cookies: [spent] };
    }
    if (up || await healthy(checked)) {
      try {
        const started = await deps.connect(owner, checked, req);
        return { to: started.to, cookies: [spent, started.cookie] };
      } catch (err) {
        process.stderr.write(`spacehub-web: agents hub: connecting ${checked} failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
        return { to: settings('xofailed'), cookies: [spent] };
      }
    }
    const id = newStep({ kind: 'wait', owner, url: checked, until: now + WAIT_MS }, now);
    return { to: WAIT_ROUTE, cookies: [cookie(id, WAIT_MS)] };
  };
  const toHub = async (hubUrl: string, up = false) => {
    const next = await nextFor(hubUrl, up);
    return go(next.to, next.cookies);
  };

  try {
    // ------------------------------------------------------------ start: off to XO's sign-in
    if (url.pathname === START_ROUTE) {
      const clerk = await clerkOf(cfg, now);
      if (!clerk) return show(503, errorPage('XO sign-in is not available right now. Try again in a minute.'));
      const verifier = randomBytes(48).toString('base64url');
      const redirect = deps.callbackUrl(req);
      const state = newStep({ kind: 'signin', owner, verifier, redirect, until: now + SIGNIN_MS }, now);
      const to = new URL(clerk.authorize);
      to.search = new URLSearchParams({
        // Only what is needed: never offline_access (a refresh token), whatever XO lists.
        response_type: 'code', client_id: clerk.clientId, redirect_uri: redirect, state,
        scope: clerk.scope.split(' ').filter(s => s && s !== 'offline_access').join(' '),
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      return go(to.href, [cookie(state, SIGNIN_MS)]);
    }

    // ------------------------------------------------------------ cancel: drop this browser's step (and a held pass)
    if (url.pathname === CANCEL_ROUTE) {
      const id = cookieOf(req);
      const s = id ? steps.get(id) : undefined;
      if (s && s.owner === owner) drop(id);
      return req.method === 'POST' ? answer(200, { state: 'cancelled' }, [spent]) : go(SETTINGS, [spent]);
    }

    // ------------------------------------------------------------ back from XO: the pass, to find the hub
    if (isReturn) {
      const state = url.searchParams.get('state') ?? '';
      const s = mine(req, state, 'signin', owner, now);
      steps.delete(state); // one try, whatever happens next
      if (!s) return outcome('xoexpired');
      if (url.searchParams.get('error')) return outcome('xodenied');
      const code = url.searchParams.get('code') ?? '';
      if (!CODE.test(code)) return outcome('xofailed');
      const clerk = await clerkOf(cfg, now);
      if (!clerk) return show(503, errorPage('XO sign-in is not available right now. Try again in a minute.'), { 'set-cookie': spent });
      const pass = await passFor(clerk, code, s.verifier, s.redirect);
      const hub = await findHub(cfg, pass);
      if (hub?.status === 'failed') return outcome('hubfailed'); // waiting would never end: say so now
      if (hub?.status === 'stopped') return outcome('hubstopped');
      if (hub) return await toHub(hub.url); // created, deploying or running: the pass is not kept
      // None yet: hold the pass while they create one on Launchpad, so "check" needs no second sign-in.
      const id = newStep({ kind: 'hold', owner, pass, until: now + HOLD_MS, checked: now }, now);
      dropHoldLater(id); // gone at HOLD_MS even if nobody asks again
      return go(settings('nohub'), [cookie(id, HOLD_MS)]);
    }

    // ------------------------------------------------------------ check: is the hub there yet? (Settings' dialog)
    if (url.pathname === CHECK_ROUTE) {
      const id = cookieOf(req);
      const s = mine(req, id, 'hold', owner, now); // run out, another browser or builder, or a restart: none
      if (!s) return answer(200, { state: 'expired' }, [spent]);
      if (now - s.checked < CHECK_GAP_MS) return answer(200, { state: 'waiting' }); // asked too often: no lookup
      s.checked = now;
      let hub: Awaited<ReturnType<typeof findHub>>;
      try {
        hub = await findHub(cfg, s.pass);
      } catch (err) {
        if (err instanceof Refused) { // the pass ran out at Clerk
          drop(id);
          return answer(200, { state: 'expired' }, [spent]);
        }
        process.stderr.write(`spacehub-web: agents hub: checking Launchpad failed: ${err instanceof Error ? err.name : 'error'}\n`);
        return answer(200, { state: 'waiting' }); // Launchpad hiccup: the dialog asks again
      }
      if (!hub) return answer(200, { state: 'waiting' });
      if (hub.status === 'failed' || hub.status === 'stopped') {
        drop(id);
        return answer(200, { state: hub.status }, [spent]);
      }
      // Where to go next first, then drop the pass: if that fails, the pass is still here for the next check.
      const next = await nextFor(hub.url);
      drop(id);
      return answer(200, { state: 'found', go: next.to }, next.cookies);
    }

    // ------------------------------------------------------------ wait until the hub answers
    if (url.pathname === WAIT_ROUTE) {
      const id = cookieOf(req);
      const before = id ? steps.get(id) : undefined;
      const s = mine(req, id, 'wait', owner, now);
      // This browser's own wait, run out: the hub never answered. Anything else: an old or foreign link.
      if (!s) return outcome(before?.kind === 'wait' && before.owner === owner && before.until <= now ? 'hubslow' : 'xoexpired');
      if (await healthy(s.url)) {
        drop(id);
        return await toHub(s.url, true);
      }
      return show(200, waitPage, { refresh: '5' });
    }
  } catch (err) {
    if (url.pathname === CHECK_ROUTE) return answer(200, { state: 'waiting' });
    if (err instanceof Busy) return show(429, errorPage('Too many connections are waiting; try again in a few minutes.'), { 'set-cookie': spent });
    if (err instanceof Failure) return show(502, errorPage(err.message), { 'set-cookie': spent });
    // Never the error's text: it may come from a request that carried the pass.
    process.stderr.write(`spacehub-web: agents hub: ${err instanceof Error ? err.name : 'error'}\n`);
    return show(502, errorPage('Something went wrong talking to XO or Launchpad. Try again.'), { 'set-cookie': spent });
  }
  return false;
}
