// The module's own pages (ui.ts) and data (workspace.ts), as one person may
// see them. The module's HTTP handlers (index.ts ui, api) have no caller
// identity of their own: the web service, which checks the session, asks on
// the person's behalf (cli/src/modulepage.ts) with two headers:
//
//   X-Spacehub-Secret  the secret the web service registered at start
//                      (setWebSecret, hub_state "webSecret", private)
//   X-Spacehub-Viewer  the verified builder's name, or empty when signed out
//
// The proxy strips both from every client request, and a request without the
// right secret is someone signed out, whatever it claims. readerDb then gives
// the renderers a database where a project the viewer may not read (store.ts
// canRead, the one rule) does not exist: not in listings, counts, sizes,
// activity, presence, nor by name. A private project looks exactly like a
// missing one.
import { canReadAs, inSpace, spaceFor, type Db } from './store';

export const WEB_SECRET_KEY = 'webSecret';
export const SECRET_HEADER = 'x-spacehub-secret';
export const VIEWER_HEADER = 'x-spacehub-viewer';

// Long enough to be a secret; letters, digits, "-" and "_" (hex or base64url).
export const WEB_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

// Same length and every character compared, so the time taken says nothing
// about how much of a guess was right.
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Who a page request is for: the builder the web service named, when it sent
 * the secret it registered; otherwise null (signed out). A name this
 * database does not know is signed out too.
 */
export function webViewer(db: Db, secret: string | null, name: string | null): string | null {
  const want = db.hubState.key.find(WEB_SECRET_KEY)?.value ?? '';
  if (!WEB_SECRET.test(want) || !secret || !sameSecret(secret, want)) return null;
  return name && /^[a-z0-9-]{1,39}$/.test(name) && db.user.username.find(name) ? name : null;
}

type Row = Record<string, unknown> & { projectId?: bigint; id?: bigint; path?: string };

// Tables whose rows belong to one project, and that project's id.
const PER_PROJECT: Record<string, (row: Row) => bigint> = {
  project: row => row.id as bigint,
  gitRef: row => row.projectId as bigint,
  gitObject: row => row.projectId as bigint,
  objectChunk: row => row.projectId as bigint,
  projectImport: row => row.projectId as bigint,
  projectBuilder: row => row.projectId as bigint,
  projectMember: row => row.projectId as bigint,
  projectSize: row => row.projectId as bigint,
  projectVisibility: row => row.projectId as bigint,
  projectAccess: row => row.projectId as bigint,
  refSync: row => row.projectId as bigint,
  question: row => row.projectId as bigint,
};

type Keep = (row: Row) => boolean;
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// A function of the real object, called on the real object.
function bound(target: Any, prop: PropertyKey) {
  const value = target[prop];
  return typeof value === 'function' ? value.bind(target) : value;
}

function* kept(rows: Iterable<Row>, keep: Keep) {
  for (const row of rows) if (keep(row)) yield row;
}

// One index of a filtered table: find answers null and filter skips rows the
// viewer may not read. (Proxies over an empty object, so the real handle's own
// property rules never constrain what they answer.)
function filteredIndex(index: Any, keep: Keep) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'find') return (key: unknown) => {
        const row = index.find(key);
        return row && keep(row) ? row : null;
      };
      if (prop === 'filter') return (key: unknown) => kept(index.filter(key), keep);
      return bound(index, prop);
    },
  });
}

function filteredTable(table: Any, keep: Keep) {
  const indexes = new Map<PropertyKey, unknown>();
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'iter' || prop === Symbol.iterator) return () => kept(table.iter(), keep);
      if (prop === 'count') return () => {
        let n = 0n;
        for (const row of table.iter()) if (keep(row)) n++;
        return n;
      };
      const value = table[prop];
      if (value && typeof value === 'object' && (typeof value.find === 'function' || typeof value.filter === 'function')) {
        if (!indexes.has(prop)) indexes.set(prop, filteredIndex(value, keep));
        return indexes.get(prop);
      }
      return bound(table, prop);
    },
  });
}

/**
 * The database as `viewer` (a builder's name, or null when signed out) may
 * read it: rows of projects canRead refuses are gone from every project
 * table, the activity feed and presence. Spaces, builders and agents stay
 * (their names are not secret; a members-only hub keeps strangers out at
 * the front door). An activity row of a project deleted since is shown only
 * to owners and members of the space in its path.
 */
export function readerDb(db: Db, viewer: string | null): Db {
  const known = new Map<bigint, boolean>();
  const reads = (projectId: bigint) => {
    let ok = known.get(projectId);
    if (ok === undefined) known.set(projectId, (ok = canReadAs(db, viewer, projectId)));
    return ok;
  };
  const keepActivity: Keep = row => {
    const id = row.projectId as bigint;
    if (id === 0n) return true;
    if (db.project.id.find(id)) return reads(id);
    const space = String(row.path ?? '').split('/')[0];
    return !!viewer && !!space && inSpace(db, spaceFor(db, space), viewer);
  };
  // A presence row of 0 follows a whole space, which is not secret.
  const keepPresence: Keep = row => row.projectId === 0n || reads(row.projectId as bigint);
  const tables = new Map<PropertyKey, unknown>();
  const real = db as Any;
  return new Proxy({}, {
    get(_, prop) {
      if (tables.has(prop)) return tables.get(prop);
      const of = typeof prop === 'string' ? PER_PROJECT[prop] : undefined;
      const keep: Keep | null = of ? row => reads(of(row)) : prop === 'activity' ? keepActivity : prop === 'presence' ? keepPresence : null;
      if (!keep) return bound(real, prop);
      const table = filteredTable(real[prop], keep);
      tables.set(prop, table);
      return table;
    },
  }) as Db;
}
