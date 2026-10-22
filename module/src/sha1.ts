// Streaming SHA-1, used to verify that every uploaded git object really has
// the id it claims. The module runtime has no crypto library, so this is a
// plain implementation of FIPS 180-1.

export class Sha1 {
  private h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  private w = new Uint32Array(80);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;

  update(data: Uint8Array): this {
    const n = data.length;
    let i = 0;
    this.total += n;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.block(data, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }

  hex(): string {
    const bits = this.total * 8;
    const pad = new Uint8Array(this.bufLen < 56 ? 64 - this.bufLen : 128 - this.bufLen);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const end = pad.length;
    pad[end - 8] = hi >>> 24; pad[end - 7] = hi >>> 16; pad[end - 6] = hi >>> 8; pad[end - 5] = hi;
    pad[end - 4] = lo >>> 24; pad[end - 3] = lo >>> 16; pad[end - 2] = lo >>> 8; pad[end - 1] = lo;
    const total = this.total;
    this.update(pad);
    this.total = total;
    let out = '';
    for (let i = 0; i < 5; i++) out += this.h[i].toString(16).padStart(8, '0');
    return out;
  }

  private block(b: Uint8Array, off: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      w[j] = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    }
    for (let j = 16; j < 80; j++) {
      const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    const h = this.h;
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4];
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
      else if (j < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = bb ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = ((bb << 30) | (bb >>> 2)) >>> 0;
      bb = a;
      a = tmp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + bb) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
}

// The git object header: "<kind> <size>\0".
export function objectHeader(kind: string, size: number): Uint8Array {
  const s = `${kind} ${size}`;
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
