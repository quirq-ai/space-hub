// The CLI and hub protocol check (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDecodeError, protocolProblem, unreadableData, UPDATE_COMMAND } from '../src/compat.ts';
import { hubMismatch } from '../src/autosync.ts';
import { BINDINGS_HASH, OLDEST_PROTOCOL, PROTOCOL } from '../../module/src/protocol.ts';

const HUB = 'wss://hub.example';

test('a CLI the hub serves goes ahead', () => {
  assert.equal(protocolProblem(2, { current: 2, oldest: 2 }, HUB), null);
  assert.equal(protocolProblem(1, { current: 2, oldest: 1 }, HUB), null);
});

test('a hub too old to report its protocol gets the benefit of the doubt', () => {
  assert.equal(protocolProblem(1, null, HUB), null);
});

test('an out-of-date CLI is told how to update', () => {
  const problem = protocolProblem(1, { current: 3, oldest: 2 }, HUB) ?? '';
  assert.match(problem, /^this spacehub CLI is out of date for the hub at wss:\/\/hub\.example \(it speaks protocol 1; the hub needs 2\)/);
  assert.ok(problem.endsWith(`\n  ${UPDATE_COMMAND}`));
});

test('an older hub is named as the one to update', () => {
  const problem = protocolProblem(3, { current: 2, oldest: 1 }, HUB) ?? '';
  assert.match(problem, /^the hub at wss:\/\/hub\.example runs an older spacehub than this CLI \(the hub speaks protocol 2; this CLI 3\)/);
  assert.ok(!problem.includes(UPDATE_COMMAND));
});

test('rows the CLI cannot decode are recognized and explained', () => {
  assert.ok(isDecodeError(new RangeError('Tried to read 1970495853 byte(s) at relative offset 12, but only 421 byte(s) remain')));
  assert.ok(!isDecodeError(new RangeError('Invalid array length')));
  assert.ok(!isDecodeError(new Error('Tried to read 4 byte(s)')));
  assert.match(unreadableData(HUB), /^cannot read the hub's data at wss:\/\/hub\.example: .*\n  d="\$\(mktemp -d\)"/);
});

test('autosync recognizes either mismatch in the remote helper\'s output', () => {
  for (const problem of [protocolProblem(1, { current: 2, oldest: 2 }, HUB)!, protocolProblem(3, { current: 2, oldest: 1 }, HUB)!]) {
    assert.equal(hubMismatch(`fatal: quirq: ${problem}\n`), problem);
  }
  assert.equal(hubMismatch('fatal: quirq: permission denied: alice may not push\n'), null);
  assert.equal(hubMismatch(' ! [rejected]        main -> main (fetch first)\n'), null);
});

test('the update command reinstalls from a fresh checkout', () => {
  assert.equal(UPDATE_COMMAND, 'd="$(mktemp -d)" && git clone -q --depth 1 https://github.com/quirq-ai/space-hub "$d" && "$d/scripts/install-cli.sh"');
});

test('the protocol numbers are sane', () => {
  assert.ok(Number.isInteger(PROTOCOL) && PROTOCOL >= 1);
  assert.ok(Number.isInteger(OLDEST_PROTOCOL) && OLDEST_PROTOCOL >= 1 && OLDEST_PROTOCOL <= PROTOCOL);
});

// The generated bindings, minus their comments (the generator's version line).
function bindingsHash() {
  const dir = path.join(import.meta.dirname, '../src/module_bindings');
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    hash.update(`${file.split(path.sep).join('/')}\0${code}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}

test('every schema change decides whether to bump the protocol', () => {
  const hash = bindingsHash();
  assert.equal(
    hash,
    BINDINGS_HASH,
    `The client bindings changed. Decide whether CLIs built before this change still work with the hub (module/src/protocol.ts says when to bump PROTOCOL), then set BINDINGS_HASH there to '${hash}'.`
  );
});
