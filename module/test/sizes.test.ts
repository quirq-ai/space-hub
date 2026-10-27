// How much each project stores, run in SpacetimeDB's in-process module
// harness (no server needed): npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { Sha1, objectHeader } from '../src/sha1';
import { CHUNK_SIZE } from '../src/store';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

function object(kind: string, data: Uint8Array) {
  return { oid: new Sha1().update(objectHeader(kind, data.length)).update(data).hex(), kind, data };
}
const text = (s: string) => new TextEncoder().encode(s);

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice');
  call(alice, mod.registerUser, { username: 'alice' });
  call(alice, mod.createProject, { space: 'alice', name: 'notes', description: '' });
  const id = h.db.project.fullName.find('alice/notes')!.id;
  const bytes = () => h.db.projectSize.projectId.find(id)?.bytes;
  return { h, call, alice, bytes };
}

describe('project sizes', () => {
  it('start at zero and grow by the bytes of each new object', () => {
    const { call, alice, bytes } = hub();
    expect(bytes()).toBe(0n);
    const a = object('blob', text('hello\n'));
    const b = object('blob', text('a bit more text\n'));
    call(alice, mod.putObjects, { project: 'alice/notes', objects: [a, b] });
    expect(bytes()).toBe(BigInt(a.data.length + b.data.length));
    // Objects the project already has are not counted again.
    call(alice, mod.putObjects, { project: 'alice/notes', objects: [a, b] });
    expect(bytes()).toBe(BigInt(a.data.length + b.data.length));
  });

  it('count large objects, sent in chunks, once they are sealed', () => {
    const { call, alice, bytes } = hub();
    const data = new Uint8Array(CHUNK_SIZE + 10).fill(7);
    const big = object('blob', data);
    call(alice, mod.putChunk, { project: 'alice/notes', oid: big.oid, idx: 0, data: data.subarray(0, CHUNK_SIZE) });
    call(alice, mod.putChunk, { project: 'alice/notes', oid: big.oid, idx: 1, data: data.subarray(CHUNK_SIZE) });
    expect(bytes()).toBe(0n);
    call(alice, mod.finishObject, { project: 'alice/notes', oid: big.oid, kind: 'blob', size: BigInt(data.length), chunks: 2 });
    call(alice, mod.finishObject, { project: 'alice/notes', oid: big.oid, kind: 'blob', size: BigInt(data.length), chunks: 2 });
    expect(bytes()).toBe(BigInt(data.length));
  });
});
