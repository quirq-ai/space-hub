// What a client sees of the hub, with its own token or none (a new anonymous
// identity): row counts of every visible_* view, by subscription, and of
// every table and view by HTTP SQL. Prints one JSON object; scripts/leak-test.sh
// bundles and runs it.
//   node probe.mjs <ws url> <database> [token] [--watch-toggle] [--no-raw]
import { DbConnection, tables } from '../cli/src/module_bindings';

// The SDK chats on console.log; stdout is for the result.
console.log = console.info = console.debug = () => {};

const [url, database, token] =process.argv.slice(2).filter(a => !a.startsWith('--'));
const http = url.replace(/^ws/, 'http');

// Every table the module has (public before protocol 2) and every view clients read.
export const TABLES = [
  'user', 'project', 'git_ref', 'git_object', 'object_chunk', 'project_import', 'project_builder', 'activity',
  'project_member', 'presence', 'space', 'space_role', 'space_link', 'space_github', 'ref_sync', 'project_size',
  'agent', 'space_alias', 'question',
  // private from the start
  'agent_secret', 'hub_state', 'xo_record', 'xo_agent', 'github_account', 'builder_suspension', 'xo_link', 'runner', 'worker',
  'project_visibility', 'project_access',
];
const VIEWS = Object.keys(tables) as (keyof typeof tables)[];

async function sql(query: string, bearer: string): Promise<number | string> {
  const res = await fetch(`${http}/v1/database/${database}/sql`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: query });
  if (!res.ok) return `refused (${res.status})`;
  const body = (await res.json()) as { rows: unknown[] }[];
  return body.reduce((n, r) => n + r.rows.length, 0);
}

function connect(): Promise<{ conn: DbConnection; token: string }> {
  return new Promise((resolve, reject) => {
    DbConnection.builder().withUri(url).withDatabaseName(database).withToken(token)
      .onConnect((conn, _id, issued) => resolve({ conn, token: issued }))
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

function subscribeAll(conn: DbConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.subscriptionBuilder().onApplied(() => resolve()).onError(ctx => reject(new Error(String((ctx as { event?: unknown }).event))))
      .subscribe(VIEWS.map(v => tables[v]));
  });
}

// A raw subscription to one private table: refused, or 0 rows.
function subscribeTable(conn: DbConnection, table: string): Promise<string> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('no answer'), 5000);
    conn.subscriptionBuilder()
      .onApplied(() => { clearTimeout(timer); resolve('applied'); })
      .onError(() => { clearTimeout(timer); resolve('refused'); })
      .subscribe(`SELECT * FROM ${table}`);
  });
}

const counts = (conn: DbConnection) => Object.fromEntries(VIEWS.map(v => [v, Number((conn.db as any)[v].count())]));

// Rows of each view that belongs to projects, by project id ("0": about no project).
const projectOf = (view: string, row: any): bigint | undefined => (view === 'visibleProject' ? row.id : row.projectId);
function byProject(conn: DbConnection) {
  const out: Record<string, Record<string, number>> = {};
  for (const v of VIEWS) {
    for (const row of (conn.db as any)[v].iter()) {
      const p = projectOf(v, row);
      if (typeof p !== 'bigint') break; // a directory view: no project column
      (out[v] ??= {})[String(p)] = (out[v]?.[String(p)] ?? 0) + 1;
    }
  }
  return out;
}

// Which views hold a row whose text has one of LEAK_FIND's words: names,
// descriptions, and git object bodies read as text.
const latin1 = new TextDecoder('latin1');
function found(conn: DbConnection) {
  const words = (process.env.LEAK_FIND ?? '').split(',').filter(Boolean);
  const out: Record<string, string[]> = {};
  for (const v of VIEWS) {
    for (const row of (conn.db as any)[v].iter()) {
      const text = JSON.stringify(row, (_k, x) => (typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? latin1.decode(x) : x));
      for (const w of words) if (text.includes(w) && !out[w]?.includes(v)) (out[w] ??= []).push(v);
    }
  }
  return out;
}

// Project ids by name, as the caller sees them.
const projectIds = (conn: DbConnection) => Object.fromEntries([...conn.db.visibleProject.iter()].map(p => [p.fullName, String(p.id)]));
const snap = (conn: DbConnection) => ({ subscribed: counts(conn), byProject: byProject(conn), found: found(conn), projects: projectIds(conn) });

const { conn, token: mine } = await connect();
await subscribeAll(conn);
const out: Record<string, unknown> = snap(conn);
const raw: Record<string, string> = {};
// The admin owns the database and may subscribe to tables, whose rows these bindings can't decode: skip it there.
if (!process.argv.includes('--no-raw')) for (const table of TABLES) raw[table] = await subscribeTable(conn, table);
out.rawTableSubscriptions = raw;
const viaSql: Record<string, number | string> = {};
for (const name of [...TABLES, ...VIEWS.map(v => v.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`))]) viaSql[name] = await sql(`SELECT * FROM ${name}`, mine);
out.sql = viaSql;
out.token = mine;
if (process.argv.includes('--watch-toggle')) {
  // Stay subscribed while the caller changes who may read (members-only, a
  // project's visibility or collaborators), then touches the file named by LEAK_SIGNAL.
  process.stdout.write(JSON.stringify(out) + '\n');
  const fs = await import('node:fs');
  const signal = process.env.LEAK_SIGNAL!;
  while (!fs.existsSync(signal)) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 1500));
  const after = snap(conn);
  process.stdout.write(JSON.stringify({ afterToggle: after.subscribed, after }) + '\n');
} else {
  process.stdout.write(JSON.stringify(out) + '\n');
}
conn.disconnect();
process.exit(0);
