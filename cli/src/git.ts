// Thin wrappers over git plumbing: list objects to send, read raw objects,
// check which objects exist, and write fetched objects back as a packfile.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Readable } from 'node:stream';

export interface RawObject {
  oid: string;
  kind: string;
  data: Uint8Array;
}

export function git(args: string[], input?: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', d => out.push(d));
    child.stderr!.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
    if (child.stdin) {
      // git may exit without reading all of stdin; its exit code reports that.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Objects reachable from `tips` but not from `exclude`, as ids.
export async function objectsToSend(tips: string[], exclude: string[]): Promise<string[]> {
  if (tips.length === 0) return [];
  const input = [...tips, ...exclude.map(oid => `^${oid}`)].join('\n') + '\n';
  const out = await git(['rev-list', '--objects', '--stdin'], input);
  return out.split('\n').filter(Boolean).map(line => line.slice(0, 40));
}

// The subset of `oids` present in the local object store.
export async function presentObjects(oids: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  if (oids.length === 0) return present;
  const out = await git(['cat-file', '--batch-check'], oids.join('\n') + '\n');
  for (const line of out.split('\n')) {
    if (line && !line.endsWith(' missing')) present.add(line.slice(0, 40));
  }
  return present;
}

// Buffered reader over a byte stream that can hand out lines and exact-size
// bodies without re-copying the whole buffer for every object.
class StreamReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private iter: AsyncIterator<Buffer>;

  constructor(stream: Readable) {
    this.iter = stream[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    const r = await this.iter.next();
    if (r.done) return false;
    this.chunks.push(r.value);
    this.length += r.value.length;
    return true;
  }

  private consume(n: number) {
    this.length -= n;
    while (n > 0) {
      const first = this.chunks[0];
      if (first.length <= n) {
        n -= first.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(n);
        n = 0;
      }
    }
  }

  async line(): Promise<string | null> {
    for (;;) {
      if (this.chunks.length > 0) {
        const nl = this.chunks[0].indexOf(10);
        if (nl >= 0) {
          const text = this.chunks[0].toString('utf8', 0, nl);
          this.consume(nl + 1);
          return text;
        }
        if (this.chunks.length > 1) {
          this.chunks = [Buffer.concat(this.chunks)];
          continue;
        }
      }
      if (!(await this.pull())) return null;
    }
  }

  async read(n: number): Promise<Buffer> {
    while (this.length < n) {
      if (!(await this.pull())) throw new Error('unexpected end of git output');
    }
    if (this.chunks[0].length >= n) {
      const out = this.chunks[0].subarray(0, n);
      this.consume(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const first = this.chunks[0];
      const take = Math.min(first.length, n - at);
      first.copy(out, at, 0, take);
      at += take;
      this.consume(take);
    }
    return out;
  }
}

// Stream raw objects out of `git cat-file --batch`, in the order requested.
export async function* readObjects(oids: string[]): AsyncGenerator<RawObject> {
  if (oids.length === 0) return;
  const child = spawn('git', ['cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  child.stdin.on('error', () => {});
  child.stdin.end(oids.join('\n') + '\n');
  const reader = new StreamReader(child.stdout);
  try {
    for (let i = 0; i < oids.length; i++) {
      const header = await reader.line();
      if (header === null) throw new Error('git cat-file ended early');
      const [oid, kind, size] = header.split(' ');
      if (kind === 'missing') throw new Error(`object ${oid} is missing locally`);
      const data = await reader.read(Number(size));
      await reader.read(1);
      yield { oid, kind, data };
    }
  } finally {
    child.kill();
    await exited;
  }
}

const PACK_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function entryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let c = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(c | 0x80);
    c = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(c);
  return Buffer.from(bytes);
}

// Collects objects as packfile entries (full objects, no deltas) and hands
// the finished pack to git, which indexes it into the local object store.
export class PackWriter {
  private entries: Buffer[] = [];
  count = 0;
  bytes = 0;

  add(kind: string, data: Uint8Array) {
    const type = PACK_TYPES[kind];
    if (!type) throw new Error(`unknown object kind ${kind}`);
    this.entries.push(entryHeader(type, data.length), deflateSync(data, { level: 1 }));
    this.count += 1;
    this.bytes += data.length;
  }

  async store(): Promise<void> {
    if (this.count === 0) return;
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(this.count, 8);
    const hash = createHash('sha1').update(header);
    for (const e of this.entries) hash.update(e);
    const pack = Buffer.concat([header, ...this.entries, hash.digest()]);
    this.entries = [];
    // Small fetches become loose objects, like git's own fetch.unpackLimit.
    const args = this.count < 100 ? ['unpack-objects', '-q'] : ['index-pack', '--stdin'];
    await git(args, pack);
  }
}
