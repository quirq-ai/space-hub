// Where a visitor who is not signed in lands from the hub's own address (/):
// the space or project SPACEHUB_VISITOR_HOME names, by default quirq/quirq,
// once it is on this hub; "off" keeps the hub's home page for everyone.
// Signed in, / is the hub's home page as before.
import type http from 'node:http';

export function visitorHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const place = (env.SPACEHUB_VISITOR_HOME ?? 'quirq/quirq').trim();
  if (place === 'off' || /\/\.{1,2}$/.test(place)) return null;
  return /^[a-z0-9][a-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]{1,100})?$/.test(place) ? place : null;
}

// Whether the place is on this hub, asked of the module at most once a
// minute: a hub without it shows its home page as before.
let known: { place: string; until: number; there: boolean } | null = null;

async function there(deps: { internalHttp: string; db: string }, place: string, now: number): Promise<boolean> {
  if (known?.place === place && known.until > now) return known.there;
  const [space, project = ''] = place.split('/');
  let found = false;
  try {
    const query = new URLSearchParams({ space, project });
    found = (await fetch(`${deps.internalHttp}/v1/database/${encodeURIComponent(deps.db)}/route/api?${query}`, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    found = false;
  }
  known = { place, until: now + 60_000, there: found };
  return found;
}

export function forgetVisitorLanding() {
  known = null;
}

/** Where to send this request for / instead of the home page, or null. */
export async function visitorLanding(deps: { internalHttp: string; db: string }, req: http.IncomingMessage, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string | null> {
  if (/(?:^|;\s*)spacehub_session=[^;\s]/.test(req.headers.cookie ?? '')) return null;
  const place = visitorHome(env);
  return place && (await there(deps, place, now)) ? `/${place}` : null;
}
