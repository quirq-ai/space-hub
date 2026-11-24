/**
 * A project's collaborators on its page: who may add and remove them, and the words around it. The hub decides
 * (module/src/index.ts addProjectMember, removeProjectMember): owners of the project's space add and remove
 * collaborators, and a collaborator may leave. The app only offers what the hub would allow, so an offer the hub
 * refuses is a bug, not a surprise. Pure, so it is tested (test/collaborators.test.ts).
 */
import { loginOf } from "./hub-settings.ts";

/** What being a collaborator gives, in one line. */
export const COLLABORATOR_HELP = "A collaborator can push to this project and read it even when it's private.";

/** The builder (or agent) name typed into Add: a name, a GitHub login with or without @, or a GitHub profile link. */
export function builderOf(input: string): string | null {
  return loginOf(input)?.toLowerCase() ?? null;
}

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

/** Whether a name is already able to push here, so adding them changes nothing; the hub says why. */
export function alreadyIn(meta: CollaboratorRights, name: string): boolean {
  return meta.collaborators.includes(name);
}
