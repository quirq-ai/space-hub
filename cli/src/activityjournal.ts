// The activity journal: every activity row the hub records, also written to
// files on the hub's own disk, append-only, so the feed's history is kept
// even apart from the database. Nothing here ever deletes or rewrites a line.
//
// The web service keeps one subscription to the activity table and appends
// each row, once, to <dir>/activity-YYYY-MM.jsonl (the month it was
// journaled), one JSON object per line:
//
//   {"op":"insert","id":"42","at":"2026-11-06T12:00:00.000Z","projectId":"7","path":"quirq/quirq",
//    "agent":"euler","kind":"ref_updated","subject":"refs/heads/main","oid":"…","count":1,"text":"…"}
//
// A row changed later (a rename rewrites the names in it) adds an "update"
// line with its new fields, and a row removed from the database adds a
// "delete" line; the insert stays. On start the journal reads the last id it
// wrote and asks only for newer rows, so a restart catches up on whatever was
// recorded while it was away, and a row is never journaled twice.
//
//   SPACEHUB_ACTIVITY_DIR  where (default <data root>/activity; the data root is
//                          SPACEHUB_DATA_ROOT, /data in the server image). "off" turns it off.
//
// The folder sits in the data folder, so backups (hubbackup.ts) and sub-hubs
// copying it live (hubdata.ts) keep it too.
import fs from 'node:fs';
import path from 'node:path';

export interface ActivityRowIn {
  id: bigint;
  at: { microsSinceUnixEpoch: bigint };
  projectId: bigint;
  path: string;
  agent: string;
  kind: string;
  subject: string;
  oid: string;
  count: number;
  text: string;
}

export interface JournalLine {
  op: 'insert' | 'update' | 'delete';
  id: string;
  at: string;
  projectId: string;
  path: string;
  agent: string;
  kind: string;
  subject: string;
  oid: string;
  count: number;
  text: string;
  /** When the journal wrote the line. */
  journaledAt: string;
}

const FILE = /^activity-(\d{4})-(\d{2})\.jsonl$/;

export function activityJournalDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = (env.SPACEHUB_ACTIVITY_DIR ?? '').trim();
  if (dir === 'off') return null;
  if (dir) return path.resolve(dir);
  const root = (env.SPACEHUB_DATA_ROOT ?? '').trim();
  return root ? path.join(path.resolve(root), 'activity') : null;
}

/** The journal's files, oldest first. */
export function journalFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(name => FILE.test(name)).sort().map(name => path.join(dir, name));
}

/** Every line of the journal, oldest first; a torn last line (a crash mid-write) is skipped. */
export function readJournal(dir: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const file of journalFiles(dir)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalLine);
      } catch {
        // A line cut short by a crash; the row comes again after it (catch-up).
      }
    }
  }
  return out;
}

function iso(micros: bigint) {
  return new Date(Number(micros / 1000n)).toISOString();
}

export class ActivityJournal {
  readonly dir: string;
  private now: () => Date;
  /** The newest row id journaled (inserts only); rows at or below it are already on disk. */
  lastId = 0n;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
    this.lastId = this.scanLastId();
  }

  // Ids grow with time and files are named by when they were written, so
  // the newest insert is in the newest file that has one.
  private scanLastId(): bigint {
    let last = 0n;
    for (const file of journalFiles(this.dir).reverse()) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const row = JSON.parse(line) as Partial<JournalLine>;
          if (row.op === 'insert' && typeof row.id === 'string' && /^\d+$/.test(row.id) && BigInt(row.id) > last) last = BigInt(row.id);
        } catch {
          // a torn line
        }
      }
      if (last > 0n) break;
    }
    return last;
  }

  private file(at: Date) {
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    return path.join(this.dir, `activity-${month}.jsonl`);
  }

  private write(lines: JournalLine[]) {
    if (!lines.length) return;
    const at = this.now();
    const file = this.file(at);
    // A file cut short by a crash may end mid-line: start on a fresh line.
    let lead = '';
    try {
      const size = fs.statSync(file).size;
      if (size > 0) {
        const fd = fs.openSync(file, 'r');
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) lead = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // a new file
    }
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, lead + lines.map(line => JSON.stringify({ ...line, journaledAt: at.toISOString() })).join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(op: JournalLine['op'], row: ActivityRowIn): JournalLine {
    return {
      op,
      id: String(row.id),
      at: iso(row.at.microsSinceUnixEpoch),
      projectId: String(row.projectId),
      path: row.path,
      agent: row.agent,
      kind: row.kind,
      subject: row.subject,
      oid: row.oid,
      count: row.count,
      text: row.text,
      journaledAt: '',
    };
  }

  /** Append the rows not journaled yet, oldest first; returns how many were new. */
  insert(rows: Iterable<ActivityRowIn>): number {
    const fresh = [...rows].filter(row => row.id > this.lastId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!fresh.length) return 0;
    this.write(fresh.map(row => this.line('insert', row)));
    this.lastId = fresh[fresh.length - 1].id;
    return fresh.length;
  }

  update(row: ActivityRowIn) {
    this.write([this.line('update', row)]);
  }

  delete(row: ActivityRowIn) {
    this.write([this.line('delete', row)]);
  }
}

/** The surface of the SDK connection the journal uses (conn.ts). */
export interface JournalConn {
  db: {
    activity: {
      onInsert(cb: (ctx: { event: { tag: string } }, row: ActivityRowIn) => void): void;
      onUpdate(cb: (ctx: { event: { tag: string } }, old: ActivityRowIn, row: ActivityRowIn) => void): void;
      onDelete(cb: (ctx: { event: { tag: string } }, row: ActivityRowIn) => void): void;
    };
  };
}

const live = (ctx: { event: { tag: string } }) => ctx.event.tag !== 'SubscribeApplied' && ctx.event.tag !== 'UnsubscribeApplied';

/**
 * Feed a journal from a connection: every row inserted (the subscription's
 * first rows included, which is the catch-up), and later changes to rows.
 * Write errors are reported, never thrown into the SDK.
 */
export function attachJournal(journal: ActivityJournal, conn: JournalConn, report: (message: string) => void) {
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      report(`activity journal: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // The first rows of a subscription (the catch-up) come one by one in one
  // go: write them together, in one append.
  let pending: ActivityRowIn[] = [];
  const flush = () => {
    if (!pending.length) return;
    const rows = pending;
    pending = [];
    guard(() => journal.insert(rows));
  };
  conn.db.activity.onInsert((_ctx, row) => {
    if (!pending.length) setImmediate(flush);
    pending.push(row);
  });
  // A change to a row comes after the row: write what is waiting first.
  conn.db.activity.onUpdate((ctx, _old, row) => { if (live(ctx)) { flush(); guard(() => journal.update(row)); } });
  conn.db.activity.onDelete((ctx, row) => { if (live(ctx)) { flush(); guard(() => journal.delete(row)); } });
}

/**
 * Run the journal for the web service: connect, subscribe to the rows newer
 * than the journal's last, and keep going (the SDK reconnects and replays).
 */
export function startActivityJournal(dir: string, connect: () => Promise<JournalConn & { subscribeNewer(after: bigint, onApplied: () => void, onError: (message: string) => void): void }>, report: (message: string) => void = message => process.stderr.write(`spacehub-web: ${message}\n`)) {
  const journal = new ActivityJournal(dir);
  const attempt = () => {
    connect()
      .then(conn => {
        attachJournal(journal, conn, report);
        conn.subscribeNewer(journal.lastId, () => {}, message => report(`activity journal: ${message}`));
      })
      .catch(err => {
        report(`activity journal: ${err instanceof Error ? err.message : String(err)}; retrying`);
        setTimeout(attempt, 3000);
      });
  };
  attempt();
  return journal;
}
