// A project's DEPS file: the other repositories it pins, by path, each to a
// commit. Workspaces that coordinate several repositories keep one at their
// root, as an ordered JSON object:
//
//   { "<path>": { "url": "https://github.com/<owner>/<repo>", "commit-hash": "<40 hex>" }, ... }
//
// The app shows each pin linked to the hub project that holds the repository
// (one imported or mirrored from that GitHub URL, or a quirq:// URL), and
// whether the pin is that project's newest commit.
//
//   GET /api?space=&project=&view=deps
import { readObject, refKey, type Db } from './store';
import { Renderer } from './ui';

type Project = NonNullable<ReturnType<Db['project']['fullName']['find']>>;

export const DEPS_FILE = 'DEPS';
const DEPS_BYTES = 256 * 1024;
const DEPS_MAX = 500;
/** How far back from a branch head a pin is looked for. */
const PIN_SCAN = 1000;
const decoder = new TextDecoder('utf-8');

export interface Pin {
  path: string;
  url: string;
  pin: string;
}

/** The pins of a DEPS file, in file order; null when it is not a JSON object of pins. */
export function parseDeps(text: string): Pin[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pins: Pin[] = [];
  for (const [path, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.url !== 'string') continue;
    const pin = row['commit-hash'] ?? row.commit ?? row.rev;
    pins.push({ path, url: row.url, pin: typeof pin === 'string' ? pin.trim().toLowerCase() : '' });
    if (pins.length >= DEPS_MAX) break;
  }
  return pins;
}

/** The DEPS text at the root of a tree, when there is one. */
export function depsText(db: Db, project: Project, root: { name: string; oid: string; mode: string }[]): string | null {
  const entry = root.find(e => e.name === DEPS_FILE && (e.mode === '100644' || e.mode === '100755'));
  if (!entry) return null;
  const object = readObject(db, project.id, entry.oid);
  if (!object || object.kind !== 'blob' || object.data.length > DEPS_BYTES) return null;
  return decoder.decode(object.data);
}

/** https://github.com/<owner>/<repo> for any spelling of a GitHub repository URL; '' otherwise. */
export function githubRepo(url: string): string {
  const m = /^(?:(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}`.toLowerCase() : '';
}

/** <space>/<project> for a quirq:// or spacehub:// URL; '' otherwise. */
function hubProject(url: string): string {
  const m = /^(?:quirq|spacehub):\/\/[^/]+\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1].toLowerCase()}/${m[2]}` : '';
}

export interface PinCommit {
  oid: string;
  subject: string;
  author: string;
  time: string;
}

export interface Dep {
  path: string;
  url: string;
  pin: string;
  /** The repository's GitHub page, when it is on GitHub. */
  github: string;
  /** The hub project holding the repository; '' when none does. */
  project: string;
  defaultBranch: string;
  /**
   * current   the pin is the project's newest commit on its default branch
   * behind    newer commits sit on top of the pin (`behind` of them)
   * elsewhere the hub has the commit, but not on the default branch's recent history
   * missing   the hub project does not have the pinned commit
   * external  no hub project holds the repository
   * invalid   the pin is not a full commit id
   */
  status: 'current' | 'behind' | 'elsewhere' | 'missing' | 'external' | 'invalid';
  behind: number;
  pinned: PinCommit | null;
  head: PinCommit | null;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function depsView(db: Db, project: Project, now: number) {
  const r = new Renderer(db, { uri: 'http://localhost/', forwardedUri: null, cookie: null, proto: null, now }, new Map());
  const headOid = db.gitRef.key.find(refKey(project.id, `refs/heads/${project.defaultBranch}`))?.oid ?? '';
  const head = headOid ? r.commit(project, headOid) : null;
  const text = head ? depsText(db, project, r.tree(project, head.tree)) : null;
  const pins = text === null ? null : parseDeps(text);
  const base = { ref: project.defaultBranch, path: DEPS_FILE, found: text !== null, valid: pins !== null };
  if (!pins) return { ...base, deps: [] as Dep[] };

  // Hub projects by the GitHub repository they were imported or mirrored from.
  const imported = new Map<string, bigint>();
  for (const row of db.projectImport.iter()) {
    const key = githubRepo(row.source);
    if (key && !imported.has(key)) imported.set(key, row.projectId);
  }
  const summary = (sp: Project, oid: string): PinCommit | null => {
    const c = r.commit(sp, oid);
    return c ? { oid: c.oid, subject: c.message.split('\n')[0].slice(0, 200), author: c.author.name, time: iso(c.committer.time) } : null;
  };

  const deps = pins.map((pin): Dep => {
    const github = githubRepo(pin.url);
    const byUrl = hubProject(pin.url);
    const id = github ? imported.get(github) : undefined;
    const sp = byUrl ? db.project.fullName.find(byUrl) : id !== undefined ? db.project.id.find(id) : undefined;
    const dep: Dep = { ...pin, github, project: sp?.fullName ?? '', defaultBranch: sp?.defaultBranch ?? '', status: 'external', behind: 0, pinned: null, head: null };
    if (!/^[0-9a-f]{40}$/.test(pin.pin)) return { ...dep, status: 'invalid' };
    if (!sp) return dep;
    const tip = db.gitRef.key.find(refKey(sp.id, `refs/heads/${sp.defaultBranch}`))?.oid ?? '';
    dep.head = tip ? summary(sp, tip) : null;
    dep.pinned = summary(sp, pin.pin);
    if (!dep.pinned) return { ...dep, status: 'missing' };
    if (tip === pin.pin) return { ...dep, status: 'current' };
    const behind = tip ? commitsAbove(r, sp, tip, pin.pin) : -1;
    return behind > 0 ? { ...dep, status: 'behind', behind } : { ...dep, status: 'elsewhere' };
  });
  return { ...base, deps };
}

/**
 * Commits on `tip` that the pin does not have, or -1 when the pin is not in
 * tip's history. Commits older than the pin cannot be newer work on top of
 * it, so the walk stops there instead of reading the whole history.
 */
function commitsAbove(r: Renderer, sp: Project, tip: string, pin: string): number {
  const since = r.commit(sp, pin)?.committer.time ?? 0;
  const seen = new Set([tip]);
  const stack = [tip];
  let found = false;
  let count = 0;
  while (stack.length > 0 && count < PIN_SCAN) {
    const oid = stack.pop()!;
    if (oid === pin) {
      found = true;
      continue;
    }
    const c = r.commit(sp, oid);
    if (!c || c.committer.time < since) continue;
    count++;
    for (const parent of c.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return found ? count : -1;
}
