/**
 * Settings → Hub (pages/hub-settings.tsx), for the hub's owner only: what the web service's GET /-/api/hub says
 * (cli/src/hubsettings.ts), read defensively, and the lines the page shows. Pure, so it is tested
 * (test/hub-settings.test.ts).
 */

export const HUB_API = "/-/api/hub";

export interface HubBuilder { name: string; suspended: boolean }
export interface HubSettings { owner: string; operators: string[]; adminFallback: boolean; builders: HubBuilder[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** The answer of GET /-/api/hub, or null when it is not one. */
export function parseHubSettings(body: unknown): HubSettings | null {
  if (!isObj(body) || typeof body.owner !== "string") return null;
  const builders = Array.isArray(body.builders)
    ? body.builders.filter(isObj).filter(b => typeof b.name === "string").map(b => ({ name: b.name as string, suspended: b.suspended === true }))
    : [];
  return { owner: body.owner, operators: strings(body.operators), adminFallback: body.adminFallback === true, builders };
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
