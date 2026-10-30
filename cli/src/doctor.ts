// spacehub doctor: is this machine set up? Where the CLI is installed, whether
// the shell finds it, whether the install survives a restart, whether it
// matches the hub, and who it is signed in as. Each check says what to run
// when it fails. The checks are pure (tested); cli.ts gathers the facts.
import fs from 'node:fs';
import path from 'node:path';

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: Level;
  text: string;
  fix?: string[]; // lines to run, or to read, to fix it
}

// The folder npm links `spacehub` into. Run through that link, it is the
// script's own folder; run from inside the package (a checkout's cli/bin, or
// node dist/cli.mjs), it is npm's bin folder for a global install
// (<prefix>/lib/node_modules/spacehub -> <prefix>/bin), else the package's bin.
export function binDir(packageDir: string, script: string, platform: string = process.platform): string {
  const scriptDir = path.dirname(path.resolve(script));
  if (!isInside(scriptDir, packageDir)) return scriptDir;
  const modules = path.dirname(packageDir);
  if (path.basename(modules) === 'node_modules') {
    const lib = path.dirname(modules);
    if (platform === 'win32') return lib; // <prefix>/node_modules on Windows
    if (path.basename(lib) === 'lib') return path.join(path.dirname(lib), 'bin');
  }
  return path.join(packageDir, 'bin');
}

export function isInside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Every executable called `name` on PATH, in the order the shell tries them.
export function findOnPath(name: string, pathEnv: string, platform: string = process.platform): string[] {
  const found: string[] = [];
  const exts = platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) found.push(file);
      } catch {
        continue;
      }
    }
  }
  return found;
}

function realpath(file: string) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// The startup file to add a PATH line to, for the user's shell.
export function shellRc(shell: string | undefined): string {
  const name = path.basename(shell ?? '');
  if (name === 'zsh') return '~/.zshrc';
  if (name === 'bash') return '~/.bashrc';
  if (name === 'fish') return '~/.config/fish/config.fish';
  return '~/.profile';
}

// The exact lines that put `dir` on PATH, now and in new shells.
export function pathFix(dir: string, shell: string | undefined): string[] {
  const rc = shellRc(shell);
  if (rc.endsWith('config.fish')) return [`fish_add_path ${dir}`];
  const line = `export PATH="${dir}:$PATH"`;
  return [`echo '${line}' >> ${rc}`, line];
}

// Does the shell find this spacehub? `found` is what PATH finds, first first.
export function pathCheck(bin: string, found: string[], shell: string | undefined): Check {
  const mine = path.join(bin, 'spacehub');
  const first = found[0];
  if (first && realpath(first) === realpath(mine)) return { name: 'PATH', level: 'ok', text: `${bin} is on PATH` };
  if (first) {
    return {
      name: 'PATH',
      level: 'warn',
      text: `your shell runs ${first}, not this install in ${bin}; put ${bin} first on PATH, or remove the other one`,
      fix: pathFix(bin, shell),
    };
  }
  return { name: 'PATH', level: 'fail', text: `${bin} is not on PATH, so your shell cannot find spacehub. Add it:`, fix: pathFix(bin, shell) };
}

// Whether the install is likely to outlive a restart. Cloud workspaces often
// keep only the home folder (a global npm under /opt/nvm or /usr/local is
// rebuilt), and temporary folders go on any machine.
export function restartCheck(packageDir: string, home: string, tmp: string): Check {
  const name = 'Restarts';
  for (const t of new Set([tmp, '/tmp', '/var/tmp'])) {
    if (isInside(packageDir, t)) {
      return { name, level: 'fail', text: `installed in a temporary folder (${packageDir}), which is cleared. Reinstall into your home folder:`, fix: [REINSTALL] };
    }
  }
  if (isInside(packageDir, home)) return { name, level: 'ok', text: 'installed in your home folder, which a restart keeps' };
  return {
    name,
    level: 'warn',
    text: `installed outside your home folder (${packageDir}). Fine on your own machine, but a workspace that resets on restart loses it; to keep it, reinstall into your home folder:`,
    fix: [REINSTALL],
  };
}

export const REINSTALL =
  'd="$(mktemp -d)" && git clone -q --depth 1 https://github.com/quirq-ai/space-hub "$d" && "$d/scripts/install-cli.sh" --prefix ~/.local';

// How the CLI and the hub get along. `hub` is the hub's protocol (null when
// it is too old to say); `problem` is the mismatch connecting reported, or why
// it could not connect.
export function hubCheck(server: string, mine: number, hub: { current: number; oldest: number } | null, problem: string | null): Check {
  if (problem) return { name: 'Hub', level: 'fail', text: problem };
  if (!hub) return { name: 'Hub', level: 'ok', text: `${server} answers (too old to report its protocol; this CLI speaks ${mine})` };
  const range = hub.oldest === hub.current ? `${hub.current}` : `${hub.oldest} to ${hub.current}`;
  return { name: 'Hub', level: 'ok', text: `${server} serves protocol ${range}; this CLI speaks ${mine}` };
}

export interface Account {
  builder: string | null; // null: the token is no builder yet
  owner: string[]; // spaces it owns (its personal space first)
  member: string[]; // spaces it is a member of
}

export function accountCheck(server: string, loggedIn: boolean, account: Account | null): Check {
  if (!loggedIn) return { name: 'Account', level: 'fail', text: `not logged in to ${server}`, fix: ['spacehub auth login'] };
  if (!account) return { name: 'Account', level: 'warn', text: 'not checked: the hub could not be reached' };
  if (!account.builder) return { name: 'Account', level: 'fail', text: `this identity has no builder on ${server} yet`, fix: ['spacehub auth login'] };
  const roles = [
    account.owner.length ? `owner of ${account.owner.join(', ')}` : '',
    account.member.length ? `member of ${account.member.join(', ')}` : '',
  ].filter(Boolean);
  return { name: 'Account', level: 'ok', text: `signed in as ${account.builder}${roles.length ? `: ${roles.join('; ')}` : ''}` };
}

const MARK: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export function report(checks: Check[]): string {
  const width = Math.max(...checks.map(c => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${MARK[c.level]}  ${c.name.padEnd(width)}  ${c.text}`);
    for (const f of c.fix ?? []) lines.push(`${' '.repeat(width + 8)}${f}`);
  }
  const failed = checks.filter(c => c.level === 'fail').length;
  const warned = checks.filter(c => c.level === 'warn').length;
  lines.push('');
  lines.push(failed ? `${failed} problem${failed > 1 ? 's' : ''} to fix` : warned ? `works, with ${warned > 1 ? 'warnings' : 'a warning'} to look at` : 'all good');
  return lines.join('\n');
}
