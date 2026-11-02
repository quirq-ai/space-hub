// Runner tokens are sealed with SPACEHUB_SECRET_KEY before they reach the database (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { open, seal, sealKey } from '../src/seal.ts';

const KEY = randomBytes(48).toString('base64');

test('a sealed token opens with the same key, and two seals of one value differ', () => {
  const key = sealKey({ SPACEHUB_SECRET_KEY: KEY })!;
  const a = seal(key, 'hub_secret_value_123');
  const b = seal(key, 'hub_secret_value_123');
  assert.notEqual(a, b);
  assert.equal(open(key, a), 'hub_secret_value_123');
  assert.ok(!a.includes('hub_secret_value_123'));
});

test('a tampered value or another key is refused', () => {
  const key = sealKey({ SPACEHUB_SECRET_KEY: KEY })!;
  const sealed = Buffer.from(seal(key, 'hub_secret'), 'base64');
  sealed[sealed.length - 20] ^= 1;
  assert.throws(() => open(key, sealed.toString('base64')), /connect it again/);
  const other = sealKey({ SPACEHUB_SECRET_KEY: randomBytes(32).toString('base64') })!;
  assert.throws(() => open(other, seal(key, 'hub_secret')), /connect it again/);
});

test('no key is off; a short key is refused', () => {
  assert.equal(sealKey({}), null);
  assert.equal(sealKey({ SPACEHUB_SECRET_KEY: '' }), null);
  assert.throws(() => sealKey({ SPACEHUB_SECRET_KEY: randomBytes(16).toString('base64') }), /at least 32 bytes/);
});
