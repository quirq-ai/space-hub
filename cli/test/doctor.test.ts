// spacehub doctor's checks, the PATH lines install-cli.sh prints, and the
// help added under a permission refusal (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountCheck, binDir, findOnPath, hubCheck, pathCheck, pathFix, report, restartCheck, shellRc } from '../src/doctor.ts';
import { permissionHelp, spacesNamed } from '../src/permission.ts';

const root = path.join(import.meta.dirname, '../..');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spacehub-doctor-'));
}

function executable(file: string, body = '#!/bin/sh\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

test('the bin folder is the link npm made, or npm\'s bin for a global install', () => {
  const pkg = '/home/u/.local/lib/node_modules/spacehub';
  assert.equal(binDir(pkg, '/home/u/.local/bin/spacehub', 'linux'), '/home/u/.local/bin');
  assert.equal(binDir(pkg, `${pkg}/bin/spacehub`, 'linux'), '/home/u/.local/bin');
  assert.equal(binDir('/src/space-hub/cli', '/src/space-hub/cli/bin/spacehub', 'linux'), '/src/space-hub/cli/bin');
  assert.equal(binDir('C:/npm/node_modules/spacehub', 'C:/npm/node_modules/spacehub/bin/spacehub', 'win32'), 'C:/npm');
});

test('PATH lookup finds executables in order and skips the rest', () => {
  const dir = tmp();
  executable(path.join(dir, 'a/spacehub'));
  executable(path.join(dir, 'b/spacehub'));
  fs.writeFileSync(path.join(dir, 'c-spacehub'), '', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c/spacehub'), '', { mode: 0o644 });
  const PATH = ['', path.join(dir, 'c'), path.join(dir, 'a'), path.join(dir, 'missing'), path.join(dir, 'b')].join(path.delimiter);
  assert.deepEqual(findOnPath('spacehub', PATH, 'linux'), [path.join(dir, 'a/spacehub'), path.join(dir, 'b/spacehub')]);
});

test('the PATH fix is the exact line, for the user\'s shell', () => {
  assert.equal(shellRc('/bin/zsh'), '~/.zshrc');
  assert.equal(shellRc('/usr/bin/bash'), '~/.bashrc');
  assert.equal(shellRc(undefined), '~/.profile');
  assert.deepEqual(pathFix('/home/u/.local/bin', '/bin/bash'), [
    `echo 'export PATH="/home/u/.local/bin:$PATH"' >> ~/.bashrc`,
    'export PATH="/home/u/.local/bin:$PATH"',
  ]);
  assert.deepEqual(pathFix('/home/u/.local/bin', '/usr/bin/fish'), ['fish_add_path /home/u/.local/bin']);
});

test('the PATH check passes, fails with the line to add, or names the spacehub that shadows this one', () => {
  const dir = tmp();
  const bin = path.join(dir, 'mine');
  executable(path.join(bin, 'spacehub'));
  executable(path.join(dir, 'other/spacehub'));
  assert.equal(pathCheck(bin, [path.join(bin, 'spacehub')], '/bin/bash').level, 'ok');
  const missing = pathCheck(bin, [], '/bin/bash');
  assert.equal(missing.level, 'fail');
  assert.match(missing.text, /is not on PATH/);
  assert.ok(missing.fix?.includes(`export PATH="${bin}:$PATH"`));
  const shadowed = pathCheck(bin, [path.join(dir, 'other/spacehub'), path.join(bin, 'spacehub')], '/bin/zsh');
  assert.equal(shadowed.level, 'warn');
  assert.ok(shadowed.text.includes(path.join(dir, 'other/spacehub')));
});

test('an install under home survives restarts; outside it is a warning; a temp folder fails', () => {
  assert.equal(restartCheck('/home/u/.local/lib/node_modules/spacehub', '/home/u', '/tmp').level, 'ok');
  const opt = restartCheck('/opt/nvm/versions/node/v22/lib/node_modules/spacehub', '/home/u', '/tmp');
  assert.equal(opt.level, 'warn');
  assert.ok(opt.text.includes('/opt/nvm/versions/node/v22/lib/node_modules/spacehub'));
  assert.match(opt.fix?.[0] ?? '', /install-cli\.sh" --prefix ~\/\.local$/);
  assert.equal(restartCheck('/tmp/x/lib/node_modules/spacehub', '/home/u', '/tmp').level, 'fail');
  assert.equal(restartCheck('/home/u-other/spacehub', '/home/u', '/tmp').level, 'warn');
});

test('the hub check shows both protocols, or why it failed', () => {
  assert.equal(hubCheck('wss://h', 1, { current: 1, oldest: 1 }, null).text, 'wss://h serves protocol 1; this CLI speaks 1');
  assert.equal(hubCheck('wss://h', 2, { current: 3, oldest: 2 }, null).text, 'wss://h serves protocol 2 to 3; this CLI speaks 2');
  assert.equal(hubCheck('wss://h', 1, null, 'cannot connect').level, 'fail');
  assert.equal(hubCheck('wss://h', 1, null, null).level, 'ok');
});

test('the account check names the builder and its roles', () => {
  assert.deepEqual(accountCheck('wss://h', false, null).fix, ['spacehub auth login']);
  assert.equal(accountCheck('wss://h', true, null).level, 'warn');
  assert.equal(accountCheck('wss://h', true, { builder: null, owner: [], member: [] }).level, 'fail');
  assert.equal(
    accountCheck('wss://h', true, { builder: 'quirq-gates', owner: ['quirq-gates'], member: ['quirq'] }).text,
    'signed in as quirq-gates: owner of quirq-gates; member of quirq'
  );
});

test('the report lines up the checks and their fixes, and sums up', () => {
  const text = report([
    { name: 'CLI', level: 'ok', text: 'spacehub 0.4.0' },
    { name: 'PATH', level: 'fail', text: 'not on PATH', fix: ['export PATH="/b:$PATH"'] },
  ]);
  assert.equal(text, 'ok    CLI   spacehub 0.4.0\nFAIL  PATH  not on PATH\n            export PATH="/b:$PATH"\n\n1 problem to fix');
  assert.ok(report([{ name: 'CLI', level: 'ok', text: '' }]).endsWith('all good'));
  assert.ok(report([{ name: 'CLI', level: 'warn', text: '' }]).endsWith('works, with a warning to look at'));
});

test('a permission refusal names its spaces; other errors name none', () => {
  assert.deepEqual(spacesNamed('permission denied: only owners of "quirq" can do this'), ['quirq']);
  assert.deepEqual(spacesNamed('permission denied: only owners of "quirq" can change "quirq/site"'), ['quirq']);
  assert.deepEqual(spacesNamed('permission denied: only owners of "gates" or "quirq" disconnect them'), ['gates', 'quirq']);
  assert.deepEqual(spacesNamed('no space "quirq"'), []);
});

test('the help under a refusal says who is signed in and who can do it', () => {
  assert.deepEqual(permissionHelp('quirq-gates', 'wss://hub.quirq.dev', [{ space: 'quirq', owners: ['sharmasuraj0123'] }]), [
    'you are signed in as quirq-gates on wss://hub.quirq.dev',
    'owners of quirq: sharmasuraj0123',
    'ask them to do it, or run it signed in as an owner',
  ]);
  assert.deepEqual(permissionHelp('x', 'wss://h', [{ space: 'a', owners: ['b', 'c'] }]).at(-1), 'ask one of them to do it, or run it signed in as an owner');
  assert.deepEqual(permissionHelp(null, 'wss://h', [{ space: 'gone', owners: [] }]), ['you are not signed in as a builder on wss://h (spacehub auth login)']);
});

// install-cli.sh against a stand-in npm that "installs" into the prefix.
function install(args: string[], env: { home: string; path?: string; shell?: string }) {
  const stub = tmp();
  const npmPrefix = path.join(env.home, 'npm-default');
  executable(
    path.join(stub, 'npm'),
    `#!/usr/bin/env bash
set -e
case "$1" in
  pack) echo spacehub-0.1.0.tgz ;;
  prefix) echo "${npmPrefix}" ;;
  install)
    prefix="${npmPrefix}"; global=""
    while [ $# -gt 0 ]; do
      case "$1" in --global) global=1 ;; --prefix) prefix="$2"; shift ;; --prefix=*) prefix="\${1#--prefix=}" ;; esac
      shift
    done
    if [ -n "$global" ]; then mkdir -p "$prefix/bin"; printf '#!/bin/sh\\n' > "$prefix/bin/spacehub"; chmod +x "$prefix/bin/spacehub"; fi ;;
esac
`
  );
  const PATH = [stub, ...(env.path ? [env.path] : []), '/usr/bin', '/bin'].join(path.delimiter);
  return execFileSync('bash', [path.join(root, 'scripts/install-cli.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH, HOME: env.home, SHELL: env.shell ?? '/bin/bash' },
  });
}

test('install-cli.sh prints the exact PATH line when the shell cannot find spacehub', () => {
  const home = tmp();
  const output = install(['--prefix', path.join(home, '.local')], { home });
  const bin = path.join(home, '.local/bin');
  assert.ok(output.includes(`Installed spacehub in ${bin}, which is not on your PATH yet.`), output);
  assert.ok(output.includes(`  echo 'export PATH="${bin}:$PATH"' >> ~/.bashrc\n  export PATH="${bin}:$PATH"\n`), output);
  assert.ok(!output.includes('outside your home folder'), output);
  assert.ok(output.includes('spacehub doctor'));
});

test('install-cli.sh just says where spacehub is when PATH already finds it', () => {
  const home = tmp();
  const bin = path.join(home, '.local/bin');
  const output = install([`--prefix=${path.join(home, '.local')}`], { home, path: bin, shell: '/bin/zsh' });
  assert.ok(output.includes(`Installed: ${bin}/spacehub`), output);
  assert.ok(!output.includes('export PATH'), output);
});

test('install-cli.sh uses npm\'s own prefix by default, and warns about one outside home', () => {
  const home = tmp();
  const own = install([], { home });
  assert.ok(own.includes(`Installed spacehub in ${path.join(home, 'npm-default/bin')},`), own);
  assert.ok(!own.includes('outside your home folder'), own);
  const elsewhere = tmp();
  const away = install(['--prefix', elsewhere], { home });
  assert.ok(away.includes(`Note: ${elsewhere}/bin is outside your home folder.`), away);
  assert.ok(away.includes('scripts/install-cli.sh --prefix ~/.local'));
});
