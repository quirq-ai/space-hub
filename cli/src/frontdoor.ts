// Members-only at the front door (access-control design §4, "A at the front
// door"). With hub_state "membersOnly" on, the database already gives a
// stranger nothing (the visible_* views, module/src/store.ts mayReadHub), but
// the web reads as the admin: the module's own pages (tree, blob, raw,
// commits, guide, builders) and the web service's routes would still show the
// hub. So every request asks here first:
//   - Caddy (docker/server.Caddyfile) sends every request but /healthz and
//     the database's two client endpoints to GET /-/auth/check
//     (forward_auth); a 2xx lets it through, anything else is the answer;
//   - the web service asks again for its own routes (web.ts), in case a
//     request reaches it some other way.
// Off (the default, and no row) lets everything through, exactly as before,
// after one cached flag read. On, only the routes in ROUTES marked "open" or
// "own-auth" let anyone in; everything else, including any route not listed,
// needs a member: a signed-in builder who is not suspended (viewer.ts).
// Pages send a stranger to sign in; anything else gets a 401.
import type http from 'node:http';
import { cookieValue, type Viewer } from './viewer.ts';

/**
 * Who may reach a route on a members-only hub:
 *   open:     anyone (signing in and up, and the files those pages load);
 *   own-auth: callers that prove themselves another way (a key, a machine
 *             credential, an operator's token) and get nothing without it;
 *   members:  a member only.
 */
export type Access = 'open' | 'own-auth' | 'members';

/** The routes anyone may reach with members-only on; first match wins, and anything else is "members". */
export const ROUTES: readonly { path: RegExp; access: Exclude<Access, 'members'>; why: string }[] = [
  { path: /^\/healthz$/, access: 'open', why: "the platform's health check" },
  { path: /^\/-\/auth\/check$/, access: 'open', why: 'this check itself' },
  { path: /^\/-\/login(?:\/(?:github|xo)(?:\/callback)?)?$/, access: 'open', why: 'sign in: the page, GitHub and xo, and their callbacks' },
  { path: /^\/-\/signup$/, access: 'open', why: 'sign up, with or without an invite (/-/signup?invite=)' },
  { path: /^\/-\/logout$/, access: 'open', why: 'sign out' },
  { path: /^\/-\/app\/[A-Za-z0-9][A-Za-z0-9._-]*$/, access: 'open', why: "the styles, scripts and icons the sign-in pages load (the app's build: no hub data)" },
  { path: /^\/-\/api\/auth\/github(?:\/device(?:\/poll)?)?$/, access: 'open', why: "the CLI's sign-in with GitHub" },
  { path: /^\/-\/api\/xo\/v1\//, access: 'own-auth', why: "xo.quirq.dev, with the hub's xo key (xo.ts)" },
  { path: /^\/-\/api\/instance-recovery(?:\/|$)/, access: 'own-auth', why: "hub operators and sub-hubs' machine credentials (instancerecovery.ts)" },
];

/** Who may reach `pathname` on a members-only hub. */
export function accessOf(pathname: string): Access {
  return ROUTES.find(r => r.path.test(pathname))?.access ?? 'members';
}

/** The path of a request URI, normalised as a browser and the routes would ("/a/../b" is "/b"). */
export function pathOf(uri: string): string {
  try {
    return new URL(uri, 'http://local').pathname;
  } catch {
    return '/';
  }
}

export interface FrontDoorDeps {
  /** hub_state "membersOnly" as the admin reads it; throws when it cannot be read. */
  membersOnly: () => Promise<boolean>;
  /** The verified viewer (viewer.ts viewerOf); null for anonymous, a rejected token or a suspended builder. */
  viewer: (req: http.IncomingMessage) => Promise<Viewer | null>;
  /** Called when the flag is seen to turn on (to end live pages opened before). */
  turnedOn?: () => void;
  /** How long a read of the flag, and a viewer's membership, is reused (default 5 s). */
  ttlMs?: number;
  now?: () => number;
}

/** Shown to a stranger's API call (and in the 401's body). */
export const MEMBERS_ONLY = 'This hub is for its members. Sign in to see it.';
/** Said to a suspended builder: on the sign-in page, and when it tries to sign in again. */
export const SUSPENDED = 'Your access to this hub was suspended by its owner.';

/** A suspended builder's refused sign-in, naming the builder so a person with two accounts knows which. */
export function suspendedMessage(name: string | null): string {
  return name ? `${SUSPENDED} You signed in as ${name}; ask the hub's owner to restore it.` : `${SUSPENDED} Ask the hub's owner to restore it.`;
}

/**
 * The note at the top of the sign-in page (GET /-/login): why the viewer was
 * sent there. `reason` is the page's ?reason= (the app and live pages add it
 * when the hub signs them out); `suspended` is whether the session cookie the
 * browser still holds belongs to a suspended builder, which says so whatever
 * the reason. Nothing for a viewer who is signed in, or with no reason.
 */
export function signInNotice(reason: string | null, signedIn: boolean, suspended: boolean): { text: string; error: boolean } | null {
  if (signedIn) return null;
  if (suspended || reason === 'suspended') return { text: `${SUSPENDED} Ask the hub's owner if you think this is a mistake.`, error: true };
  if (reason === 'signed-out') return { text: 'Sign in to continue.', error: false };
  return null;
}

/** Set on every answer the front door refuses, so tests and clients can tell it from a route's own. */
export const DENIED_HEADER = 'x-spacehub-members-only';
const MAX_REMEMBERED = 1000;
// When the flag cannot be read: closed, and asked again soon.
const RETRY_MS = 1000;

export class FrontDoor {
  private deps: FrontDoorDeps;
  private ttl: number;
  private now: () => number;
  private flag: { on: boolean; until: number } | null = null;
  private reading: Promise<boolean> | null = null;
  // Per session token: whether it is a member, and as which builder (to forget a suspended one).
  private members = new Map<string, { member: boolean; name: string | null; until: number }>();
  // Moves on every forgetBuilder, so a lookup that started before it is not remembered.
  private epoch = 0;

  constructor(deps: FrontDoorDeps) {
    this.deps = deps;
    this.ttl = deps.ttlMs ?? 5_000;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Whether the hub is members-only: at most one admin read per interval,
   * shared by every request that asks meanwhile. A failed read keeps the
   * last answer, or is closed (on) when there is none.
   */
  membersOnly(): Promise<boolean> {
    const now = this.now();
    if (this.flag && now < this.flag.until) return Promise.resolve(this.flag.on);
    this.reading ??= this.deps.membersOnly().then(
      on => this.remember(on, this.ttl),
      () => this.remember(this.flag?.on ?? true, RETRY_MS)
    ).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /** Read the flag afresh on the next request (the owner just changed it here). */
  forget() {
    if (this.flag) this.flag.until = 0;
  }

  private remember(on: boolean, ms: number): boolean {
    const was = this.flag?.on ?? false;
    this.flag = { on, until: this.now() + ms };
    if (on && !was) {
      this.members.clear();
      this.deps.turnedOn?.();
    }
    return on;
  }

  /** Whether this request's viewer is a member: a builder, not suspended. Reused per session token for the interval. */
  async isMember(req: http.IncomingMessage): Promise<boolean> {
    return (await this.builder(req)) !== null;
  }

  /**
   * The verified builder of this request (viewer.ts), or null: signed out, a
   * token with no builder, or a suspended one. Reused per session token for
   * the interval, like isMember (module pages ask on every request, modulepage.ts).
   */
  async builder(req: http.IncomingMessage): Promise<string | null> {
    const token = cookieValue(req, 'spacehub_session');
    if (!token) return null;
    const now = this.now();
    const known = this.members.get(token);
    if (known && now < known.until) return known.member ? known.name : null;
    const epoch = this.epoch;
    const viewer = await this.deps.viewer(req);
    const name = viewer?.name ?? null;
    if (epoch !== this.epoch) return name;
    if (this.members.size >= MAX_REMEMBERED) this.members.clear();
    this.members.set(token, { member: name !== null, name, until: now + this.ttl });
    return name;
  }

  /**
   * Forget every remembered membership of the builder `name` (the owner just
   * suspended it here), so its next request is checked afresh, on every
   * session it has open. Lookups already under way are not remembered either.
   */
  forgetBuilder(name: string) {
    this.epoch++;
    for (const [token, known] of this.members) if (known.name === name) this.members.delete(token);
  }

  /** Whether `req` may have `uri` (the path it asks for). */
  async allows(req: http.IncomingMessage, uri: string): Promise<boolean> {
    if (!(await this.membersOnly())) return true;
    if (accessOf(pathOf(uri)) !== 'members') return true;
    return this.isMember(req);
  }

  /**
   * GET /-/auth/check, Caddy's forward_auth: the original method and URI come
   * in X-Forwarded-Method and X-Forwarded-Uri, which Caddy sets itself. 204
   * lets the request through; a refusal is sent as the answer. False for any
   * other path.
   */
  async check(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/-/auth/check') return false;
    const header = (name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : '');
    const uri = header('x-forwarded-uri') || '/';
    const method = header('x-forwarded-method') || 'GET';
    if (await this.allows(req, uri)) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    } else refuse(req, res, method, uri);
    return true;
  }

  /** The web service's own check of its own request: true when it refused (and answered). */
  async guard(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const uri = req.url ?? '/';
    if (await this.allows(req, uri)) return false;
    refuse(req, res, req.method ?? 'GET', uri);
    return true;
  }
}

/** A page asks to sign in and come back; anything else (an API call, a script, a live page) gets a 401. */
export function refuse(req: http.IncomingMessage, res: http.ServerResponse, method: string, uri: string) {
  const page = (method === 'GET' || method === 'HEAD') && /\btext\/html\b/.test(String(req.headers.accept ?? ''));
  const next = uri.startsWith('/') && !uri.startsWith('//') ? uri : '/';
  if (page) {
    res.writeHead(303, { location: `/-/login?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store', [DENIED_HEADER]: 'sign-in' });
    res.end();
    return;
  }
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', [DENIED_HEADER]: 'sign-in' });
  res.end(JSON.stringify({ error: MEMBERS_ONLY, signIn: '/-/login' }));
}
