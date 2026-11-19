// The private hub's gate: every request reaches the hub only with a token of
// someone signed in with XO (Clerk, through the xo server's sign-in).
//
// The server image's proxy (docker/server.Caddyfile) asks this service before
// it forwards anything, with Caddy's forward_auth:
//
//   GET /-/gate   with the original request's headers, plus X-Forwarded-Method
//                 and X-Forwarded-Uri
//     204         let it through (X-Spacehub-Builder names who)
//     303         a browser page without a session: off to /-/login?next=...
//     401         anything else without one (API, git, websockets)
//     503         the gate cannot tell yet (no admin token, database down)
//
// The token is the hub's own SpacetimeDB token, wherever the request carries
// it: Authorization: Bearer (the CLI and git, SpacetimeDB's websocket-token
// endpoint), the spacehub_session cookie (the website) or ?token= (the
// websocket itself, SpacetimeDB's short-lived token). It must be signed by
// this hub's SpacetimeDB key (ES256; tokens other issuers sign are refused even
// though SpacetimeDB itself would take them), unexpired, and name an identity
// on the allowlist:
//
//   - a builder who signed in with XO: xo_link names their builder, and
//     xo_agent the builders xo made before GitHub was needed;
//   - an agent one of those builders made;
//   - the hub admin.
//
// SPACEHUB_PRIVATE_BUILDERS (comma-separated builder names) narrows the
// builders further: then only they, and their agents, get in. Unset, any XO
// account with a GitHub account connected gets in.
//
// Builders who signed up any other way (GitHub, open sign-up) are refused,
// as are anonymous identities. The allowlist is read with the admin's token
// every REFRESH_MS, and at once (at most every MISS_REFRESH_MS) when an
// unknown identity knocks, so a fresh XO sign-in gets in straight away.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type http from 'node:http';
import { type AdminHttp, select } from './admin.ts';

export const GATE_ROUTE = '/-/gate';
export const LOGIN_ROUTE = '/-/login';
export const REFRESH_MS = 30_000;
export const MISS_REFRESH_MS = 2_000;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const HEX = /^[0-9a-f]{64}$/;

export interface GateConfig {
  admin: AdminHttp | null; // null: no admin token, so the gate answers 503
  builders: Set<string> | null; // SPACEHUB_PRIVATE_BUILDERS, or null for every XO builder
  publicKey?: () => Promise<string>; // SpacetimeDB's token key, PEM (tests pass one in)
}

// SPACEHUB_PRIVATE_BUILDERS: builder names, comma-separated; anything else stops the hub.
export function privateBuilders(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = (env.SPACEHUB_PRIVATE_BUILDERS ?? '').trim();
  if (!raw) return null;
  const names = raw.split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter(n => !NAME.test(n));
  if (bad.length) throw new Error(`SPACEHUB_PRIVATE_BUILDERS has names that are not builder names: ${bad.join(', ')}`);
  return new Set(names);
}

// ---------------------------------------------------------------- tokens

export interface Claims {
  identity: string; // 64 lowercase hex digits, no 0x
  exp: number | null;
}

// A token this hub's SpacetimeDB signed, still valid: its identity. Anything
// else, null.
export function verifyToken(token: string, key: KeyObject, now = Date.now()): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8192) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'ES256') return null;
    const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { hex_identity?: unknown; exp?: unknown };
    const identity = typeof body.hex_identity === 'string' ? body.hex_identity.toLowerCase() : '';
    if (!HEX.test(identity)) return null;
    const exp = typeof body.exp === 'number' ? body.exp : null;
    if (exp !== null && exp * 1000 <= now) return null;
    return { identity, exp };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the allowlist

// identity (hex, no 0x) -> the builder or agent it is
export type Allowlist = Map<string, string>;

// SQL hands identities back as ["0x..."] (or a bare string): lowercase hex, no 0x.
export function hexOf(v: unknown): string {
  const raw = Array.isArray(v) ? v[0] : v;
  const hex = typeof raw === 'string' ? raw.replace(/^0x/i, '').toLowerCase() : '';
  return HEX.test(hex) ? hex : '';
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function readAllowlist(admin: AdminHttp, builders: Set<string> | null): Promise<Allowlist> {
  const [users, links, xoAgents, agents, state] = await Promise.all([
    select(admin, 'SELECT identity, username FROM user'),
    select(admin, 'SELECT username FROM xo_link'),
    select(admin, 'SELECT identity, username FROM xo_agent'),
    select(admin, 'SELECT identity, name, created_by FROM agent'),
    select(admin, "SELECT value FROM hub_state WHERE key = 'admin'"),
  ]);
  const linked = new Set(links.map(r => str(r.username)));
  const legacy = new Set(xoAgents.map(r => hexOf(r.identity)).filter(Boolean));
  const out: Allowlist = new Map();
  const names = new Set<string>();
  for (const u of users) {
    const id = hexOf(u.identity);
    const name = str(u.username);
    if (!id || !name) continue;
    if (!linked.has(name) && !legacy.has(id)) continue;
    if (builders && !builders.has(name)) continue;
    out.set(id, name);
    names.add(name);
  }
  for (const a of agents) {
    const id = hexOf(a.identity);
    if (id && names.has(str(a.created_by))) out.set(id, str(a.name));
  }
  const adminId = hexOf(state[0]?.value);
  if (adminId) out.set(adminId, '(hub admin)');
  return out;
}

// ---------------------------------------------------------------- the gate

export class Gate {
  private list: Allowlist | null = null;
  private readAt = 0;
  private reading: Promise<void> | null = null;
  private key: KeyObject | null = null;
  private cfg: GateConfig;
  private internalHttp: string;

  constructor(cfg: GateConfig, internalHttp = '') {
    this.cfg = cfg;
    this.internalHttp = internalHttp;
  }

  private async publicKey(): Promise<KeyObject> {
    if (this.key) return this.key;
    const pem = this.cfg.publicKey
      ? await this.cfg.publicKey()
      : await fetch(`${this.internalHttp}/v1/identity/public-key`, { signal: AbortSignal.timeout(5_000) }).then(r => {
          if (!r.ok) throw new Error(`public key: ${r.status}`);
          return r.text();
        });
    this.key = createPublicKey(pem);
    return this.key;
  }

  private refresh(now: number): Promise<void> {
    const admin = this.cfg.admin;
    if (!admin) return Promise.reject(new Error('no admin token'));
    this.reading ??= readAllowlist(admin, this.cfg.builders)
      .then(list => {
        this.list = list;
        this.readAt = now;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  // Who this token is, if they may in; null if not. Throws when it cannot tell.
  async check(token: string, now = Date.now()): Promise<string | null> {
    const claims = verifyToken(token, await this.publicKey(), now);
    if (!claims) return null;
    if (!this.list || now - this.readAt >= REFRESH_MS) await this.refresh(now);
    let who = this.list!.get(claims.identity);
    if (who === undefined && now - this.readAt >= MISS_REFRESH_MS) {
      await this.refresh(now);
      who = this.list!.get(claims.identity);
    }
    return who ?? null;
  }
}

function cookieOf(req: http.IncomingMessage, name: string): string | null {
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

// The token a request carries, and where.
export function tokenOf(req: http.IncomingMessage, uri: URL): { token: string; from: 'bearer' | 'cookie' | 'query' } | null {
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) return { token: bearer, from: 'bearer' };
  const cookie = cookieOf(req, 'spacehub_session');
  if (cookie) return { token: cookie, from: 'cookie' };
  const query = uri.searchParams.get('token');
  if (query) return { token: query, from: 'query' };
  return null;
}

// A person's browser asking for a page, as opposed to the CLI, git, an API call or a websocket.
function wantsPage(req: http.IncomingMessage, method: string, uri: URL) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (uri.pathname.startsWith('/v1/') || uri.pathname.startsWith('/-/api/')) return false;
  if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') return false;
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html') || (req.headers['sec-fetch-mode'] ?? '') === 'navigate';
}

export function loginTarget(uri: URL, denied = false) {
  const next = `${uri.pathname}${uri.search}`;
  const query = new URLSearchParams();
  if (next !== '/') query.set('next', next);
  if (denied) query.set('denied', '1');
  const q = query.toString();
  return `${LOGIN_ROUTE}${q ? `?${q}` : ''}`;
}

// GET /-/gate (forward_auth). True when it answered.
export async function handleGate(gate: Gate, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (new URL(req.url ?? '/', 'http://local').pathname !== GATE_ROUTE) return false;
  const method = String(req.headers['x-forwarded-method'] ?? 'GET').toUpperCase();
  let uri: URL;
  try {
    uri = new URL(String(req.headers['x-forwarded-uri'] ?? '/'), 'http://local');
  } catch {
    uri = new URL('/', 'http://local');
  }
  const found = tokenOf(req, uri);
  let who: string | null = null;
  try {
    who = found ? await gate.check(found.token) : null;
  } catch (err) {
    process.stderr.write(`spacehub-web: gate: ${err instanceof Error ? err.message : String(err)}\n`);
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
    res.end(JSON.stringify({ error: 'This private hub cannot check sign-ins right now. Try again shortly.' }));
    return true;
  }
  if (who) {
    res.writeHead(204, { 'x-spacehub-builder': who, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (wantsPage(req, method, uri)) {
    // A session cookie that does not get in (signed up some other way, or no longer on the list) is cleared.
    const headers: Record<string, string | string[]> = { location: loginTarget(uri, found?.from === 'cookie'), 'cache-control': 'no-store' };
    if (found?.from === 'cookie') {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      headers['set-cookie'] = [`spacehub_session=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly${secure}`, `spacehub_user=; Path=/; SameSite=Lax; Max-Age=0${secure}`];
    }
    res.writeHead(303, headers);
    res.end();
    return true;
  }
  res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': 'Bearer realm="spacehub"' });
  res.end(JSON.stringify({ error: 'This hub is private: sign in with XO (xo login, or Sign in with XO on the website).' }));
  return true;
}
