// The web UI: a small, GitHub-like, read-only view of everything in the
// database, rendered to HTML inside the module. No JavaScript.
//
//   /                                   spaces and people
//   /<owner>                            an owner's spaces
//   /<owner>/<space>                    files at the default branch + README
//   /<owner>/<space>/tree/<ref>/<path>  a folder
//   /<owner>/<space>/blob/<ref>/<path>  a file
//   /<owner>/<space>/raw/<ref>/<path>   a file, as plain bytes
//   /<owner>/<space>/commits/<ref>      history
//   /<owner>/<space>/commit/<oid>       one commit and the files it changed
//   /<owner>/<space>/refs               branches and tags
//
// Behind the server's proxy the original request URI arrives in an
// X-Spacehub-Uri header and links are written as /<path>. Opened directly on
// SpacetimeDB (/v1/database/<db>/route/ui?p=<path>) links stay as ?p=<path>.
import { objectKey, readObject, type Db } from './store';

export interface UiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

type Space = NonNullable<ReturnType<Db['space']['fullName']['find']>>;

interface Person {
  name: string;
  email: string;
  time: number;
}

interface Commit {
  oid: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

interface Entry {
  mode: string;
  name: string;
  oid: string;
  type: 'tree' | 'blob' | 'commit';
}

class NotFound extends Error {}

const decoder = new TextDecoder('utf-8');
const MAX_SHOWN_BYTES = 1024 * 1024;
const LOG_LIMIT = 100;
const DIFF_LIMIT = 300;

// ---------------------------------------------------------------- helpers

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function hex(bytes: Uint8Array) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function decodeParam(s: string) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function pageSegments(uri: string, forwarded: string | null): string[] {
  if (forwarded !== null) {
    // Still percent-encoded, so decode each segment on its own.
    const path = forwarded.split(/[?#]/)[0];
    return path.split('/').filter(Boolean).map(seg => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
  }
  const q = uri.indexOf('?');
  let path = '';
  if (q >= 0) {
    for (const pair of uri.slice(q + 1).split('&')) {
      if (pair.startsWith('p=')) path = decodeParam(pair.slice(2));
    }
  }
  return path.split('/').filter(Boolean);
}

function hostOf(uri: string) {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(uri);
  return m ? m[1] : 'localhost';
}

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function micros(ts: { microsSinceUnixEpoch: bigint }) {
  return Number(ts.microsSinceUnixEpoch / 1_000_000n);
}

function shortRef(name: string) {
  return name.replace(/^refs\/(heads|tags)\//, '');
}

// ---------------------------------------------------------------- git parsing

function parsePerson(value: string): Person {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(value);
  return m ? { name: m[1], email: m[2], time: Number(m[3]) } : { name: value, email: '', time: 0 };
}

function parseCommit(oid: string, data: Uint8Array): Commit {
  const text = decoder.decode(data);
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const commit: Commit = {
    oid,
    tree: '',
    parents: [],
    author: parsePerson(''),
    committer: parsePerson(''),
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue;
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parsePerson(value);
    else if (key === 'committer') commit.committer = parsePerson(value);
  }
  return commit;
}

function parseTree(data: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (data[sp] !== 0x20) sp++;
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    const mode = String.fromCharCode(...data.subarray(i, sp));
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    entries.push({ mode, name: decoder.decode(data.subarray(sp + 1, nul)), oid: hex(data.subarray(nul + 1, nul + 21)), type });
    i = nul + 21;
  }
  return entries;
}

function loadCommit(db: Db, sp: Space, oid: string): Commit | null {
  let obj = readObject(db, sp.id, oid);
  // Annotated tags point at the commit through one or more tag objects.
  for (let hops = 0; obj && obj.kind === 'tag' && hops < 8; hops++) {
    const m = /^object ([0-9a-f]{40})$/m.exec(decoder.decode(obj.data));
    if (!m) return null;
    oid = m[1];
    obj = readObject(db, sp.id, oid);
  }
  return obj && obj.kind === 'commit' ? parseCommit(oid, obj.data) : null;
}

function loadTree(db: Db, sp: Space, oid: string): Entry[] {
  const obj = readObject(db, sp.id, oid);
  if (!obj || obj.kind !== 'tree') throw new NotFound(`tree ${oid} is missing`);
  return parseTree(obj.data).sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : b.type === 'tree' ? 1 : a.name.localeCompare(b.name)
  );
}

function refsOf(db: Db, sp: Space) {
  return [...db.gitRef.spaceId.filter(sp.id)].sort((a, b) => a.name.localeCompare(b.name));
}

// Split "<ref>/<path...>" where the ref itself may contain slashes: the
// longest prefix naming a branch or tag wins, else a full commit id.
function resolveRef(db: Db, sp: Space, segs: string[]) {
  const refs = refsOf(db, sp);
  for (let k = segs.length; k >= 1; k--) {
    const name = segs.slice(0, k).join('/');
    const ref = refs.find(r => r.name === `refs/heads/${name}`) ?? refs.find(r => r.name === `refs/tags/${name}`);
    if (ref) return { ref: name, oid: ref.oid, rest: segs.slice(k) };
  }
  if (segs[0] && /^[0-9a-f]{40}$/.test(segs[0])) return { ref: segs[0], oid: segs[0], rest: segs.slice(1) };
  throw new NotFound(`no branch, tag or commit "${segs.join('/')}"`);
}

function walk(db: Db, sp: Space, treeOid: string, path: string[]): { type: 'tree' | 'blob'; oid: string } {
  let current = { type: 'tree' as 'tree' | 'blob', oid: treeOid };
  for (const name of path) {
    if (current.type !== 'tree') throw new NotFound(`"${path.join('/')}" not found`);
    const entry = loadTree(db, sp, current.oid).find(e => e.name === name);
    if (!entry || entry.type === 'commit') throw new NotFound(`"${path.join('/')}" not found`);
    current = { type: entry.type, oid: entry.oid };
  }
  return current;
}

function history(db: Db, sp: Space, tip: string, limit: number): Commit[] {
  const first = loadCommit(db, sp, tip);
  if (!first) return [];
  const seen = new Set([first.oid]);
  const frontier = [first];
  const out: Commit[] = [];
  while (frontier.length > 0 && out.length < limit) {
    frontier.sort((a, b) => b.committer.time - a.committer.time);
    const c = frontier.shift()!;
    out.push(c);
    for (const p of c.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      const pc = loadCommit(db, sp, p);
      if (pc) frontier.push(pc);
    }
  }
  return out;
}

function changes(db: Db, sp: Space, before: string | null, after: string | null, prefix: string, out: { status: string; path: string }[]) {
  const a = new Map(before ? loadTree(db, sp, before).map(e => [e.name, e]) : []);
  const b = new Map(after ? loadTree(db, sp, after).map(e => [e.name, e]) : []);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (out.length >= DIFF_LIMIT) return;
    const x = a.get(name);
    const y = b.get(name);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    const path = prefix + name;
    if (x?.type === 'tree' || y?.type === 'tree') {
      changes(db, sp, x?.type === 'tree' ? x.oid : null, y?.type === 'tree' ? y.oid : null, `${path}/`, out);
      if (x && x.type !== 'tree') out.push({ status: 'D', path });
      if (y && y.type !== 'tree') out.push({ status: 'A', path });
    } else {
      out.push({ status: !x ? 'A' : !y ? 'D' : 'M', path });
    }
  }
}

// ---------------------------------------------------------------- rendering

const ICON_DIR =
  '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const ICON_FILE =
  '<svg class="i f" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--subtle:#f6f8fa;--link:#0969da;--head:#1f2328;--headfg:#fff;--dir:#54aeff;--A:#1a7f37;--D:#cf222e;--M:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--subtle:#151b23;--link:#4493f8;--head:#010409;--headfg:#e6edf3;--dir:#7d8590;--A:#3fb950;--D:#f85149;--M:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--head);padding:14px 16px}header a{color:var(--headfg);font-weight:600;font-size:16px}
main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;font-weight:400;margin:0 0 4px;word-break:break-word}h1 b{font-weight:600}
h2{font-size:14px;font-weight:600;margin:0 0 8px}
.desc{color:var(--muted);margin:0 0 12px}
nav.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:12px 0 20px;overflow-x:auto}
nav.tabs a{color:var(--fg);padding:8px 12px;border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a.on{border-color:#fd8c73;font-weight:600}nav.tabs a:hover{text-decoration:none;background:var(--subtle)}
.box{border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:16px}
.bar{background:var(--subtle);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center}
.bar .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table{width:100%;border-collapse:collapse}
td{padding:8px 16px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td.r{text-align:right;white-space:nowrap}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px}
pre{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.code{overflow-x:auto}.code table td{border:0;padding:0 12px;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px}
.code td.n{color:var(--muted);text-align:right;user-select:none;width:1%}
.pill{display:inline-block;border:1px solid var(--line);border-radius:2em;padding:0 8px;font-size:12px;color:var(--muted)}
.clone{display:block;padding:6px 8px;background:var(--subtle);border:1px solid var(--line);border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;user-select:all;overflow-x:auto;white-space:nowrap;margin:4px 0 12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}}
aside p{margin:0 0 12px}aside dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}aside dt{color:var(--muted)}aside dd{margin:0}
.i{width:16px;height:16px;fill:var(--dir);vertical-align:text-bottom;margin-right:8px}.i.f{fill:var(--muted)}
.st{font-weight:600;font-family:ui-monospace,Menlo,monospace;margin-right:8px}.A{color:var(--A)}.D{color:var(--D)}.M{color:var(--M)}
.empty{padding:32px 16px;text-align:center;color:var(--muted)}
`;

class Renderer {
  constructor(
    private db: Db,
    private now: number,
    private base: string | null,
    private host: string
  ) {}

  link(path: string) {
    const clean = path.split('/').filter(Boolean);
    if (this.base === null) return `?p=${encodeURIComponent(clean.join('/'))}`;
    return `${this.base.replace(/\/+$/, '')}/${clean.map(encodeURIComponent).join('/')}`;
  }

  a(path: string, text: string, cls = '') {
    return `<a href="${esc(this.link(path))}"${cls ? ` class="${cls}"` : ''}>${text}</a>`;
  }

  ago(seconds: number) {
    const d = this.now - seconds;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)} minutes ago`.replace(/^1 minutes/, '1 minute');
    if (d < 86400) return `${Math.floor(d / 3600)} hours ago`.replace(/^1 hours/, '1 hour');
    if (d < 86400 * 30) return `${Math.floor(d / 86400)} days ago`.replace(/^1 days/, '1 day');
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }

  page(title: string, body: string, status = 200): UiResponse {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><header>${this.a('', 'spacehub')}</header><main>${body}</main></body></html>`;
    return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }

  notFound(message: string) {
    return this.page('Not found', `<h1>Not found</h1><p class="desc">${esc(message)}</p><p>${this.a('', 'Back to all spaces')}</p>`, 404);
  }

  // -------------------------------------------------------------- pages

  home() {
    const spaces = [...this.db.space.iter()].sort((a, b) => micros(b.pushedAt) - micros(a.pushedAt));
    const users = [...this.db.user.iter()].sort((a, b) => a.username.localeCompare(b.username));
    const counts = new Map<string, number>();
    for (const s of spaces) counts.set(s.owner, (counts.get(s.owner) ?? 0) + 1);
    const rows = spaces
      .map(
        s => `<tr><td>${this.a(s.fullName, `<b>${esc(s.fullName)}</b>`)}${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}</td>
<td class="r"><span class="pill">${esc(s.defaultBranch)}</span></td><td class="r muted">Updated ${this.ago(micros(s.pushedAt))}</td></tr>`
      )
      .join('');
    const people = users
      .map(u => `<tr><td>${this.a(u.username, esc(u.username))}</td><td class="r muted">${counts.get(u.username) ?? 0} spaces</td></tr>`)
      .join('');
    const scheme = /^(localhost|127\.|\[::1\])/.test(this.host) ? 'ws' : 'wss';
    return this.page(
      'spacehub',
      `<div class="grid"><div><h1><b>Spaces</b> <span class="muted">${spaces.length}</span></h1><p class="desc">Git spaces on this server, most recently pushed first.</p>
<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No spaces yet.</div>'}</div></div>
<aside><h2>Connect</h2><p class="muted">Install the client, then:</p>
<code class="clone">spacehub auth login --server ${esc(`${scheme}://${this.host}`)} --username &lt;you&gt;</code>
<code class="clone">spacehub space create &lt;name&gt; --source . --push</code>
<h2>People <span class="muted">${users.length}</span></h2><div class="box">${people ? `<table>${people}</table>` : '<div class="empty">Nobody yet.</div>'}</div></aside></div>`
    );
  }

  owner(name: string) {
    const user = this.db.user.username.find(name);
    const spaces = [...this.db.space.owner.filter(name)].sort((a, b) => micros(b.pushedAt) - micros(a.pushedAt));
    if (!user && spaces.length === 0) return this.notFound(`No user "${name}".`);
    const rows = spaces
      .map(
        s => `<tr><td>${this.a(s.fullName, `<b>${esc(s.name)}</b>`)}${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}</td>
<td class="r muted">Updated ${this.ago(micros(s.pushedAt))}</td></tr>`
      )
      .join('');
    const since = user ? `<p class="desc">Joined ${this.ago(micros(user.createdAt))}</p>` : '';
    return this.page(name, `<h1><b>${esc(name)}</b></h1>${since}<div class="box">${rows ? `<table>${rows}</table>` : '<div class="empty">No spaces yet.</div>'}</div>`);
  }

  spaceHead(sp: Space, tab: 'code' | 'commits' | 'refs', ref: string) {
    const refs = refsOf(this.db, sp);
    const branches = refs.filter(r => r.name.startsWith('refs/heads/')).length;
    const tags = refs.filter(r => r.name.startsWith('refs/tags/')).length;
    const tabLink = (key: string, path: string, label: string) => this.a(path, label, key === tab ? 'on' : '');
    return `<h1>${this.a(sp.owner, esc(sp.owner))} / <b>${this.a(sp.fullName, esc(sp.name))}</b></h1>
${sp.description ? `<p class="desc">${esc(sp.description)}</p>` : ''}
<nav class="tabs">${tabLink('code', `${sp.fullName}/tree/${ref}`, 'Code')}${tabLink('commits', `${sp.fullName}/commits/${ref}`, 'Commits')}${tabLink('refs', `${sp.fullName}/refs`, `Branches ${branches} · Tags ${tags}`)}</nav>`;
  }

  aside(sp: Space) {
    const refs = refsOf(this.db, sp);
    return `<aside><h2>Clone</h2><code class="clone">git clone spacehub://${esc(sp.fullName)}</code>
<code class="clone">spacehub space clone ${esc(sp.fullName)}</code>
<h2>About</h2><dl><dt>Owner</dt><dd>${this.a(sp.owner, esc(sp.owner))}</dd><dt>Default</dt><dd>${esc(sp.defaultBranch)}</dd>
<dt>Branches</dt><dd>${refs.filter(r => r.name.startsWith('refs/heads/')).length}</dd><dt>Tags</dt><dd>${refs.filter(r => r.name.startsWith('refs/tags/')).length}</dd>
<dt>Objects</dt><dd>${sp.objectCount}</dd><dt>Created</dt><dd>${this.ago(micros(sp.createdAt))}</dd><dt>Pushed</dt><dd>${this.ago(micros(sp.pushedAt))}</dd></dl></aside>`;
  }

  latest(sp: Space, commit: Commit) {
    const subject = commit.message.split('\n')[0];
    return `<div class="bar"><span class="nowrap"><b>${esc(commit.author.name)}</b></span><span class="grow">${this.a(`${sp.fullName}/commit/${commit.oid}`, esc(subject), 'muted')}</span>
<span class="muted mono nowrap">${this.a(`${sp.fullName}/commit/${commit.oid}`, commit.oid.slice(0, 7))} · ${this.ago(commit.committer.time)}</span>
<span class="nowrap">${this.a(`${sp.fullName}/commits/${commit.oid}`, 'History')}</span></div>`;
  }

  crumbs(sp: Space, ref: string, path: string[]) {
    const parts = [this.a(`${sp.fullName}/tree/${ref}`, `<b>${esc(sp.name)}</b>`)];
    path.forEach((name, i) => {
      const sub = path.slice(0, i + 1).join('/');
      parts.push(i === path.length - 1 ? `<b>${esc(name)}</b>` : this.a(`${sp.fullName}/tree/${ref}/${sub}`, esc(name)));
    });
    return parts.join(' / ');
  }

  emptySpace(sp: Space) {
    return this.page(
      sp.fullName,
      `${this.spaceHead(sp, 'code', sp.defaultBranch)}<div class="grid"><div class="box"><div class="empty">This space is empty. Push to it:<br><br>
<code>git remote add origin spacehub://${esc(sp.fullName)}<br>git push -u origin ${esc(sp.defaultBranch)}</code></div></div>${this.aside(sp)}</div>`
    );
  }

  tree(sp: Space, segs: string[] | null) {
    if (segs === null) {
      if (!refsOf(this.db, sp).some(r => r.name === `refs/heads/${sp.defaultBranch}`)) {
        if (refsOf(this.db, sp).length === 0) return this.emptySpace(sp);
        segs = [shortRef(refsOf(this.db, sp)[0].name)];
      } else {
        segs = [sp.defaultBranch];
      }
    }
    const { ref, oid, rest } = resolveRef(this.db, sp, segs);
    const commit = loadCommit(this.db, sp, oid);
    if (!commit) throw new NotFound(`"${ref}" does not point at a commit`);
    const target = walk(this.db, sp, commit.tree, rest);
    if (target.type === 'blob') return this.blob(sp, [ref, ...rest]);
    const entries = loadTree(this.db, sp, target.oid);
    const prefix = rest.length ? `${rest.join('/')}/` : '';
    const up = rest.length
      ? `<tr><td colspan="2">${this.a(`${sp.fullName}/tree/${ref}/${rest.slice(0, -1).join('/')}`, '..')}</td></tr>`
      : '';
    const rows = entries
      .map(e => {
        if (e.type === 'commit') return `<tr><td>${ICON_DIR}${esc(e.name)} <span class="muted">@ ${e.oid.slice(0, 7)} (submodule)</span></td><td></td></tr>`;
        const kind = e.type === 'tree' ? 'tree' : 'blob';
        const row = e.type === 'blob' ? this.db.gitObject.key.find(objectKey(sp.id, e.oid)) : null;
        return `<tr><td>${e.type === 'tree' ? ICON_DIR : ICON_FILE}${this.a(`${sp.fullName}/${kind}/${ref}/${prefix}${e.name}`, esc(e.name))}</td>
<td class="r muted">${row ? size(Number(row.size)) : ''}</td></tr>`;
      })
      .join('');
    const readme = entries.find(e => e.type === 'blob' && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name));
    let readmeBox = '';
    if (readme) {
      const obj = readObject(this.db, sp.id, readme.oid);
      if (obj && obj.data.length <= MAX_SHOWN_BYTES && !obj.data.subarray(0, 8000).includes(0)) {
        readmeBox = `<div class="box"><div class="bar"><b>${esc(readme.name)}</b></div><pre>${esc(decoder.decode(obj.data))}</pre></div>`;
      }
    }
    const crumbs = rest.length ? `<p>${this.crumbs(sp, ref, rest)}</p>` : '';
    const listing = `${crumbs}<div class="box"><div class="bar"><span class="pill">${esc(ref)}</span></div>${this.latest(sp, commit)}<table>${up}${rows}</table></div>${readmeBox}`;
    const body = rest.length ? listing : `<div class="grid"><div>${listing}</div>${this.aside(sp)}</div>`;
    return this.page(`${sp.fullName}${rest.length ? `/${rest.join('/')}` : ''}`, `${this.spaceHead(sp, 'code', ref)}${body}`);
  }

  fileAt(sp: Space, segs: string[]) {
    const { ref, oid, rest } = resolveRef(this.db, sp, segs);
    const commit = loadCommit(this.db, sp, oid);
    if (!commit) throw new NotFound(`"${ref}" does not point at a commit`);
    if (rest.length === 0) throw new NotFound('no file path given');
    const target = walk(this.db, sp, commit.tree, rest);
    if (target.type !== 'blob') throw new NotFound(`"${rest.join('/')}" is a folder`);
    const obj = readObject(this.db, sp.id, target.oid);
    if (!obj) throw new NotFound(`blob ${target.oid} is missing`);
    return { ref, rest, data: obj.data, commit };
  }

  blob(sp: Space, segs: string[]) {
    const { ref, rest, data } = this.fileAt(sp, segs);
    const binary = data.subarray(0, 8000).includes(0);
    const rawLink = this.a(`${sp.fullName}/raw/${ref}/${rest.join('/')}`, 'Raw');
    let content: string;
    if (binary) content = `<div class="empty">Binary file, ${size(data.length)}. ${rawLink}</div>`;
    else if (data.length > MAX_SHOWN_BYTES) content = `<div class="empty">File too large to show (${size(data.length)}). ${rawLink}</div>`;
    else {
      const lines = decoder.decode(data).split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      content = `<div class="code"><table>${lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td>${esc(l)}</td></tr>`).join('')}</table></div>`;
    }
    let lineCount = '';
    if (!binary && data.length <= MAX_SHOWN_BYTES) {
      let n = 0;
      for (const b of data) if (b === 10) n++;
      if (data.length > 0 && data[data.length - 1] !== 10) n++;
      lineCount = `${n} lines · `;
    }
    return this.page(
      `${rest.join('/')} at ${ref} · ${sp.fullName}`,
      `${this.spaceHead(sp, 'code', ref)}<p>${this.crumbs(sp, ref, rest)}</p><div class="box"><div class="bar"><span class="pill">${esc(ref)}</span><span class="grow muted">${lineCount}${size(data.length)}</span>${rawLink}</div>${content}</div>`
    );
  }

  raw(sp: Space, segs: string[]): UiResponse {
    const { data } = this.fileAt(sp, segs);
    const binary = data.subarray(0, 8000).includes(0);
    // Never text/html: a pushed file must not run as a page on this origin.
    return {
      status: 200,
      headers: {
        'content-type': binary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        'content-security-policy': "default-src 'none'; sandbox",
      },
      body: data,
    };
  }

  commits(sp: Space, segs: string[]) {
    if (segs.length === 0) segs = [sp.defaultBranch];
    const { ref, oid } = resolveRef(this.db, sp, segs);
    const list = history(this.db, sp, oid, LOG_LIMIT);
    const rows = list
      .map(c => {
        const subject = c.message.split('\n')[0];
        return `<tr><td>${this.a(`${sp.fullName}/commit/${c.oid}`, `<b>${esc(subject || '(no message)')}</b>`)}<div class="muted">${esc(c.author.name)} committed ${this.ago(c.committer.time)}</div></td>
<td class="r mono">${this.a(`${sp.fullName}/commit/${c.oid}`, c.oid.slice(0, 7))}<br>${this.a(`${sp.fullName}/tree/${c.oid}`, 'Browse')}</td></tr>`;
      })
      .join('');
    const more = list.length === LOG_LIMIT ? `<p class="muted">Showing the latest ${LOG_LIMIT} commits.</p>` : '';
    return this.page(
      `Commits · ${sp.fullName}`,
      `${this.spaceHead(sp, 'commits', ref)}<div class="box"><div class="bar"><span class="pill">${esc(ref)}</span><span class="muted">${list.length} commits</span></div><table>${rows}</table></div>${more}`
    );
  }

  commit(sp: Space, oid: string) {
    const c = /^[0-9a-f]{40}$/.test(oid) ? loadCommit(this.db, sp, oid) : null;
    if (!c) throw new NotFound(`no commit ${oid}`);
    const files: { status: string; path: string }[] = [];
    const first = c.parents[0] ? loadCommit(this.db, sp, c.parents[0]) : null;
    changes(this.db, sp, first ? first.tree : null, c.tree, '', files);
    const rows = files
      .map(f => {
        const label = f.status === 'D' ? esc(f.path) : this.a(`${sp.fullName}/blob/${c.oid}/${f.path}`, esc(f.path));
        return `<tr><td><span class="st ${f.status}">${f.status}</span>${label}</td></tr>`;
      })
      .join('');
    const [subject, ...body] = c.message.replace(/\n+$/, '').split('\n');
    const parents = c.parents.map(p => this.a(`${sp.fullName}/commit/${p}`, p.slice(0, 7))).join(', ');
    const capped = files.length >= DIFF_LIMIT ? `<p class="muted">Showing the first ${DIFF_LIMIT} changed files.</p>` : '';
    return this.page(
      `${subject} · ${sp.fullName}@${c.oid.slice(0, 7)}`,
      `${this.spaceHead(sp, 'commits', c.oid)}<div class="box"><div class="bar"><b class="grow">${esc(subject || '(no message)')}</b>${this.a(`${sp.fullName}/tree/${c.oid}`, 'Browse files')}</div>
${body.join('\n').trim() ? `<pre>${esc(body.join('\n').trim())}</pre>` : ''}
<div class="bar" style="border-top:1px solid var(--line);border-bottom:0"><span class="grow"><b>${esc(c.author.name)}</b> <span class="muted">&lt;${esc(c.author.email)}&gt; authored ${this.ago(c.author.time)}</span></span>
<span class="muted mono">${parents ? `parent ${parents} · ` : ''}commit ${c.oid}</span></div></div>
<div class="box"><div class="bar"><b>${files.length} changed files</b> <span class="muted">${first ? `compared with ${c.parents[0].slice(0, 7)}` : 'root commit'}</span></div>${rows ? `<table>${rows}</table>` : '<div class="empty">No file changes.</div>'}</div>${capped}`
    );
  }

  refs(sp: Space) {
    const refs = refsOf(this.db, sp);
    const section = (title: string, prefix: string) => {
      const list = refs.filter(r => r.name.startsWith(prefix));
      const rows = list
        .map(r => {
          const name = shortRef(r.name);
          const c = loadCommit(this.db, sp, r.oid);
          const isDefault = prefix === 'refs/heads/' && name === sp.defaultBranch ? ' <span class="pill">default</span>' : '';
          return `<tr><td>${this.a(`${sp.fullName}/tree/${name}`, `<b>${esc(name)}</b>`)}${isDefault}${c ? `<div class="muted">${esc(c.message.split('\n')[0])}</div>` : ''}</td>
<td class="r muted"><span class="mono">${this.a(`${sp.fullName}/commit/${c?.oid ?? r.oid}`, (c?.oid ?? r.oid).slice(0, 7))}</span><br>updated ${this.ago(micros(r.updatedAt))}</td></tr>`;
        })
        .join('');
      return `<div class="box"><div class="bar"><b>${title}</b><span class="muted">${list.length}</span></div>${rows ? `<table>${rows}</table>` : '<div class="empty">None.</div>'}</div>`;
    };
    return this.page(`Branches and tags · ${sp.fullName}`, `${this.spaceHead(sp, 'refs', sp.defaultBranch)}${section('Branches', 'refs/heads/')}${section('Tags', 'refs/tags/')}`);
  }

  route(segs: string[]): UiResponse {
    if (segs.length === 0) return this.home();
    if (segs.length === 1) return this.owner(segs[0]);
    const sp = this.db.space.fullName.find(`${segs[0]}/${segs[1]}`);
    if (!sp) return this.notFound(`No space "${segs[0]}/${segs[1]}".`);
    const [view, ...rest] = segs.slice(2);
    switch (view) {
      case undefined:
        return this.tree(sp, null);
      case 'tree':
        return rest.length ? this.tree(sp, rest) : this.tree(sp, null);
      case 'blob':
        return this.blob(sp, rest);
      case 'raw':
        return this.raw(sp, rest);
      case 'commits':
        return this.commits(sp, rest);
      case 'commit':
        return this.commit(sp, rest[0] ?? '');
      case 'refs':
      case 'branches':
      case 'tags':
        return this.refs(sp);
    }
    return this.notFound(`No page "${segs.join('/')}".`);
  }
}

export function renderUi(db: Db, uri: string, forwardedUri: string | null, nowSeconds: number): UiResponse {
  const r = new Renderer(db, nowSeconds, forwardedUri === null ? null : '/', hostOf(uri));
  let res: UiResponse;
  try {
    res = r.route(pageSegments(uri, forwardedUri));
  } catch (err) {
    if (err instanceof NotFound) res = r.notFound(err.message);
    else res = r.page('Error', `<h1>Something went wrong</h1><pre>${esc(String(err))}</pre>`, 500);
  }
  res.headers['x-content-type-options'] = 'nosniff';
  res.headers['content-security-policy'] ??= "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  res.headers['referrer-policy'] = 'same-origin';
  return res;
}
