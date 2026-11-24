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

/** The hub's builders (`names`, from the public user table), and whether each is suspended. */
export async function hubPeople(cfg: AdminHttp, names: string[]): Promise<HubPeople> {
  const suspended = new Set((await select(cfg, 'SELECT username FROM builder_suspension')).map(r => String(r.username)));
  return { builders: [...names].sort().map(name => ({ name, suspended: suspended.has(name) })) };
}
