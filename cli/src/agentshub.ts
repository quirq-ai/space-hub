// "Connect Agents Hub": one button that finds the person's Agents Hub on Launchpad, or creates one, and connects
// it as their runner. Served by the web service.
//
//   GET  /-/runners/agents-hub/start    a signed-in builder: off to XO's sign-in (Clerk), the one "Sign in with
//                                       xo" uses; already signed in there, it comes straight back
//   GET  /-/login/xo/callback           back with a code (the XO sign-in's own callback, already registered with
//                                       Clerk; web.ts sends states started here to this module). This hub swaps
//                                       the code itself for a short-lived pass (Clerk's public client and PKCE:
//                                       no secret), asks Launchpad for the person's apps, and:
//                                       - has an Agents Hub: the pass is dropped, on to "wait"
//                                       - has none: on to the form, the pass held in memory for it
//   GET  /-/runners/agents-hub/create   the form: name, OpenAI keys, hub password
//   POST /-/runners/agents-hub/create   Launchpad creates the hub with the pass; the pass and the form are dropped
//   GET  /-/runners/agents-hub/cancel   drops whatever this browser started here
//   GET  /-/runners/agents-hub/wait     until the hub answers /healthz (refreshes itself), then the usual Connect
//                                       (workers.ts), where the person approves on their hub
//
// Nothing here is written down. The pass and the form's keys live only in this process's memory, for one try and
// at most 10 minutes; they are never logged, never put in a cookie or a URL, never stored in the database. The
// only thing kept afterwards is what Connect always keeps: the runner and its connect token, sealed (workers.ts).
// The refresh token Clerk may also send (offline_access) is never even read.
//
// Each step is a random id kept here with the builder who started it, tied to the browser by an HttpOnly cookie.
// A step is taken only from that browser and that builder, so a link someone else made connects nothing. Outcomes
// reach Settings as ?runner=<code>, like Connect's.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { CALLBACK_ROUTE } from './xosignin.ts';
import { checkRunnerUrl } from './workerclient.ts';

export const START_ROUTE = '/-/runners/agents-hub/start';
export const CREATE_ROUTE = '/-/runners/agents-hub/create';
export const CANCEL_ROUTE = '/-/runners/agents-hub/cancel';
export const WAIT_ROUTE = '/-/runners/agents-hub/wait';
const ROUTES = new Set([START_ROUTE, CREATE_ROUTE, CANCEL_ROUTE, WAIT_ROUTE]);
export const COOKIE = 'spacehub_agents_hub';
const COOKIE_PATH = '/-/'; // reaches the XO callback and these routes
export const SIGNIN_MS = 10 * 60_000; // to sign in on XO
export const FORM_MS = 10 * 60_000; // the most the pass is held, while the form is open
export const WAIT_MS = 15 * 60_000; // a new hub takes minutes to start
export const MAX_STEPS = 500;
const SETTINGS = '/#/settings';

// TODO(launchpad): Launchpad's API does not fill the hub's XO API key yet (only Launchpad's website does). Until it
// does, the hub gets this stand-in: it starts and connects, but cannot make sandboxes for chats. Once Launchpad
// fills `xoApiKey` itself (ignoring what the caller sends), remove this.
export const XO_API_KEY_PLACEHOLDER = 'placeholder-until-launchpad-fills-it';

const TEMPLATE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_NAME = /^[a-z0-9-]{1,25}$/; // as Launchpad takes it
const CODE = /^[A-Za-z0-9._~-]{1,512}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SCOPE = /^[a-z_ ]{1,100}$/;

export interface AgentsHubConfig {
  launchpad: string; // Launchpad's API, without /launchpad
  xo: string; // the XO server whose public GET /login names Clerk's sign-in
  template: string; // the template an Agents Hub is made from
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
export function agentsHubConfig(env: NodeJS.ProcessEnv = process.env): AgentsHubConfig | null {
  const raw = (env.SPACEHUB_LAUNCHPAD_API ?? '').trim();
  if (!raw) return null;
  const xo = (env.SPACEHUB_XO_URL ?? '').trim() || 'https://xo.quirq.dev';
  if (xo === 'off') return null;
  const template = (env.SPACEHUB_LAUNCHPAD_TEMPLATE ?? '').trim() || 'agents-hub';
  if (!TEMPLATE.test(template)) throw new Error(`SPACEHUB_LAUNCHPAD_TEMPLATE is not a template name: ${template}`);
  return { launchpad: address('SPACEHUB_LAUNCHPAD_API', raw), xo: address('SPACEHUB_XO_URL', xo), template };
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
  readForm: (req: http.IncomingMessage) => Promise<URLSearchParams>;
  allowLocal?: boolean; // hubs at http://127.0.0.1 (tests and local development only)
}

// ---------------------------------------------------------------- steps, in memory only

type Step =
  | { kind: 'signin'; owner: string; verifier: string; redirect: string; until: number }
  | { kind: 'form'; owner: string; pass: string; until: number }
  | { kind: 'wait'; owner: string; url: string; until: number };
const steps = new Map<string, Step>();

export function resetAgentsHub() {
  steps.clear();
  clerkCache = null;
}

/** For tests: how many steps are held, and whether any still holds a pass. */
export function heldSteps(): { count: number; passes: number } {
  let passes = 0;
  for (const s of steps.values()) if (s.kind === 'form') passes++;
  return { count: steps.size, passes };
}

function newStep(step: Step, now: number): string {
  for (const [k, s] of steps) if (s.until <= now) steps.delete(k);
  if (steps.size >= MAX_STEPS) throw new Busy();
  const id = randomBytes(32).toString('base64url');
  steps.set(id, step);
  return id;
}

class Busy extends Error {}

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
    steps.delete(id);
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

// ---------------------------------------------------------------- Launchpad, with the pass

class Failure extends Error {}

type LaunchpadApp = { url: string; template: string; status: string };

async function launchpad(cfg: AgentsHubConfig, pass: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${cfg.launchpad}/launchpad${path}`, {
    method,
    headers: { authorization: `Bearer ${pass}`, accept: 'application/json', 'user-agent': 'spacehub', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

// The person's Agents Hub on Launchpad, if they have one.
async function findHub(cfg: AgentsHubConfig, pass: string): Promise<LaunchpadApp | null> {
  const { status, body } = await launchpad(cfg, pass, 'GET', '/apps');
  if (status === 401 || status === 403) throw new Failure('Launchpad did not accept your XO sign-in.');
  if (status !== 200 || !Array.isArray(body?.apps)) throw new Failure(`Launchpad answered ${status}.`);
  const hub = (body.apps as Record<string, unknown>[]).find(a => a?.template === cfg.template && typeof a.url === 'string');
  return hub ? { url: String(hub.url), template: String(hub.template), status: String(hub.status ?? '') } : null;
}

// What Launchpad said was wrong, in a few words for the form (FastAPI's detail: text, {message, errors}, or a list).
function launchpadSays(body: Record<string, unknown> | null): string {
  const d = body?.detail as unknown;
  if (typeof d === 'string') return d.slice(0, 300);
  const list = Array.isArray(d) ? d : Array.isArray((d as { errors?: unknown })?.errors) ? (d as { errors: unknown[] }).errors : null;
  if (list) {
    return list.slice(0, 5).map(e => {
      if (typeof e === 'string') return e;
      const x = e as { loc?: unknown[]; msg?: unknown; field?: unknown; param?: unknown; message?: unknown };
      const where = x.field ?? x.param ?? (Array.isArray(x.loc) ? x.loc[x.loc.length - 1] : '');
      return `${where ? `${String(where)}: ` : ''}${String(x.msg ?? x.message ?? '')}`;
    }).join('; ').slice(0, 300);
  }
  if (typeof (d as { message?: unknown })?.message === 'string') return String((d as { message: string }).message).slice(0, 300);
  return '';
}

// ---------------------------------------------------------------- pages

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function formPage(error: string, name: string) {
  return `<div class="page-title"><h1>Create your Agents Hub</h1><p>You have no Agents Hub on Launchpad yet. It runs in your own Launchpad account, with your own OpenAI keys. This hub hands them to Launchpad once and keeps none of them.</p></div>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form class="signin-form" method="post" action="${CREATE_ROUTE}">
<label for="name">Name on Launchpad</label><input id="name" name="name" value="${esc(name)}" required maxlength="25" pattern="[a-z0-9\\-]{1,25}" spellcheck="false" autocapitalize="off" autocomplete="off">
<label for="openaiApiKey">OpenAI API key</label><input id="openaiApiKey" name="openaiApiKey" type="password" required autocomplete="off">
<label for="environmentKey">OpenAI environment key</label><input id="environmentKey" name="environmentKey" type="password" required autocomplete="off">
<label for="hubPassword">Hub password</label><input id="hubPassword" name="hubPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password">
<p class="muted">12 to 128 characters. You sign in to your hub with it, and type it once more in the next step to let this hub launch workers there.</p>
<label for="githubToken">GitHub token (optional)</label><input id="githubToken" name="githubToken" type="password" autocomplete="off">
<p><button class="btn primary" type="submit">Create Agents Hub</button> <a class="btn" href="${CANCEL_ROUTE}">Cancel</a></p>
</form>`;
}

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

  const https = deps.callbackUrl(req).startsWith('https:');
  const cookie = (value: string, ms: number) =>
    `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ms / 1000)}${https ? '; Secure' : ''}`;
  const spent = cookie('', 0);
  const go = (location: string, cookies: string[] = []) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end();
    return true;
  };
  const outcome = (code: 'denied' | 'expired' | 'failed') => go(`/?runner=${code}#/settings`, [spent]);
  // Pages keep the site's own referrer policy: with no-referrer, browsers send `Origin: null` on the form's POST,
  // and the site's same-origin check refuses it. (Only redirects, whose next address may carry a code, send none.)
  const show = (status: number, body: string, extra: Record<string, string | string[]> = {}) => {
    deps.send(res, status, deps.page('Connect Agents Hub · spacehub', body), extra);
    return true;
  };
  const allowed: Record<string, string> = { [START_ROUTE]: 'GET', [CANCEL_ROUTE]: 'GET', [WAIT_ROUTE]: 'GET' };
  if (!isReturn && url.pathname !== CREATE_ROUTE && req.method !== allowed[url.pathname]) {
    res.writeHead(405, { allow: allowed[url.pathname] });
    res.end();
    return true;
  }
  if (isReturn && req.method !== 'GET') return false;

  const session = await deps.sessionOf(req).catch(() => null);
  if (!session) return go(`/-/login?next=${encodeURIComponent(SETTINGS)}`, [spent]);
  if (!cfg) return outcome('failed');
  const owner = session.username;

  // The hub is (being) made: connect once it answers, else this page again in a few seconds.
  const toHub = async (hubUrl: string): Promise<boolean> => {
    let checked: string;
    try {
      checked = checkRunnerUrl(hubUrl, deps.allowLocal);
    } catch {
      process.stderr.write(`spacehub-web: agents hub: Launchpad named an address this hub will not use\n`);
      return outcome('failed');
    }
    if (await healthy(checked)) {
      try {
        const started = await deps.connect(owner, checked, req);
        return go(started.to, [spent, started.cookie]);
      } catch (err) {
        process.stderr.write(`spacehub-web: agents hub: connecting ${checked} failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
        return outcome('failed');
      }
    }
    const id = newStep({ kind: 'wait', owner, url: checked, until: now + WAIT_MS }, now);
    return go(WAIT_ROUTE, [cookie(id, WAIT_MS)]);
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
        response_type: 'code', client_id: clerk.clientId, redirect_uri: redirect, scope: clerk.scope, state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      return go(to.href, [cookie(state, SIGNIN_MS)]);
    }

    // ------------------------------------------------------------ cancel: drop this browser's step (and any pass)
    if (url.pathname === CANCEL_ROUTE) {
      const id = cookieOf(req);
      const s = id ? steps.get(id) : undefined;
      if (s && s.owner === owner) steps.delete(id);
      return go(SETTINGS, [spent]);
    }

    // ------------------------------------------------------------ back from XO: the pass, then find or form
    if (isReturn) {
      const state = url.searchParams.get('state') ?? '';
      const s = mine(req, state, 'signin', owner, now);
      steps.delete(state); // one try, whatever happens next
      if (!s) return outcome('expired');
      if (url.searchParams.get('error')) return outcome('denied');
      const code = url.searchParams.get('code') ?? '';
      if (!CODE.test(code)) return outcome('failed');
      const clerk = await clerkOf(cfg, now);
      if (!clerk) return show(503, errorPage('XO sign-in is not available right now. Try again in a minute.'), { 'set-cookie': spent });
      const pass = await passFor(clerk, code, s.verifier, s.redirect);
      const hub = await findHub(cfg, pass);
      if (hub) return await toHub(hub.url); // the pass goes out of scope here, unkept
      const id = newStep({ kind: 'form', owner, pass, until: now + FORM_MS }, now);
      return go(CREATE_ROUTE, [cookie(id, FORM_MS)]);
    }

    // ------------------------------------------------------------ the form, and creating the hub
    if (url.pathname === CREATE_ROUTE) {
      const id = cookieOf(req);
      const s = mine(req, id, 'form', owner, now);
      if (!s) return outcome('expired');
      if (req.method === 'GET') return show(200, formPage('', 'agents-hub'));
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' });
        res.end();
        return true;
      }
      const form = await deps.readForm(req);
      const field = (k: string) => (form.get(k) ?? '').trim();
      const name = field('name').toLowerCase();
      const again = (status: number, error: string) => show(status, formPage(error, APP_NAME.test(name) ? name : 'agents-hub'));
      if (!APP_NAME.test(name)) return again(400, 'The name takes 1 to 25 lowercase letters, digits or hyphens.');
      const hubPassword = form.get('hubPassword') ?? '';
      if (hubPassword.length < 12 || hubPassword.length > 128) return again(400, 'The hub password takes 12 to 128 characters.');
      if (!field('openaiApiKey') || !field('environmentKey')) return again(400, 'Both OpenAI keys are needed.');
      if ([...form.values()].some(v => v.length > 2000)) return again(400, 'One of the fields is too long.');
      const params: Record<string, string> = {
        openaiApiKey: field('openaiApiKey'),
        environmentKey: field('environmentKey'),
        hubPassword,
        xoApiKey: XO_API_KEY_PLACEHOLDER,
        ...(field('githubToken') ? { githubToken: field('githubToken') } : {}),
      };
      const made = await launchpad(cfg, s.pass, 'POST', '/apps', { template: cfg.template, name, params });
      if (made.status === 201 || made.status === 200) {
        steps.delete(id); // the pass is dropped
        const app = made.body?.app as { url?: unknown } | undefined;
        if (typeof app?.url !== 'string') return outcome('failed');
        return await toHub(app.url);
      }
      if (made.status === 401 || made.status === 403) {
        steps.delete(id);
        return show(401, errorPage('Your XO sign-in ran out. Press Try again to sign in once more.'), { 'set-cookie': spent });
      }
      if (made.status === 409) {
        // Another tab made a hub first (one per person), or the name is taken.
        const hub = await findHub(cfg, s.pass);
        if (hub) {
          steps.delete(id);
          return await toHub(hub.url);
        }
        return again(409, launchpadSays(made.body) || 'That name is taken on Launchpad; pick another.');
      }
      if (made.status === 429) return again(429, 'You have reached Launchpad\'s app limit. Delete an app on Launchpad, then try again.');
      if (made.status === 422) return again(422, `Launchpad refused these values${launchpadSays(made.body) ? `: ${launchpadSays(made.body)}` : '.'}`);
      process.stderr.write(`spacehub-web: agents hub: Launchpad answered ${made.status} to a create\n`);
      return again(502, 'Launchpad could not create the hub. Try again.');
    }

    // ------------------------------------------------------------ wait until the hub answers
    if (url.pathname === WAIT_ROUTE) {
      const id = cookieOf(req);
      const s = mine(req, id, 'wait', owner, now);
      if (!s) return outcome('expired');
      if (await healthy(s.url)) {
        steps.delete(id);
        return await toHub(s.url);
      }
      return show(200, waitPage, { refresh: '5' });
    }
  } catch (err) {
    if (err instanceof Busy) return show(429, errorPage('Too many connections are waiting; try again in a few minutes.'), { 'set-cookie': spent });
    if (err instanceof Failure) return show(502, errorPage(err.message), { 'set-cookie': spent });
    // Never the error's text: it may come from a request that carried the pass.
    process.stderr.write(`spacehub-web: agents hub: ${err instanceof Error ? err.name : 'error'}\n`);
    return show(502, errorPage('Something went wrong talking to XO or Launchpad. Try again.'), { 'set-cookie': spent });
  }
  return false;
}
