// The hub's owner and suspended builders, as the web service reads them (as
// the admin, over SQL: both live in private rows). The module decides who is
// the owner (hub_state "owner", a GitHub account id; module/src/index.ts) and
// refuses a suspended builder's writes; the web service uses this to sign
// suspended builders out and to show the owner Settings → Hub.
import { select, type AdminHttp } from './admin.ts';

// Builder names are lowercased GitHub logins, so they go into SQL as they are
// once checked.
const NAME = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** The owner's builder name, or null when the hub has no owner (yet). */
export async function hubOwnerName(cfg: AdminHttp): Promise<string | null> {
  const [row] = await select(cfg, "SELECT value FROM hub_state WHERE key = 'owner'");
  const id = row ? String(row.value) : '';
  if (!/^[1-9][0-9]{0,19}$/.test(id)) return null;
  const [account] = await select(cfg, `SELECT username FROM github_account WHERE github_id = ${id}`);
  return account ? String(account.username) : null;
}

/** The GitHub login the hub was started with (SPACEHUB_OWNER), or null. */
export async function hubOwnerLogin(cfg: AdminHttp): Promise<string | null> {
  const [row] = await select(cfg, "SELECT value FROM hub_state WHERE key = 'owner_login'");
  return row ? String(row.value) : null;
}

/** Whether the builder `name` is suspended on this hub. */
export async function isSuspended(cfg: AdminHttp, name: string): Promise<boolean> {
  if (!NAME.test(name)) return false;
  return (await select(cfg, `SELECT username FROM builder_suspension WHERE username = '${name}'`)).length > 0;
}

export interface HubPeople {
  builders: { name: string; suspended: boolean }[];
}

// Who may join (the module's join gate, module/src/index.ts mayJoin):
// hub_state "join", no row being "anyone".
export type JoinPolicy = 'anyone' | 'allowlist' | 'invite';

/** The hub's join policy: "anyone" when unset (today's behaviour). */
export async function joinPolicy(cfg: AdminHttp): Promise<JoinPolicy> {
  const [row] = await select(cfg, "SELECT value FROM hub_state WHERE key = 'join'");
  const value = row ? String(row.value) : '';
  return value === 'allowlist' || value === 'invite' ? value : 'anyone';
}

export interface HubInvite {
  id: string; // a u64, as text
  createdBy: string;
  createdAt: number; // ms since the epoch
  expiresAt: number;
  usedBy: string; // "" while unused
}

export interface JoinSettings {
  policy: JoinPolicy;
  allowlist: string[];
  invites: HubInvite[];
}

// SpacetimeDB's SQL answers a timestamp as {__timestamp_micros_since_unix_epoch__: n} (or [n]).
function millis(value: unknown): number {
  const micros = Array.isArray(value) ? value[0] : value && typeof value === 'object' ? Object.values(value)[0] : value;
  const n = Number(micros);
  return Number.isFinite(n) ? Math.floor(n / 1000) : 0;
}

/** The join policy, the allowed GitHub logins and the invites (never their codes: only hashes are kept). */
export async function joinSettings(cfg: AdminHttp): Promise<JoinSettings> {
  const [policy, rules, invites] = await Promise.all([
    joinPolicy(cfg),
    select(cfg, 'SELECT login FROM join_rule'),
    select(cfg, 'SELECT id, created_by, created_at, expires_at, used_by FROM join_invite'),
  ]);
  return {
    policy,
    allowlist: rules.map(r => String(r.login)).sort(),
    invites: invites
      .map(r => ({ id: String(r.id), createdBy: String(r.created_by), createdAt: millis(r.created_at), expiresAt: millis(r.expires_at), usedBy: String(r.used_by ?? '') }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** The hub's builders (`names`, from the public user table), and whether each is suspended. */
export async function hubPeople(cfg: AdminHttp, names: string[]): Promise<HubPeople> {
  const suspended = new Set((await select(cfg, 'SELECT username FROM builder_suspension')).map(r => String(r.username)));
  return { builders: [...names].sort().map(name => ({ name, suspended: suspended.has(name) })) };
}
