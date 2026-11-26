// Private projects from the terminal: `project create --private|--public`,
// `project visibility <project> [public|private]`, and the word `project list`
// and `project view` show. The module decides who may do what (only owners of
// the project's space change it; module/src/index.ts setProjectVisibility);
// this file only reads the flags and picks the reducer. Pure, so it is tested
// with fake reducers (test/visibility.test.ts).

export type Visibility = 'public' | 'private';

export class VisibilityUsage extends Error {}

/** A visibility as typed ("Private", " public "), or null when it is neither. */
export function parseVisibility(word: string | undefined): Visibility | null {
  const v = (word ?? '').trim().toLowerCase();
  return v === 'public' || v === 'private' ? v : null;
}

/**
 * `--private` or `--public`, taken out of `args`; undefined when neither is
 * there (the project then takes the hub's default, as before these flags).
 */
export function takeVisibilityFlag(args: string[]): Visibility | undefined {
  const found: Visibility[] = [];
  for (const flag of ['--private', '--public'] as const) {
    const i = args.indexOf(flag);
    if (i < 0) continue;
    args.splice(i, 1);
    found.push(flag === '--private' ? 'private' : 'public');
  }
  if (found.length > 1) throw new VisibilityUsage('pass --private or --public, not both');
  return found[0];
}

// The reducers these commands call, as the generated bindings name them.
export interface CreateReducers {
  createProject(args: { space: string; name: string; description: string }): Promise<unknown>;
  createProjectFromTemplate(args: { space: string; name: string; description: string; template: string; goal: string }): Promise<unknown>;
  createProjectWithVisibility(args: { space: string; name: string; description: string; visibility: string }): Promise<unknown>;
  createProjectFromTemplateWithVisibility(args: { space: string; name: string; description: string; template: string; goal: string; visibility: string }): Promise<unknown>;
}

export interface CreateRequest {
  space: string;
  name: string;
  description: string;
  /** Set for a project made from a template ("" or "goal": the built-in goal space). */
  template?: string;
  goal?: string;
  visibility?: Visibility;
}

/**
 * Create the project. Without a chosen visibility the older reducers run
 * (so a hub whose module predates visibility still works); with one, the
 * *WithVisibility reducers.
 */
export async function createProject(reducers: CreateReducers, r: CreateRequest): Promise<void> {
  const base = { space: r.space, name: r.name, description: r.description };
  if (r.template !== undefined) {
    const fromTemplate = { ...base, template: r.template, goal: r.goal ?? '' };
    if (r.visibility) await reducers.createProjectFromTemplateWithVisibility({ ...fromTemplate, visibility: r.visibility });
    else await reducers.createProjectFromTemplate(fromTemplate);
  } else if (r.visibility) {
    await reducers.createProjectWithVisibility({ ...base, visibility: r.visibility });
  } else {
    await reducers.createProject(base);
  }
}

export const VISIBILITY_USAGE = 'usage: spacehub project visibility [<project>] [public|private]';

/**
 * `project visibility` arguments: [<project>] [public|private]. One word that
 * is a visibility is the new value for the project of the current clone.
 */
export function parseVisibilityArgs(args: string[]): { project?: string; visibility?: Visibility } {
  if (args.length > 2) throw new VisibilityUsage(VISIBILITY_USAGE);
  const [first, second] = args;
  if (second !== undefined) {
    const visibility = parseVisibility(second);
    if (!visibility) throw new VisibilityUsage(`"${second}" is not public or private; ${VISIBILITY_USAGE}`);
    return { project: first, visibility };
  }
  if (first === undefined) return {};
  const visibility = parseVisibility(first);
  return visibility ? { visibility } : { project: first };
}

/** Who reads a project, in a line, after its visibility. */
export function visibilityLine(visibility: Visibility): string {
  return visibility === 'private'
    ? "private: only its space's owners and members, its collaborators and their agents can see it"
    : 'public: anyone who can read the hub can see it';
}

/** The New project page's choices (web.ts newPage), in the words of Settings → Hub. */
export const VISIBILITY_CHOICES: { value: Visibility; label: string; help: string }[] = [
  { value: 'public', label: 'Public', help: 'Anyone who can read the hub sees it.' },
  { value: 'private', label: 'Private', help: "Only its space's owners and members, its collaborators and their agents see it." },
];

// lucide's lock and globe, as the app draws them.
const svg = (paths: string) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const LOCK_SVG = svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>');
const GLOBE_SVG = svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>');

const escHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The New project page's Public / Private choice. `chosen` is what the form
 * sent back, else the hub's default; null (the web service could not read the
 * default) checks neither, and an empty answer leaves it to the hub.
 */
export function visibilityField(chosen: Visibility | null): string {
  const choices = VISIBILITY_CHOICES.map(c =>
    `<label style="display:flex;gap:10px;align-items:flex-start;margin:0;padding:10px 12px;border:1px solid var(--line, #d0d7de);border-radius:8px;font-weight:normal;cursor:pointer">` +
    `<input type="radio" name="visibility" value="${c.value}"${c.value === chosen ? ' checked' : ''} style="width:auto;margin:3px 0 0">` +
    `<span><b style="display:inline-flex;align-items:center;gap:5px">${c.value === 'private' ? LOCK_SVG : GLOBE_SVG}${escHtml(c.label)}</b><br><span class="muted">${escHtml(c.help)}</span></span></label>`
  ).join('');
  return `<fieldset style="border:0;margin:0;padding:0;min-width:0"><legend style="padding:0;margin-top:16px;font-weight:600;font-size:13px">Who can see it <span class="muted" style="font-weight:400">owners of the space can change this later, on the project's page</span></legend>` +
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:6px">${choices}</div></fieldset>`;
}

/** The ids of private projects, from visible_project_visibility rows. */
export function privateIds(rows: Iterable<{ projectId: bigint; visibility: string }>): Set<bigint> {
  const ids = new Set<bigint>();
  for (const row of rows) if (row.visibility === 'private') ids.add(row.projectId);
  return ids;
}
