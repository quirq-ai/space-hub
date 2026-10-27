// git-remote-quirq: lets plain git talk to a quirq hub.
//
//   git clone -o quirq quirq://hub.quirq.dev/alice/notes
//   git push quirq main
//   git fetch quirq
//
// git starts this program for any quirq:// URL (and, as git-remote-spacehub,
// for spacehub:// URLs of older clones) and speaks the remote
// helper protocol on stdin/stdout (see `man gitremote-helpers`). We implement
// the `list`, `fetch` and `push` capabilities on top of the spacehub reducers
// and subscriptions.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connect, errorMessage, findProject, listRefs, quietSdkLogs, snapshot, tables, type Conn } from './conn';
import { parseHubUrl } from './url';
import { git, objectsToSend, PackWriter, presentObjects, readObjects, type RawObject } from './git';

const CHUNK_SIZE = 1024 * 1024; // must match the module
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_OBJECTS = 2000;
const FETCH_WINDOW = 8 * 1024 * 1024;

quietSdkLogs();

const [, , remoteName, url] = process.argv;
const { server: hubServer, project: fullName } = parseUrl(url ?? remoteName ?? '');
let verbosity = 1;
const leases = new Map<string, string>();

let session: Promise<Conn> | null = null;
let remoteRefs = new Map<string, string>();

function parseUrl(raw: string) {
  return parseHubUrl(raw) ?? fail(`expected a URL like quirq://hub.quirq.dev/space/project, got "${raw}"`);
}

function fail(message: string): never {
  process.stderr.write(`fatal: quirq: ${message}\n`);
  process.exit(128);
}

function progress(message: string) {
  if (verbosity > 0) process.stderr.write(`quirq: ${message}\n`);
}

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function conn(): Promise<Conn> {
  session ??= connect(hubServer).then(c => c.conn);
  return session;
}

async function requireProject(c: Conn) {
  const sp = await findProject(c, fullName);
  if (!sp) {
    fail(`project "${fullName}" does not exist (create it with: spacehub project create ${fullName})`);
  }
  return sp;
}

async function list(): Promise<string> {
  const c = await conn();
  const sp = await requireProject(c);
  const refs = await listRefs(c, sp.id);
  remoteRefs = new Map(refs.map(r => [r.name, r.oid]));
  const lines = refs.map(r => `${r.oid} ${r.name}`);
  const head = `refs/heads/${sp.defaultBranch}`;
  if (remoteRefs.has(head)) lines.push(`@${head} HEAD`);
  return lines.map(l => `${l}\n`).join('') + '\n';
}

// ---------------------------------------------------------------- fetch

// Per-repository record of how far into the project's object log we have
// already downloaded, so later fetches only transfer new objects.
function stateFile() {
  const gitDir = process.env.GIT_DIR ?? '.git';
  return path.join(gitDir, 'spacehub', `${fullName.replace('/', '__')}.json`);
}

function readState(projectId: bigint): bigint {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return s.projectId === projectId.toString() ? BigInt(s.pos) : 0n;
  } catch {
    return 0n;
  }
}

function writeState(projectId: bigint, pos: bigint) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ projectId: projectId.toString(), pos: pos.toString() }) + '\n');
}

async function chunkedBody(c: Conn, projectId: bigint, oid: string, size: number, chunks: number): Promise<Uint8Array> {
  const body = new Uint8Array(size);
  const step = 8;
  for (let lo = 0; lo < chunks; lo += step) {
    const hi = Math.min(chunks, lo + step);
    await snapshot(
      c,
      tables.objectChunk.where(r => r.projectId.eq(projectId).and(r.oid.eq(oid)).and(r.idx.gte(lo)).and(r.idx.lt(hi))),
      () => {
        for (const ch of c.db.objectChunk.iter()) {
          if (ch.projectId === projectId && ch.oid === oid && ch.idx >= lo && ch.idx < hi) {
            body.set(ch.data, ch.idx * CHUNK_SIZE);
          }
        }
      }
    );
  }
  return body;
}

// Download every object logged after `from` and store the ones we lack.
async function download(c: Conn, projectId: bigint, from: bigint, to: bigint): Promise<number> {
  const pack = new PackWriter();
  for (let lo = from; lo < to; lo += BigInt(FETCH_WINDOW)) {
    const hi = lo + BigInt(FETCH_WINDOW);
    const rows = await snapshot(
      c,
      tables.gitObject.where(r => r.projectId.eq(projectId).and(r.pos.gt(lo)).and(r.pos.lte(hi))),
      () => [...c.db.gitObject.iter()].filter(r => r.projectId === projectId && r.pos > lo && r.pos <= hi)
    );
    const have = await presentObjects(rows.map(r => r.oid));
    for (const row of rows) {
      if (have.has(row.oid)) continue;
      const data = row.chunks === 0 ? row.data : await chunkedBody(c, projectId, row.oid, Number(row.size), row.chunks);
      pack.add(row.kind, data);
    }
  }
  if (pack.count > 0) progress(`received ${pack.count} objects (${mb(pack.bytes)})`);
  await pack.store();
  return pack.count;
}

// True when every wanted object and everything it references is present.
async function complete(wanted: string[]): Promise<boolean> {
  try {
    await git(['rev-list', '--objects', '--quiet', ...wanted, '--not', '--all']);
    return true;
  } catch {
    return false;
  }
}

async function fetch(batch: string[]) {
  const wanted = [...new Set(batch.map(line => line.split(' ')[1]))];
  const have = await presentObjects(wanted);
  if (wanted.every(oid => have.has(oid)) && (await complete(wanted))) return;
  const c = await conn();
  const sp = await requireProject(c);
  const from = readState(sp.id);
  await download(c, sp.id, from, sp.objectPos);
  if (!(await complete(wanted))) {
    if (from === 0n) fail(`project "${fullName}" is missing objects needed by its refs`);
    progress('local copy is behind its fetch record, downloading the full project');
    await download(c, sp.id, 0n, sp.objectPos);
    if (!(await complete(wanted))) fail(`project "${fullName}" is missing objects needed by its refs`);
  }
  writeState(sp.id, sp.objectPos);
}

// ---------------------------------------------------------------- push

async function upload(c: Conn, oids: string[]) {
  let batch: RawObject[] = [];
  let batchBytes = 0;
  let sent = 0;
  let sentBytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await c.reducers.putObjects({ project: fullName, objects: batch });
    sent += batch.length;
    sentBytes += batchBytes;
    batch = [];
    batchBytes = 0;
  };

  for await (const obj of readObjects(oids)) {
    if (obj.data.length > CHUNK_SIZE) {
      const chunks = Math.ceil(obj.data.length / CHUNK_SIZE);
      for (let idx = 0; idx < chunks; idx++) {
        const data = obj.data.subarray(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
        await c.reducers.putChunk({ project: fullName, oid: obj.oid, idx, data });
      }
      await c.reducers.finishObject({
        project: fullName,
        oid: obj.oid,
        kind: obj.kind,
        size: BigInt(obj.data.length),
        chunks,
      });
      sent += 1;
      sentBytes += obj.data.length;
      continue;
    }
    batch.push({ oid: obj.oid, kind: obj.kind, data: new Uint8Array(obj.data) });
    batchBytes += obj.data.length;
    if (batchBytes >= BATCH_BYTES || batch.length >= BATCH_OBJECTS) await flush();
  }
  await flush();
  if (sent > 0) progress(`sent ${sent} objects (${mb(sentBytes)})`);
}

interface PushSpec {
  src: string;
  dst: string;
  force: boolean;
  oid: string;
}

async function push(batch: string[]): Promise<string> {
  // git always sends `list for-push` first, so remoteRefs is current.
  const c = await conn();
  const specs: PushSpec[] = [];
  for (const line of batch) {
    let spec = line.slice('push '.length);
    const force = spec.startsWith('+');
    if (force) spec = spec.slice(1);
    const [src, dst] = spec.split(':');
    const oid = src ? (await git(['rev-parse', '--verify', src])).trim() : '';
    specs.push({ src, dst, force, oid });
  }

  const results = new Map<string, string>();
  const tips = specs.filter(s => s.oid).map(s => s.oid);
  try {
    const known = [...new Set(remoteRefs.values())];
    const local = await presentObjects(known);
    const oids = await objectsToSend(tips, known.filter(oid => local.has(oid)));
    if (oids.length > 0) progress(`uploading ${oids.length} objects to ${fullName}`);
    await upload(c, oids);
  } catch (err) {
    const why = errorMessage(err).replace(/\n/g, ' ');
    return specs.map(s => `error ${s.dst} ${why}`).join('\n') + '\n\n';
  }

  // The first branch to land in an empty project becomes its default, so let
  // the branch checked out here (or main/master) land first.
  if (remoteRefs.size === 0) {
    const head = (await git(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
    const rank = (dst: string) => [head, 'refs/heads/main', 'refs/heads/master'].indexOf(dst) >>> 0;
    specs.sort((a, b) => rank(a.dst) - rank(b.dst));
  }

  for (const s of specs) {
    // A plain force push overwrites whatever is there ("*"); a lease pins the
    // expected value; otherwise the ref must still hold what we listed.
    const lease = leases.get(s.dst);
    const oldOid = lease !== undefined ? lease : s.force ? '*' : remoteRefs.get(s.dst) ?? '';
    try {
      await c.reducers.updateRef({ project: fullName, name: s.dst, oldOid, newOid: s.oid, force: s.force });
      results.set(s.dst, `ok ${s.dst}`);
    } catch (err) {
      results.set(s.dst, `error ${s.dst} ${errorMessage(err).replace(/\n/g, ' ')}`);
    }
  }
  return specs.map(s => results.get(s.dst)).join('\n') + '\n\n';
}

// ---------------------------------------------------------------- protocol

function option(line: string): string {
  const [, name, ...rest] = line.split(' ');
  const value = rest.join(' ');
  switch (name) {
    case 'verbosity':
      verbosity = Number(value);
      return 'ok';
    case 'progress':
    case 'followtags':
      return 'ok';
    case 'cas': {
      const i = value.indexOf(':');
      if (i < 0) return 'unsupported';
      // git says "must not exist yet" with an all-zero id; the hub says "".
      const expect = value.slice(i + 1);
      leases.set(value.slice(0, i), /^0{40}$/.test(expect) ? '' : expect);
      return 'ok';
    }
    default:
      return 'unsupported';
  }
}

async function main() {
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = input[Symbol.asyncIterator]();
  const next = async () => {
    const r = await lines.next();
    return r.done ? null : r.value;
  };
  const out = (text: string) => new Promise<void>(resolve => process.stdout.write(text, () => resolve()));
  const readBatch = async (first: string) => {
    const batch = [first];
    for (let l = await next(); l; l = await next()) batch.push(l);
    return batch;
  };

  for (let line = await next(); line; line = await next()) {
    if (line === 'capabilities') {
      await out('fetch\npush\noption\n\n');
    } else if (line.startsWith('option ')) {
      await out(option(line) + '\n');
    } else if (line === 'list' || line === 'list for-push') {
      await out(await list());
    } else if (line.startsWith('fetch ')) {
      await fetch(await readBatch(line));
      await out('\n');
    } else if (line.startsWith('push ')) {
      await out(await push(await readBatch(line)));
    } else {
      fail(`unsupported command "${line}"`);
    }
  }
  if (session) (await session).disconnect();
  process.exit(0);
}

main().catch(err => fail(errorMessage(err)));
