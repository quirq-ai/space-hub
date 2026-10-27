import type { WorkspaceSnapshot } from "@/lib/types";

/** Where the page is: the hub (no space), a space, or a project. Paths inside a project live in the #hash. */
export type Place = { space: string; project: string };

export type Here = { agent: string; mode: string; project: string };
export type ActivityItem = { at: string; agent: string; kind: string; path: string; subject: string; text: string; count: number };
export type Meta =
  | { level: "hub"; spaces: number; projects: number; bytes: number; activity: ActivityItem[]; here: Here[] }
  | { level: "space"; name: string; kind: string; description: string; parent: string; owners: string[]; members: string[]; projects: number; bytes: number; github: string; here: Here[]; activity: ActivityItem[] }
  | { level: "project"; fullName: string; space: string; name: string; description: string; defaultBranch: string; bytes: number; head: { oid: string; subject: string; author: string; time: string } | null; canWrite: boolean; here: Here[]; activity: ActivityItem[] };
export type View = { snapshot: WorkspaceSnapshot; meta: Meta };

export function placeOf(pathname: string): Place {
  const [space = "", project = ""] = pathname.split("/").filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  return { space, project };
}

export function placeUrl(place: Place): string {
  return "/" + [place.space, place.project].filter(Boolean).map(encodeURIComponent).join("/");
}

export function viewUrl(place: Place, path = ""): string {
  const query = new URLSearchParams();
  if (place.space) query.set("space", place.space);
  if (place.project) query.set("project", place.project);
  if (path) query.set("path", path);
  return "/-/api/view" + (query.size ? "?" + query : "");
}

/** The module's raw view of a file, for image previews and PDFs. */
export function rawUrl(place: Place, branch: string, path: string): string {
  return `${placeUrl(place)}/raw/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

const VERBS: Record<string, string> = {
  agent_registered: "joined the hub", project_created: "created", project_edited: "edited", project_deleted: "deleted",
  org_created: "created the org", org_deleted: "deleted the org", space_edited: "edited",
  space_member_added: "added a member to", space_member_removed: "removed a member from",
  project_member_added: "added a collaborator to", project_member_removed: "removed a collaborator from",
  ref_created: "pushed a new", ref_updated: "pushed to", ref_forced: "force-pushed", ref_deleted: "deleted", ref_diverged: "diverged from GitHub on",
  import_done: "imported", import_failed: "could not import", space_linked: "linked to GitHub:", space_unlinked: "unlinked from GitHub:",
  space_synced: "synced from GitHub:", space_sync_failed: "could not sync from GitHub:",
  agent_created: "created the agent", agent_deleted: "deleted the agent", agent_connected: "connected", agent_disconnected: "disconnected",
  builder_set: "credited a builder for", builder_cleared: "cleared the builder of",
};

/** One line for an activity row: who did what, where. */
export function activityLine(item: ActivityItem): { title: string; body: string } {
  const verb = VERBS[item.kind] ?? item.kind.replace(/_/g, " ");
  const ref = item.subject.replace(/^refs\/(heads|tags)\//, "");
  const where = item.kind.startsWith("ref_") ? `${ref} in ${item.path}` : item.path || item.subject;
  const commits = item.kind === "ref_updated" && item.count > 1 ? ` (${item.count} commits)` : "";
  return { title: `${item.agent || "someone"} ${verb} ${where}${commits}`, body: item.text };
}
