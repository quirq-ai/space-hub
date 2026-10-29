// The app's code views as JSON: branches and tags, a folder or file at any
// ref, history, one commit with its diffs, and every path of a project (for
// search). They reuse the git helpers of the server-rendered pages (ui.ts),
// so both views of a project always agree.
//
//   GET /api?space=&project=&view=refs
//   GET /api?space=&project=&view=tree&ref=&path=     a folder or a file
//   GET /api?space=&project=&view=commits&ref=&path=&page=
//   GET /api?space=&project=&view=commit&oid=
//   GET /api?space=&project=&view=files&ref=
import { DELETE, INSERT, diffLines, toHunks } from './diff';
import { objectKey, readObject, type Db } from './store';
import { NotFound, Renderer, type Change, type Commit } from './ui';

const PAGE_SIZE = 30;
const HISTORY_SCAN = 5000;
const MAX_SHOWN_BYTES = 1024 * 1024;
export const README_BYTES = 256 * 1024;
const DIFF_FILES = 300;
const DIFF_MAX_BYTES = 256 * 1024;
const DIFF_MAX_ROWS = 4000;
const FILES_MAX = 5000;

type Project = NonNullable<ReturnType<Db['project']['fullName']['find']>>;
const decoder = new TextDecoder('utf-8');

export class CodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function renderer(db: Db, now: number) {
  return new Renderer(db, { uri: 'http://localhost/', forwardedUri: null, cookie: null, proto: null, now }, new Map());
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export interface CommitSummary {
  oid: string;
  subject: string;
  author: string;
  time: string;
  parents: string[];
}

function summary(c: Commit): CommitSummary {
  return { oid: c.oid, subject: c.message.split('\n')[0], author: c.author.name, time: iso(c.committer.time), parents: c.parents };
}

/** A path inside a repository: dotfiles are fine here, traversal is not. */
function parts(path: string): string[] {
  const out = path.split('/').filter(Boolean);
  if (path.includes('\0') || out.some(part => part === '.' || part === '..')) throw new CodeError('That path is not valid.', 400);
  return out;
}

function at(r: Renderer, project: Project, ref: string) {
  const name = ref || project.defaultBranch;
  try {
    const found = r.resolve(project, name.split('/'));
    if (found.rest.length) throw new NotFound(name);
    const commit = r.commit(project, found.oid);
    if (!commit) throw new NotFound(name);
    return { ref: found.ref, commit };
  } catch (error) {
    if (error instanceof NotFound) throw new CodeError(`There is no branch, tag or commit ${name}.`, 404);
    throw error;
  }
}

function isBinary(data: Uint8Array) {
  return data.subarray(0, 8000).includes(0);
}

const sizeOf = (db: Db, project: Project, oid: string) => Number(db.gitObject.key.find(objectKey(project.id, oid))?.size ?? 0n);

export function refsView(db: Db, project: Project, now: number) {
  const r = renderer(db, now);
  const diverged = r.diverged(project);
  const rows = r.refs(project).map(ref => {
    const commit = r.commit(project, ref.oid);
    const branch = ref.name.startsWith('refs/heads/');
    return {
      name: ref.name.replace(/^refs\/(heads|tags)\//, ''),
      kind: branch ? 'branch' : 'tag',
      oid: ref.oid,
      updatedAt: new Date(Number(ref.updatedAt.microsSinceUnixEpoch / 1000n)).toISOString(),
      commit: commit ? summary(commit) : null,
      diverged: diverged.has(ref.name),
    };
  });
  const byTime = (a: (typeof rows)[number], b: (typeof rows)[number]) => (b.commit?.time ?? '').localeCompare(a.commit?.time ?? '');
  return {
    defaultBranch: project.defaultBranch,
    branches: rows.filter(row => row.kind === 'branch').sort((a, b) => (a.name === project.defaultBranch ? -1 : b.name === project.defaultBranch ? 1 : byTime(a, b))),
    tags: rows.filter(row => row.kind === 'tag').sort(byTime),
  };
}

export function treeView(db: Db, project: Project, ref: string, path: string, now: number) {
  const r = renderer(db, now);
  const { ref: name, commit } = at(r, project, ref);
  const segs = parts(path);
  const target = segs.length ? r.locate(project, commit.tree, segs) : { type: 'tree' as const, oid: commit.tree };
  if (!target) throw new CodeError(`${path} is not in ${name}.`, 404);
  const base = { ref: name, commit: summary(commit), path: segs.join('/') };
  if (target.type === 'tree') {
    const entries = r.tree(project, target.oid);
    const { folderCommit, byName } = r.lastChanges(project, commit.oid, segs, entries.map(entry => entry.name));
    const readme = entries.find(entry => entry.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(entry.name));
    let readmeText: string | null = null;
    if (readme) {
      const obj = readObject(db, project.id, readme.oid);
      if (obj && obj.data.length <= README_BYTES && !isBinary(obj.data)) readmeText = decoder.decode(obj.data);
    }
    return {
      ...base,
      kind: 'tree' as const,
      last: folderCommit ? summary(folderCommit) : null,
      entries: entries.map(entry => {
        const last = byName.get(entry.name);
        return {
          name: entry.name,
          type: entry.mode === '120000' ? 'link' : entry.type,
          size: entry.type === 'blob' ? sizeOf(db, project, entry.oid) : 0,
          last: last ? summary(last) : null,
        };
      }),
      readme: readme && readmeText !== null ? { name: readme.name, content: readmeText } : null,
    };
  }
  if (target.type !== 'blob') throw new CodeError(`${path} is a submodule.`, 400);
  const obj = readObject(db, project.id, target.oid);
  if (!obj) throw new CodeError(`The hub is missing ${path}.`, 500);
  const binary = isBinary(obj.data);
  const { byName } = r.lastChanges(project, commit.oid, segs.slice(0, -1), [segs[segs.length - 1]]);
  const last = byName.get(segs[segs.length - 1]);
  return {
    ...base,
    kind: 'blob' as const,
    size: obj.data.length,
    binary,
    text: !binary && obj.data.length <= MAX_SHOWN_BYTES ? decoder.decode(obj.data) : null,
    last: last ? summary(last) : null,
  };
}

export function commitsView(db: Db, project: Project, ref: string, path: string, page: number, now: number) {
  const r = renderer(db, now);
  const { ref: name, commit } = at(r, project, ref);
  const segs = parts(path);
  const current = Math.max(1, Math.min(1000, Math.floor(page) || 1));
  const want = current * PAGE_SIZE + 1;
  const matches: Commit[] = [];
  for (const c of r.history(project, commit.oid, segs.length ? HISTORY_SCAN : want)) {
    if (r.touches(project, c, segs)) matches.push(c);
    if (matches.length >= want) break;
  }
  return {
    ref: name,
    path: segs.join('/'),
    page: current,
    commits: matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map(summary),
    more: matches.length > current * PAGE_SIZE,
  };
}

type Line = [kind: ' ' | '+' | '-', before: number | null, after: number | null, text: string];

export function commitView(db: Db, project: Project, oid: string, now: number) {
  const r = renderer(db, now);
  const c = /^[0-9a-f]{40}$/.test(oid) ? r.commit(project, oid) : null;
  if (!c) throw new CodeError(`There is no commit ${oid}.`, 404);
  const changes: Change[] = [];
  const first = c.parents[0] ? r.commit(project, c.parents[0]) : null;
  r.changes(project, first ? first.tree : null, c.tree, '', changes);
  let budget = DIFF_MAX_ROWS;
  const files = changes.map(change => {
    const base = { status: change.status, path: change.path, adds: 0, dels: 0 };
    if (budget <= 0) return { ...base, note: 'Not shown: this commit changes too much to show at once.' };
    const before = r.blobText(project, change.before);
    const after = r.blobText(project, change.after);
    if (before === 'binary' || after === 'binary') return { ...base, note: 'Binary file.' };
    if (before === 'large' || after === 'large') return { ...base, note: 'Large file, diff not shown.' };
    const ops = before.length + after.length > 20000 ? null : diffLines(before, after);
    if (!ops) return { ...base, note: 'Diff too large to show.' };
    const hunks: { header: string; lines: Line[] }[] = [];
    for (const h of toHunks(ops)) {
      if (budget <= 0) break;
      hunks.push({
        header: `@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`,
        lines: h.ops.map(([kind, ai, bi]): Line =>
          kind === INSERT ? ['+', null, bi + 1, after[bi]] : kind === DELETE ? ['-', ai + 1, null, before[ai]] : [' ', ai + 1, bi + 1, after[bi]]
        ),
      });
      budget -= h.ops.length + 1;
    }
    return { ...base, adds: ops.filter(o => o[0] === INSERT).length, dels: ops.filter(o => o[0] === DELETE).length, hunks };
  });
  const [subject, ...rest] = c.message.replace(/\n+$/, '').split('\n');
  return {
    oid: c.oid,
    subject,
    body: rest.join('\n').trim(),
    author: { name: c.author.name, time: iso(c.author.time) },
    committer: { name: c.committer.name, time: iso(c.committer.time) },
    parents: c.parents,
    files,
    truncated: changes.length >= DIFF_FILES,
  };
}

export function filesView(db: Db, project: Project, ref: string, now: number) {
  const r = renderer(db, now);
  const { ref: name, commit } = at(r, project, ref);
  const paths: string[] = [];
  const walk = (oid: string, prefix: string) => {
    for (const entry of r.tree(project, oid)) {
      if (paths.length >= FILES_MAX) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.type === 'tree') walk(entry.oid, `${prefix}${entry.name}/`);
      else if (entry.type === 'blob') paths.push(prefix + entry.name);
    }
  };
  walk(commit.tree, '');
  return { ref: name, paths, truncated: paths.length >= FILES_MAX };
}
