// Settings → Hub, for the hub's owner only (the app's pages/hub-settings.tsx):
//
//   GET  /-/api/hub           the owner, the hub's recovery operators and its builders (who is suspended)
//   POST /-/api/hub/suspend   {"name": "<builder>"}  suspend a builder (suspend_builder)
//   POST /-/api/hub/restore   {"name": "<builder>"}  let a suspended builder back in (restore_builder)
//
// The web service checks the session and that it is the owner's; the module
// checks again (the reducers run with the owner's own token) and decides.
// Everyone else gets 403, signed out 401. Who the owner is: hubowner.ts.
import type http from 'node:http';
import { json, readJson } from './admin.ts';
import type { HubPeople } from './hubowner.ts';

export const HUB_ROUTE = '/-/api/hub';
const SUSPEND_ROUTE = '/-/api/hub/suspend';
const RESTORE_ROUTE = '/-/api/hub/restore';

export interface HubSettingsDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
  /** The owner's builder name, or null when the hub has none. */
  ownerName: () => Promise<string | null>;
  /** SPACEHUB_RECOVERY_OPERATORS, as named. */
  operators: string[];
  /** Whether the hub's admin identity is a recovery operator too (no operators named). */
  adminFallback: boolean;
  people: () => Promise<HubPeople>;
  /** Suspend or restore `name` as the owner (the session's token); rejects with the module's reason. */
  suspend: (token: string, name: string) => Promise<void>;
  restore: (token: string, name: string) => Promise<void>;
}

/** The recovery operators: the owner always, then the ones named in SPACEHUB_RECOVERY_OPERATORS. */
export function operatorsOf(owner: string | null, named: string[]): string[] {
  return [...new Set([...(owner ? [owner] : []), ...named])];
}

/** Handle Settings → Hub's routes; false when the request is not one of them. */
export async function handleHubSettings(deps: HubSettingsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const action = route === SUSPEND_ROUTE ? deps.suspend : route === RESTORE_ROUTE ? deps.restore : null;
  if (route !== HUB_ROUTE && !action) return false;
  if (action ? req.method !== 'POST' : req.method !== 'GET') return json(res, 405, { error: action ? 'Send it with POST.' : 'Read it with GET.' }), true;
  const session = await deps.sessionOf(req);
  if (!session) return json(res, 401, { error: 'Sign in as the hub owner.' }), true;
  let owner: string | null;
  try {
    owner = await deps.ownerName();
  } catch {
    return json(res, 502, { error: 'The hub database did not answer.' }), true;
  }
  if (!owner || owner !== session.username) return json(res, 403, { error: "Only the hub's owner manages the hub." }), true;

  if (!action) {
    try {
      const { builders } = await deps.people();
      json(res, 200, { owner, operators: operatorsOf(owner, deps.operators), adminFallback: deps.adminFallback, builders });
    } catch {
      json(res, 502, { error: 'The hub database did not answer.' });
    }
    return true;
  }

  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
  let name: unknown;
  try {
    name = (await readJson(req)).name;
  } catch {
    name = null;
  }
  if (typeof name !== 'string' || !name) return json(res, 400, { error: 'Send the builder\'s name.' }), true;
  try {
    await action(session.token, name);
    return json(res, 200, { ok: true }), true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
    return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
  }
}
