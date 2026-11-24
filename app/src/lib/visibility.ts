/**
 * Private projects in the app: the Public / Private control on a project's page (pages/project.tsx), the lock
 * badge wherever projects are listed (components/private-badge.tsx), and the activity line of a change. The
 * module decides who reads what (module/src/store.ts canRead) and who may change it (owners of the project's
 * space, setProjectVisibility); the app only shows it. Pure, so it is tested (test/visibility.test.ts).
 */

export type Visibility = "public" | "private";

/** Who reads a private project, in a sentence: under the control, and as the badge's tooltip. */
export const PRIVATE_READERS = "Only its space's owners and members, its collaborators and their agents can see it.";
export const PUBLIC_READERS = "Anyone who can read the hub can see it.";

/** The two choices on a project's page, in the words of Settings → Hub's "New projects start". */
export const PROJECT_VISIBILITIES: { value: Visibility; label: string; help: string }[] = [
  { value: "public", label: "Public", help: PUBLIC_READERS },
  { value: "private", label: "Private", help: PRIVATE_READERS },
];

/** A visibility from the hub's JSON: only "private" is private; anything else (or nothing, an older hub) is public. */
export function visibilityOf(value: unknown): Visibility {
  return value === "private" ? "private" : "public";
}

/** What to ask before the change, or null when it needs no question (making a project private only narrows who reads it). */
export function confirmText(fullName: string, next: Visibility): string | null {
  return next === "public" ? `Make ${fullName} public? Anyone who can read this hub will see its files, history and activity.` : null;
}

/** The activity row of a change ("visibility_changed", its subject the new visibility): the verb and the line under it. */
export function visibilityActivity(subject: string): { verb: string; detail: string } {
  return visibilityOf(subject) === "private"
    ? { verb: "made private", detail: PRIVATE_READERS }
    : { verb: "made public", detail: PUBLIC_READERS };
}

/**
 * The private projects among those opened recently, kept in this browser for the sidebar's Recent list (which has
 * only names): `fullName` added when its page said private, taken out when it said public. Only projects this
 * viewer has read are ever in it.
 */
export function markPrivate(list: string[], fullName: string, isPrivate: boolean): string[] {
  const rest = list.filter(name => name !== fullName);
  return (isPrivate ? [fullName, ...rest] : rest).slice(0, 50);
}
