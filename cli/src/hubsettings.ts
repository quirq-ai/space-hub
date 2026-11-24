// Settings → Hub, for the hub's owner only (the app's pages/hub-settings.tsx):
//
//   GET  /-/api/hub             the owner, the hub's recovery operators, its builders (who is suspended)
//                               and who may join: {join: {policy, allowlist, invites}}
//   POST /-/api/hub/suspend     {"name": "<builder>"}  suspend a builder (suspend_builder)
//   POST /-/api/hub/restore     {"name": "<builder>"}  let a suspended builder back in (restore_builder)
//   POST /-/api/hub/join        {"policy": "anyone" | "allowlist" | "invite"}  (set_join_policy)
//   POST /-/api/hub/allow       {"login": "<GitHub login>"}  let a GitHub login join (allow_join)
//   POST /-/api/hub/disallow    {"login": "<GitHub login>"}  take it off the list (disallow_join)
//   POST /-/api/hub/invite      {"hours": n}  a one-time invite code: {code, link}, shown this once (create_invite)
//   POST /-/api/hub/revoke      {"id": "<invite id>"}  revoke an unused invite (revoke_invite)
//   POST /-/api/hub/members-only {"on": true|false}  only members read the hub, or anyone again (set_members_only)
//   POST /-/api/hub/default-visibility {"visibility": "public" | "private"}  what new projects start as
//                               when their creator does not choose (set_default_visibility)
//
// The web service checks the session and that it is the owner's; the module
// checks again (the reducers run with the owner's own token) and decides.
// Everyone else gets 403, signed out 401. Who the owner is: hubowner.ts.
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { json, readJson } from './admin.ts';
import type { HubPeople, JoinSettings } from './hubowner.ts';

export const HUB_ROUTE = '/-/api/hub';
export const INVITE_HOURS = 7 * 24;

export interface HubSettingsDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
  /** The owner's builder name, or null when the hub has none. */
  ownerName: () => Promise<string | null>;
  /** SPACEHUB_RECOVERY_OPERATORS, as named. */
  operators: string[];
  /** Whether the hub's admin identity is a recovery operator too (no operators named). */
  adminFallback: boolean;
  people: () => Promise<HubPeople>;
  join: () => Promise<JoinSettings>;
  /** Suspend or restore `name` as the owner (the session's token); rejects with the module's reason. */
  suspend: (token: string, name: string) => Promise<void>;
  restore: (token: string, name: string) => Promise<void>;
  /**
   * Called once `name` is suspended, so it takes effect at once: the web
   * service forgets its cached memberships and ends its live pages.
   */
  suspended?: (name: string) => void;
  /** The join gate's reducers, as the owner; each rejects with the module's reason. */
  setJoinPolicy: (token: string, policy: string) => Promise<void>;
  allow: (token: string, login: string) => Promise<void>;
  disallow: (token: string, login: string) => Promise<void>;
  createInvite: (token: string, code: string, hours: number) => Promise<void>;
  revokeInvite: (token: string, id: bigint) => Promise<void>;
  /** Where an invite code is used: this hub's sign-up page, as the browser reached it. */
  signupUrl: (req: http.IncomingMessage) => string;
  /** Whether the hub is members-only (hub_state "membersOnly"). */
  membersOnly: () => Promise<boolean>;
  /** Switch members-only on or off as the owner (the session's token); rejects with the module's reason. */
  setMembersOnly: (token: string, on: boolean) => Promise<void>;
  /** What new projects start as when their creator does not choose (hub_state "defaultVisibility"). */
  defaultVisibility: () => Promise<'public' | 'private'>;
  /** Set it as the owner (the session's token); rejects with the module's reason. */
  setDefaultVisibility: (token: string, visibility: 'public' | 'private') => Promise<void>;
}

/** The recovery operators: the owner always, then the ones named in SPACEHUB_RECOVERY_OPERATORS. */
export function operatorsOf(owner: string | null, named: string[]): string[] {
  return [...new Set([...(owner ? [owner] : []), ...named])];
}

/** A new invite code: 128 random bits, in the letters the module takes. */
export function newInviteCode() {
  return randomBytes(16).toString('base64url');
}

/** The sign-up link that carries an invite code. */
export function inviteLink(signup: string, code: string) {
  return `${signup}?invite=${encodeURIComponent(code)}`;
}

type Body = Record<string, unknown>;
type Session = { token: string; username: string };
// What each POST route does with the owner's session and the JSON it sent; the answer on success.
type Action = (deps: HubSettingsDeps, session: Session, body: Body, req: http.IncomingMessage) => Promise<Record<string, unknown>>;

class BadRequest extends Error {}

const text = (body: Body, key: string, what: string) => {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest(`Send the ${what}.`);
  return value.trim();
};

const ACTIONS: Record<string, Action> = {
  suspend: async (d, s, b) => {
    const name = text(b, 'name', "builder's name");
    await d.suspend(s.token, name);
    d.suspended?.(name);
    return { ok: true };
  },
  restore: async (d, s, b) => (await d.restore(s.token, text(b, 'name', "builder's name")), { ok: true }),
  join: async (d, s, b) => (await d.setJoinPolicy(s.token, text(b, 'policy', 'join policy')), { ok: true }),
  allow: async (d, s, b) => (await d.allow(s.token, text(b, 'login', 'GitHub login')), { ok: true }),
  disallow: async (d, s, b) => (await d.disallow(s.token, text(b, 'login', 'GitHub login')), { ok: true }),
  invite: async (d, s, b, req) => {
    const hours = b.hours === undefined ? INVITE_HOURS : Number(b.hours);
    if (!Number.isInteger(hours) || hours < 1) throw new BadRequest('Send how many hours the invite lasts.');
    const code = newInviteCode();
    await d.createInvite(s.token, code, hours);
    return { code, link: inviteLink(d.signupUrl(req), code) };
  },
  revoke: async (d, s, b) => {
    const id = typeof b.id === 'number' ? String(b.id) : text(b, 'id', "invite's id");
    if (!/^[0-9]{1,20}$/.test(id)) throw new BadRequest("Send the invite's id.");
    await d.revokeInvite(s.token, BigInt(id));
    return { ok: true };
  },
  'members-only': async (d, s, b) => {
    if (typeof b.on !== 'boolean') throw new BadRequest('Send "on": true or false.');
    await d.setMembersOnly(s.token, b.on);
    return { ok: true };
  },
  'default-visibility': async (d, s, b) => {
    if (b.visibility !== 'public' && b.visibility !== 'private') throw new BadRequest('Send "visibility": "public" or "private".');
    await d.setDefaultVisibility(s.token, b.visibility);
    return { ok: true };
  },
};

/** Handle Settings → Hub's routes; false when the request is not one of them. */
export async function handleHubSettings(deps: HubSettingsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const name = route.startsWith(`${HUB_ROUTE}/`) ? route.slice(HUB_ROUTE.length + 1) : null;
  const action = name !== null && Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
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
      const [{ builders }, join, membersOnly, defaultVisibility] = await Promise.all([deps.people(), deps.join(), deps.membersOnly(), deps.defaultVisibility()]);
      json(res, 200, { owner, operators: operatorsOf(owner, deps.operators), adminFallback: deps.adminFallback, membersOnly, defaultVisibility, builders, join });
    } catch {
      json(res, 502, { error: 'The hub database did not answer.' });
    }
    return true;
  }

  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
  let body: Body;
  try {
    body = await readJson(req);
  } catch {
    body = {};
  }
  try {
    return json(res, 200, await action(deps, session, body, req)), true;
  } catch (error) {
    if (error instanceof BadRequest) return json(res, 400, { error: error.message }), true;
    const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
    return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
  }
}
