import type { WorkspaceSnapshot } from "@/lib/types";

/** Where the page is: the hub (no space), a space, or a project. */
export type Place = { space: string; project: string };

export type Here = { agent: string; mode: string; project: string };
export type ActivityItem = { at: string; agent: string; kind: string; path: string; subject: string; text: string; count: number };
export type Membership = { space: string; kind: string; role: string };
export type ProjectCard = { fullName: string; description: string; pushedAt: string };

export type HubMeta = { level: "hub"; spaces: number; projects: number; bytes: number; activity: ActivityItem[]; here: Here[]; allProjects: ProjectCard[] };
export type SpaceMeta = {
  level: "space"; name: string; displayName: string; kind: string; description: string; parent: string; owners: string[]; members: string[];
  projects: number; bytes: number; github: string; githubLogin: string; createdAt: string; memberOf: Membership[]; agents: string[];
  collaborates: string[]; here: Here[]; activity: ActivityItem[];
};
export type ProjectMeta = {
  level: "project"; fullName: string; space: string; name: string; description: string; defaultBranch: string; bytes: number;
  head: { oid: string; subject: string; author: string; time: string } | null; canWrite: boolean; owners: string[]; members: string[];
  collaborators: string[]; here: Here[]; activity: ActivityItem[];
};
export type Meta = HubMeta | SpaceMeta | ProjectMeta;
export type View<M extends Meta = Meta> = { snapshot: WorkspaceSnapshot; meta: M };

export type CommitSummary = { oid: string; subject: string; author: string; time: string; parents: string[] };
export type Refs = { defaultBranch: string; branches: RefRow[]; tags: RefRow[] };
export type RefRow = { name: string; kind: "branch" | "tag"; oid: string; updatedAt: string; commit: CommitSummary | null; diverged: boolean };
export type TreeEntry = { name: string; type: "tree" | "blob" | "commit" | "link"; size: number; last: CommitSummary | null };
export type CodeTree = { kind: "tree"; ref: string; commit: CommitSummary; path: string; last: CommitSummary | null; entries: TreeEntry[]; readme: { name: string; content: string } | null };
export type CodeBlob = { kind: "blob"; ref: string; commit: CommitSummary; path: string; size: number; binary: boolean; text: string | null; last: CommitSummary | null };
export type Commits = { ref: string; path: string; page: number; commits: CommitSummary[]; more: boolean };
export type DiffLine = [kind: " " | "+" | "-", before: number | null, after: number | null, text: string];
export type DiffFile = { status: "A" | "D" | "M"; path: string; adds: number; dels: number; note?: string; hunks?: { header: string; lines: DiffLine[] }[] };
export type CommitDetail = { oid: string; subject: string; body: string; author: { name: string; time: string }; committer: { name: string; time: string }; parents: string[]; files: DiffFile[]; truncated: boolean };
export type Files = { ref: string; paths: string[]; truncated: boolean };

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.size ? "?" + search : "";
}

/** The hub, a space, or a project's workspace (open-chat snapshots). */
export function viewUrl(place: Place, path = ""): string {
  return "/-/api/view" + query({ space: place.space, project: place.project, path });
}

/** A project's code views. */
export function codeUrl(place: Place, view: "refs" | "tree" | "commits" | "commit" | "files", params: { ref?: string; path?: string; page?: number; oid?: string } = {}): string {
  return "/-/api/view" + query({ space: place.space, project: place.project, view, ...params });
}

export function placeUrl(place: Place, hash = ""): string {
  return "/" + [place.space, place.project].filter(Boolean).map(encodeURIComponent).join("/") + (hash ? "#" + hash : "");
}

export function avatarUrl(name: string): string {
  return "/-/avatar/" + encodeURIComponent(name.toLowerCase());
}

/** The module's raw view of a file, for image previews and PDFs. */
export function rawUrl(place: Place, ref: string, path: string): string {
  return `${placeUrl(place)}/raw/${ref.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function kindLabel(kind: string): string {
  return kind === "personal" ? "Builder" : kind === "org" ? "Org" : kind === "agent" ? "Agent" : "Space";
}

const VERBS: Record<string, string> = {
  agent_registered: "joined the hub", project_created: "created", project_edited: "edited", project_deleted: "deleted",
  org_created: "created the org", org_deleted: "deleted the org", space_edited: "edited",
  space_member_added: "added a member to", space_member_removed: "removed a member from",
  project_member_added: "added a collaborator to", project_member_removed: "removed a collaborator from",
  ref_created: "pushed a new branch to", ref_updated: "pushed to", ref_forced: "force-pushed to", ref_deleted: "deleted a branch of", ref_diverged: "diverged from GitHub on",
  import_done: "imported", import_failed: "could not import", space_linked: "linked to GitHub:", space_unlinked: "unlinked from GitHub:",
  space_synced: "synced from GitHub:", space_sync_failed: "could not sync from GitHub:",
  agent_created: "created the agent", agent_deleted: "deleted the agent", agent_connected: "connected", agent_disconnected: "disconnected",
  builder_set: "credited a builder for", builder_cleared: "cleared the builder of",
};

/** One activity row: who, what, where, and a link target when there is one. */
export function activityLine(item: ActivityItem): { verb: string; where: string; detail: string; href: string } {
  const verb = VERBS[item.kind] ?? item.kind.replace(/_/g, " ");
  const branch = item.subject.replace(/^refs\/(heads|tags)\//, "");
  const [space, project] = item.path.split("/");
  const href = project ? placeUrl({ space, project }) : space ? placeUrl({ space, project: "" }) : "";
  const commits = item.kind === "ref_updated" && item.count > 1 ? ` · ${item.count} commits` : "";
  return { verb, where: item.path || item.subject, detail: (item.kind.startsWith("ref_") ? branch + (item.text ? " · " + item.text : "") : item.text) + commits, href };
}
