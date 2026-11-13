/**
 * "Connect Agents Hub" in Settings (pages/runners.tsx): which dialog to show after the button, and how the dialog
 * watches for a new hub. Pure, so the rules that keep it from running on are tested (test/agentshub.test.ts).
 *
 * With no hub yet, the server holds the pass from the one XO sign-in for HOLD_MS. Meanwhile the dialog asks
 * POST CHECK every POLL_MS (and at once when the person comes back to the tab): a background request, never a page
 * load or a new sign-in. It stops for good on the first answer that is not "waiting" (found, failed, stopped,
 * expired), when HOLD_MS has passed (plus a little slack), or when the dialog closes. Only "found" moves the browser,
 * once.
 */

export const START = "/-/runners/agents-hub/start";
export const CHECK = "/-/runners/agents-hub/check";
export const CANCEL = "/-/runners/agents-hub/cancel";
export const POLL_MS = 10_000;
export const HOLD_MS = 10 * 60_000; // as the server's (cli/src/agentshub.ts)
export const STOP_AFTER_MS = HOLD_MS + 30_000;

/** What the server's ?runner= says about the hub (cli/src/agentshub.ts). */
export type HubOutcome = "nohub" | "hubfailed" | "hubstopped" | "hubslow";
export const isHubOutcome = (code: string | null): code is HubOutcome =>
  code === "nohub" || code === "hubfailed" || code === "hubstopped" || code === "hubslow";

/** The dialog to show. "waiting": no hub yet, watching for one; "timed-out": stopped watching. */
export type HubDialog = "waiting" | "timed-out" | "failed" | "stopped" | "slow";

export function dialogFor(outcome: HubOutcome): HubDialog {
  if (outcome === "hubfailed") return "failed";
  if (outcome === "hubstopped") return "stopped";
  if (outcome === "hubslow") return "slow";
  return "waiting";
}

/** Whether the dialog watches for the hub. */
export const watches = (d: HubDialog) => d === "waiting";

/** Whether watching may go on, `startedAt` being when the dialog started it. */
export const stillWatching = (startedAt: number, now: number) => now - startedAt < STOP_AFTER_MS;

/** After one check: move the browser (found), show another dialog (and stop), or ask again later. */
export type CheckStep = { go: string } | { dialog: HubDialog } | { again: true };

// Only a page on this site, or a hub's own page (https; http only to this machine, in development).
function placeToGo(go: unknown): string | null {
  if (typeof go !== "string" || go.length > 2000) return null;
  if (go.startsWith("/") && !go.startsWith("//")) return go;
  try {
    const u = new URL(go);
    const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    return u.protocol === "https:" || local ? u.href : null;
  } catch {
    return null;
  }
}

export function afterCheck(body: unknown): CheckStep {
  const b = (body && typeof body === "object" ? body : {}) as { state?: unknown; go?: unknown };
  if (b.state === "found") {
    const go = placeToGo(b.go);
    return go ? { go } : { dialog: "timed-out" };
  }
  if (b.state === "failed") return { dialog: "failed" };
  if (b.state === "stopped") return { dialog: "stopped" };
  if (b.state === "expired") return { dialog: "timed-out" };
  return { again: true }; // "waiting", or a hiccup: ask again, within the time limit
}

/** Launchpad's apps list, from its create page's site (for a hub that failed, stopped or is slow). */
export function launchpadHome(createPage: string | null): string | null {
  if (!createPage) return null;
  try { return `${new URL(createPage).origin}/launchpad`; } catch { return null; }
}
