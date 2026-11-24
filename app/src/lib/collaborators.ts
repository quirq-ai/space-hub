/**
 * A project's collaborators on its page: who may add and remove them, and the words around it. The hub decides
 * (module/src/index.ts addProjectMember, removeProjectMember): owners of the project's space add and remove
 * collaborators, and a collaborator may leave. The app only offers what the hub would allow, so an offer the hub
 * refuses is a bug, not a surprise. Pure, so it is tested (test/collaborators.test.ts).
 */

/** What being a collaborator gives, in one line. */
export const COLLABORATOR_HELP = "A collaborator can push to this project and read it even when it's private.";

/** Who may change the list, as the project's page has it (meta.canManageCollaborators; absent from an older hub). */
export type CollaboratorRights = { canManageCollaborators?: boolean; collaborators: string[] };

/** Whether the viewer may add collaborators: owners of the project's space. */
export function canAdd(meta: CollaboratorRights): boolean {
  return meta.canManageCollaborators === true;
}

/** Whether the viewer may take `name` off the list: an owner of the space anyone, a collaborator only themself. */
export function canRemove(meta: CollaboratorRights, me: string | null, name: string): boolean {
  if (!meta.collaborators.includes(name)) return false;
  return canAdd(meta) || (!!me && me === name);
}

/** What Remove (or Leave) asks first. */
export function removeConfirm(project: string, name: string, me: string | null): string {
  return me === name
    ? `Leave ${project}? You will no longer push to it, nor read it if it is private.`
    : `Remove ${name} from ${project}? They will no longer push to it, nor read it if it is private.`;
}

/** Someone the picker offers: a builder of the hub, or an agent the viewer owns. */
export type Candidate = { name: string; kind: "builder" | "agent" };

/** Who already reaches the project, as its page has it. */
export type ProjectAccess = { space: string; owners: string[]; members: string[]; collaborators: string[]; agents: string[] };

/**
 * What the hub's own view (/-/api/view, the one search reads) says about who is here: its spaces, each with a
 * detail like "builder · 3 projects", and its agents with the space that owns them. Any viewer of the hub reads it,
 * so the picker shows nobody the viewer could not already find.
 */
export type HubPeople = { entries: { name: string; detail?: string }[]; agents: { name: string; parent: string }[] };

/**
 * Whom Add may offer: the hub's builders, and agents the viewer owns (the hub lets you add only your own agents:
 * module/src/index.ts addProjectMember), without anyone who can already push here: the space itself, its owners,
 * members and connected agents, and the project's collaborators. Sorted by name.
 */
export function candidatesOf(access: ProjectAccess, hub: HubPeople, me: string | null): Candidate[] {
  const has = new Set([access.space, ...access.owners, ...access.members, ...access.collaborators, ...access.agents]);
  const builders = hub.entries.filter(entry => entry.detail?.startsWith("builder")).map(entry => ({ name: entry.name, kind: "builder" as const }));
  const agents = me ? hub.agents.filter(agent => agent.parent === me).map(agent => ({ name: agent.name, kind: "agent" as const })) : [];
  return [...builders, ...agents].filter(c => !has.has(c.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The candidates matching what is typed: any part of the name, ignoring case and a leading @; names that start with it first. */
export function matchCandidates(candidates: Candidate[], query: string): Candidate[] {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return candidates;
  const hits = candidates.filter(c => c.name.toLowerCase().includes(q));
  return [...hits.filter(c => c.name.toLowerCase().startsWith(q)), ...hits.filter(c => !c.name.toLowerCase().startsWith(q))];
}

/** The candidate whose name is exactly what is typed (ignoring case and @), so Add knows whom it adds. */
export function chosenOf(candidates: Candidate[], query: string): Candidate | null {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  return candidates.find(c => c.name.toLowerCase() === q) ?? null;
}

/** Where the highlighted option goes on a key in the list (ArrowDown, ArrowUp, Home, End), wrapping round; -1 for none. */
export function moveActive(active: number, key: string, length: number): number {
  if (length === 0) return -1;
  if (key === "ArrowDown") return active < 0 || active >= length - 1 ? 0 : active + 1;
  if (key === "ArrowUp") return active <= 0 ? length - 1 : active - 1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return active;
}

/** What the open list says when it shows no one: nobody left at all, or nobody matching. */
export function pickerNote(total: number, matches: number, query: string, space: string): string | null {
  if (total === 0) return `Everyone on this hub can already push here: owners and members of ${space}, and its collaborators.`;
  if (matches === 0) return `No builder matches “${query.trim()}”.`;
  return null;
}
