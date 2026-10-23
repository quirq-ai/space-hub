// Line diffs for the web UI: Myers' O(ND) algorithm plus unified hunks.

export const EQUAL = 0;
export const DELETE = 1;
export const INSERT = 2;

// [kind, index into a (or -1), index into b (or -1)]
export type Op = [number, number, number];

// The shortest edit script from a to b, or null when it needs more than
// maxD edits (the caller then shows "diff too large").
export function diffLines(a: string[], b: string[], maxD = 1000): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    // Keep only the diagonals this round can read: k in [-d-1, d+1].
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([EQUAL, x - 1, y - 1]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push([INSERT, -1, y - 1]);
      else ops.push([DELETE, x - 1, -1]);
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  ops: Op[];
}

// Group edits into unified-diff hunks with `context` unchanged lines around them.
export function toHunks(ops: Op[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  // a/b line positions before each op, for the @@ headers.
  const posA: number[] = [];
  const posB: number[] = [];
  let pa = 0;
  let pb = 0;
  for (const op of ops) {
    posA.push(pa);
    posB.push(pb);
    if (op[0] !== INSERT) pa++;
    if (op[0] !== DELETE) pb++;
  }
  let i = 0;
  while (i < ops.length) {
    let c = i;
    while (c < ops.length && ops[c][0] === EQUAL) c++;
    if (c >= ops.length) break;
    const start = Math.max(i, c - context);
    let end = c;
    let j = c;
    while (j < ops.length) {
      if (ops[j][0] !== EQUAL) {
        end = j;
        j++;
        continue;
      }
      let r = j;
      while (r < ops.length && ops[r][0] === EQUAL) r++;
      if (r < ops.length && r - j <= context * 2) {
        j = r;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const slice = ops.slice(start, stop);
    hunks.push({
      aStart: posA[start] + 1,
      aLen: slice.filter(o => o[0] !== INSERT).length,
      bStart: posB[start] + 1,
      bLen: slice.filter(o => o[0] !== DELETE).length,
      ops: slice,
    });
    i = stop;
  }
  return hunks;
}
