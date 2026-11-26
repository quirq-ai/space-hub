// Who is asking: the one place the web service turns a request into a
// verified viewer. Every route that needs to know who is signed in asks
// viewerOf (web.ts wraps it as sessionOf for the routes that only want a
// builder), so later checks (hub owner, who may join, members-only) have one
// answer to build on.
//
// A request proves who it is with an identity token:
//   - the HttpOnly spacehub_session cookie, set at sign-in (web.ts sessionCookies);
//   - or, only where a route opts in, an "Authorization: Bearer <token>" header
//     (the CLI's recovery calls). A bearer header wins over the cookie.
// The token is checked by connecting with it and finding its builder. The
// spacehub_user cookie is the name to show and is never read here: anyone can
// set it.
import type http from 'node:http';
import type { Identity } from 'spacetimedb';

/** A request whose token the database accepted. */
export interface Viewer {
  /** The verified token, to act as this viewer (withConn). */
  token: string;
  identity: Identity;
  /** The builder's name; null when the token is valid but has no builder (e.g. the hub's own admin identity). */
  name: string | null;
}

/**
 * Check a token against the database: its identity and builder name, and
 * whether the hub's owner suspended that builder; or a throw when the token is
 * not accepted (or the database cannot be reached).
 */
export type CheckToken = (token: string) => Promise<{ identity: Identity; name: string | null; suspended?: boolean }>;

/** A cookie's value, decoded; null when absent or not decodable. */
export function cookieValue(req: http.IncomingMessage, name: string): string | null {
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

/** The token in an "Authorization: Bearer <token>" header, if any. */
export function bearerToken(req: http.IncomingMessage): string | null {
  return /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

/**
 * The verified viewer of this request, or null for an anonymous one: no
 * token, a token the database does not accept, or a suspended builder's
 * (signed out until the owner restores it). Never throws.
 */
export async function viewerOf(req: http.IncomingMessage, check: CheckToken, opts: { bearer?: boolean } = {}): Promise<Viewer | null> {
  const token = (opts.bearer ? bearerToken(req) : null) ?? cookieValue(req, 'spacehub_session');
  if (!token) return null;
  try {
    const { identity, name, suspended } = await check(token);
    if (suspended) return null;
    return { token, identity, name };
  } catch {
    return null;
  }
}
