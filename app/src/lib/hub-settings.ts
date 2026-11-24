/**
 * Settings → Hub (pages/hub-settings.tsx), for the hub's owner only: what the web service's GET /-/api/hub says
 * (cli/src/hubsettings.ts), read defensively, and the lines the page shows. Pure, so it is tested
 * (test/hub-settings.test.ts).
 */

export const HUB_API = "/-/api/hub";

export interface HubBuilder { name: string; suspended: boolean }
export type JoinPolicy = "anyone" | "allowlist" | "invite";
export interface HubInvite { id: string; createdBy: string; createdAt: number; expiresAt: number; usedBy: string }
export interface JoinSettings { policy: JoinPolicy; allowlist: string[]; invites: HubInvite[] }
export interface HubSettings { owner: string; operators: string[]; adminFallback: boolean; membersOnly: boolean; builders: HubBuilder[]; join: JoinSettings }

export const JOIN_POLICIES: { value: JoinPolicy; label: string; help: string }[] = [
  { value: "anyone", label: "Anyone", help: "Anyone who can sign up on this hub joins." },
  { value: "allowlist", label: "Allowlist", help: "Only the GitHub accounts listed below join, or someone with an invite code." },
  { value: "invite", label: "Invite only", help: "Only people with an invite code join, or a GitHub account listed below." },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

function parseJoin(v: unknown): JoinSettings {
  const o = isObj(v) ? v : {};
  const policy = o.policy === "allowlist" || o.policy === "invite" ? o.policy : "anyone";
  const invites = Array.isArray(o.invites)
    ? o.invites.filter(isObj).filter(i => typeof i.id === "string").map(i => ({
      id: i.id as string,
      createdBy: typeof i.createdBy === "string" ? i.createdBy : "",
      createdAt: Number(i.createdAt) || 0,
      expiresAt: Number(i.expiresAt) || 0,
      usedBy: typeof i.usedBy === "string" ? i.usedBy : "",
    }))
    : [];
  return { policy, allowlist: strings(o.allowlist), invites };
}

/** The answer of GET /-/api/hub, or null when it is not one. */
export function parseHubSettings(body: unknown): HubSettings | null {
  if (!isObj(body) || typeof body.owner !== "string") return null;
  const builders = Array.isArray(body.builders)
    ? body.builders.filter(isObj).filter(b => typeof b.name === "string").map(b => ({ name: b.name as string, suspended: b.suspended === true }))
    : [];
  return { owner: body.owner, operators: strings(body.operators), adminFallback: body.adminFallback === true, membersOnly: body.membersOnly === true, builders, join: parseJoin(body.join) };
}

/** Where an invite stands: used (by whom), expired, or open until when. */
export function inviteState(invite: HubInvite, now: number): { kind: "used" | "expired" | "open"; text: string } {
  if (invite.usedBy) return { kind: "used", text: `Used by ${invite.usedBy}` };
  if (invite.expiresAt <= now) return { kind: "expired", text: "Expired" };
  const hours = Math.ceil((invite.expiresAt - now) / 3_600_000);
  return { kind: "open", text: hours > 48 ? `Open, ${Math.ceil(hours / 24)} more days` : `Open, ${hours} more hour${hours === 1 ? "" : "s"}` };
}

/** A GitHub login as the owner typed it ("@octo", a profile URL), or null when it is none. */
export function loginOf(input: string): string | null {
  const s = input.trim().replace(/^@/, "").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s) ? s : null;
}

/** Who holds full backups and recovery, in a sentence: the owner always, then the named operators. */
export function operatorsLine(s: HubSettings): string {
  const others = s.operators.filter(name => name !== s.owner);
  const names = [`${s.owner} (owner)`, ...others];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list}${s.adminFallback ? ", and the hub's server admin" : ""}.`;
}

/** What one builder row offers: the owner none, a suspended builder Restore, anyone else Suspend. */
export function builderAction(s: HubSettings, b: HubBuilder): "suspend" | "restore" | null {
  if (b.name === s.owner) return null;
  return b.suspended ? "restore" : "suspend";
}

/** Who can read the hub, in a sentence, for the members-only switch. */
export function readersLine(s: HubSettings): string {
  return s.membersOnly
    ? "Members only: just this hub's builders and their agents can see its spaces and projects, even with a raw database client."
    : "Anyone who reaches this hub can see its spaces and projects.";
}
