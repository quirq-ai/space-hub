export const SUBHUB_API = "/-/api/subhubs";
export const MAX_DRIVE_FILE_BYTES = 16 * 1024 * 1024;
export type SubhubMode = "backup" | "drive";
export type DriveStats = { files: number; bytes: number; updatedAt: number | null };
export type DriveFile = { path: string; sha256: string; size: number; updatedAt: number };
export type SubhubNode = {
  id: string; space: string; owner: string; url?: string; label: string; mode: SubhubMode; enabled: boolean;
  capacityBytes: number; freeBytes: number; createdAt: number; seenAt: number | null; healthy: boolean;
  status: "ready" | "degraded"; errors: string[];
  backups: { project: string; oid: string; snapshot: string; bytes: number }[]; drive: DriveStats;
};
export type SubhubActivity = { id: string; at: number; space: string; nodeId: string | null; kind: string; subject: string; text: string; actor?: string };
export type SubhubWork = {
  id: string; space: string; project: string; title: string; text: string; actor: string; createdAt: number; updatedAt: number;
  status: "queued" | "claimed" | "completed"; assignedNode: string | null; receivedAt: number | null;
  worker: string | null; fence: number; leaseUntil: number | null; result: string | null;
};

export function subhubUrl(path: string, values: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, value);
  return SUBHUB_API + path + (params.size ? `?${params}` : "");
}

export class SubhubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = "SubhubError"; }
}
export function subhubErrorMessage(status: number, detail?: string) {
  if (status === 401) return "Sign in to use this space’s nodes.";
  if (status === 403) return "You do not have permission to use these nodes.";
  if (status === 404) return "Nodes are unavailable on this hub, or this item is no longer available.";
  if (status === 412) return "This file changed. Review the refreshed file list before replacing it.";
  if (status === 413) return "This file is too large. Drive files can be up to 16 MiB.";
  if (status === 409) return detail || "This item changed. Refresh and try again.";
  if (status === 502 || status === 503 || status === 504) return "The node is offline or unavailable. Try again when it reconnects.";
  return detail || (status ? `Nodes could not complete this request (${status}).` : "Cannot reach nodes. Check your connection and try again.");
}
export async function subhubRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init }); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; throw new SubhubError(0, subhubErrorMessage(0)); }
  let body: unknown;
  try { body = await response.json(); } catch { /* Older hubs may serve an HTML 404. */ }
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
    throw new SubhubError(response.status, subhubErrorMessage(response.status, detail));
  }
  if (body === undefined) throw new SubhubError(response.status, "The hub returned an unreadable node response.");
  return body as T;
}
export async function driveDownload(url: string): Promise<Blob> {
  let response: Response;
  try { response = await fetch(url, { credentials: "same-origin", cache: "no-store" }); }
  catch { throw new SubhubError(0, subhubErrorMessage(0)); }
  if (!response.ok) throw new SubhubError(response.status, subhubErrorMessage(response.status));
  return response.blob();
}
export function jsonMutation<T>(path: string, body: unknown, method = "POST", extraHeaders: Record<string, string> = {}) {
  return subhubRequest<T>(subhubUrl(path), { method, headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
}
export function nodeReady(node: SubhubNode) { return node.healthy && node.enabled; }
export function nodeState(node: SubhubNode) { return !node.enabled ? "Paused" : !node.healthy ? "Offline" : node.status === "degraded" ? "Needs attention" : "Online"; }
export function nodesForProject(nodes: SubhubNode[], project?: string) { return project ? nodes.filter(node => node.backups.some(backup => backup.project === project)) : nodes; }
export function activityForProject(activity: SubhubActivity[], project?: string) { return project ? activity.filter(item => item.subject === project || item.subject.startsWith(project + "/")) : activity; }
export function driveHeaders(existing?: Pick<DriveFile, "sha256">): Record<string, string> {
  return existing ? { "If-Match": `"${existing.sha256}"` } : { "If-None-Match": "*" };
}
export function validDrivePath(path: string) {
  return !!path && path.length <= 1024 && !path.startsWith("/") && !/[:\\\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function quote(value: string, shell: "powershell" | "sh") {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return "'" + (shell === "powershell" ? value.replace(/'/g, "''") : value.replace(/'/g, "'\"'\"'")) + "'";
}
export function connectCommand({ space, id, mode, storage, advertise, shell = "powershell" }: { space: string; id: string; mode: SubhubMode; storage: string; advertise?: string; shell?: "powershell" | "sh" }) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(space) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Use a node ID with lowercase letters, numbers, hyphens or underscores.");
  if (!storage.trim() || /[\r\n\u0000]/.test(storage)) throw new Error("Choose a dedicated local storage directory.");
  if (mode === "drive" && !advertise) throw new Error("Drive mode needs an HTTPS address reachable from the hub.");
  if (advertise) {
    if (/[\r\n\u0000]/.test(advertise)) throw new Error("Enter a valid HTTPS address for this node.");
    let url: URL; try { url = new URL(advertise); } catch { throw new Error("Enter a valid HTTPS address for this node."); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS node address without credentials, a query or a fragment.");
  }
  const args = ["spacehub", "node", "run", "--space", space, "--id", id, "--mode", mode, "--storage", storage];
  if (advertise) args.push("--advertise", advertise);
  return args.map(value => quote(value, shell)).join(" ");
}
export function restoreCommand(snapshot: string) { return `spacehub node restore ${quote(snapshot, "powershell")} <new-directory> --storage <node-storage-directory>`; }
export function ownsLease(work: SubhubWork, me: string | null, now = Date.now()) { return !!me && work.status === "claimed" && work.worker === me && (work.leaseUntil ?? 0) > now; }
export function canClaim(work: SubhubWork, now = Date.now()) { return work.status === "queued" || (work.status === "claimed" && (work.leaseUntil ?? 0) <= now); }
