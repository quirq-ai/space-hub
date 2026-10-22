// spacehub: the client for a spacehub server, shaped like gh. `auth` manages
// who you are on which server; `space` (alias `repo`) manages spaces. Moving
// code is plain git through git-remote-spacehub (spacehub://owner/name).
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { configFile, loadConfig, removeToken, saveSettings, saveToken } from './config';
import { connect, errorMessage, findSpace, findUser, listRefs, quietSdkLogs, snapshot, tables, type Conn } from './conn';
import { git } from './git';

quietSdkLogs();

const VERSION = '0.1.0';

const HELP = `spacehub: git hosting on SpacetimeDB

USAGE
  spacehub <command> <subcommand> [flags]

AUTH
  auth login      Log in to a server, creating your username on first login
                    [--server <url>] [--db <name>] [--username <name>] [--with-token]
  auth status     Show the server, username and identity in use
  auth token      Print the identity token (log in elsewhere with --with-token)
  auth logout     Forget the token for the current server  [--yes]

SPACES (alias: repo)
  space create <name>             Create <you>/<name>
                                    [-d <text>] [--source <dir> [--remote <name>] [--push]] [--clone]
  space list [<owner>]            List spaces
  space view [<space>]            Default branch, size and refs
  space clone <space> [<dir>]     git clone a space (extra flags after --)
  space edit [<space>]            [--description <text>] [--default-branch <name>]
  space delete <space> --yes      Delete a space and all its history
  space sync                      Fast-forward the current branch from its spacehub remote
                                    [--remote <name>] [--push] [--watch]
  space watch [<space>]           Stream ref changes live  [--exec <command>]

  <space> is owner/name, or just name for your own spaces. Inside a clone it
  defaults to the repository's spacehub remote.

GIT
  git clone spacehub://<owner>/<name>
  git remote add origin spacehub://<owner>/<name>
  git push | git fetch | git pull

ENVIRONMENT
  SPACEHUB_SERVER, SPACEHUB_DB, SPACEHUB_TOKEN, SPACEHUB_HOME override the saved settings.`;

class Usage extends Error {}

function out(text = '') {
  process.stdout.write(text + '\n');
}

function note(text: string) {
  process.stderr.write(text + '\n');
}

function die(message: string): never {
  throw new Usage(message);
}

// Pull `--name value` (or a boolean `--name`) out of args.
function takeFlag(args: string[], names: string[], boolean = false): string | true | undefined {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i < 0) continue;
    if (boolean) {
      args.splice(i, 1);
      return true;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${name} needs a value`);
    args.splice(i, 2);
    return value;
  }
  return undefined;
}

const opt = (args: string[], ...names: string[]) => takeFlag(args, names) as string | undefined;
const bool = (args: string[], ...names: string[]) => takeFlag(args, names, true) === true;

function when(ts: { microsSinceUnixEpoch: bigint }) {
  return new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString().replace('T', ' ').slice(0, 16);
}

function run(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

async function runOrDie(cmd: string, args: string[], cwd?: string) {
  const code = await run(cmd, args, cwd);
  if (code !== 0) die(`"${[cmd, ...args].join(' ')}" exited with ${code}`);
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- session

let session: { conn: Conn; identity: Parameters<typeof findUser>[1]; server: string; database: string } | null = null;

async function open() {
  session ??= await connect();
  return session;
}

async function username(): Promise<string> {
  const { conn, identity } = await open();
  const user = await findUser(conn, identity);
  if (!user) die('not logged in; run: spacehub auth login --username <name>');
  return user.username;
}

// ---------------------------------------------------------------- spaces in git

function parseSpaceUrl(url: string): string | null {
  const m = /^spacehub:(?:\/\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The spacehub remote of the repository in `cwd`: the one named `prefer`,
// else origin, else the first remote with a spacehub:// URL.
async function spaceRemote(prefer?: string, cwd?: string): Promise<{ remote: string; space: string } | null> {
  let names: string[];
  try {
    names = (await git(['-C', cwd ?? '.', 'remote'])).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (prefer && !names.includes(prefer)) die(`no remote named "${prefer}"`);
  const order = [...new Set([prefer, 'origin', ...names].filter((n): n is string => !!n && names.includes(n)))];
  for (const remote of order) {
    const url = (await git(['-C', cwd ?? '.', 'remote', 'get-url', remote]).catch(() => '')).trim();
    const space = parseSpaceUrl(url);
    if (space) return { remote, space };
    if (prefer && remote === prefer) die(`remote "${prefer}" is not a spacehub remote`);
  }
  return null;
}

async function resolveSpace(arg: string | undefined): Promise<string> {
  if (arg) {
    const name = arg.replace(/^spacehub:(\/\/)?/, '').replace(/\.git$/, '');
    if (name.includes('/')) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(name)) die(`"${arg}" is not owner/name`);
      return name;
    }
    return `${await username()}/${name}`;
  }
  const found = await spaceRemote();
  if (!found) die('no space given and this directory has no spacehub remote');
  return found.space;
}

async function requireSpace(fullName: string) {
  const { conn } = await open();
  return (await findSpace(conn, fullName)) ?? die(`space "${fullName}" not found`);
}

// Run `onChange` (serialized, coalesced) whenever a ref of the space changes.
async function followRefs(fullName: string, onChange: (refName: string, oid: string, sign: string) => void) {
  const { conn } = await open();
  const sp = await requireSpace(fullName);
  conn.db.gitRef.onInsert((ctx, r) => {
    if (r.spaceId === sp.id && ctx.event.tag !== 'SubscribeApplied') onChange(r.name, r.oid, '+');
  });
  conn.db.gitRef.onUpdate((_ctx, _old, r) => {
    if (r.spaceId === sp.id) onChange(r.name, r.oid, '~');
  });
  conn.db.gitRef.onDelete((ctx, r) => {
    if (r.spaceId === sp.id && ctx.event.tag !== 'UnsubscribeApplied') onChange(r.name, '', '-');
  });
  await new Promise<void>((resolve, reject) =>
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
      .subscribe(tables.gitRef.where(r => r.spaceId.eq(sp.id)))
  );
  return { conn, sp };
}

function serialized(task: () => Promise<unknown>) {
  let running = false;
  let again = false;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      note(`spacehub: ${errorMessage(err)}`);
    }
    running = false;
    if (again) {
      again = false;
      void tick();
    }
  };
  return tick;
}

// ---------------------------------------------------------------- auth

async function authLogin(args: string[]) {
  const server = opt(args, '--server', '--hostname');
  const database = opt(args, '--db');
  const wanted = opt(args, '--username', '-u')?.toLowerCase();
  const withToken = bool(args, '--with-token');
  if (server || database) saveSettings({ server, database });
  if (withToken) {
    let token = '';
    for await (const chunk of process.stdin) token += chunk;
    token = token.trim();
    if (!token) die('--with-token reads a token from stdin, and none arrived');
    saveToken(loadConfig().server, token);
  }
  const { conn, identity, server: at, database: db } = await open();
  let user = await findUser(conn, identity);
  if (user && wanted && wanted !== user.username) {
    die(`this identity is already ${user.username} on ${at}; log out first to use another username`);
  }
  if (!user) {
    let name = wanted;
    if (!name) {
      if (!process.stdin.isTTY) die('first login on this server needs --username <name>');
      name = (await ask('Choose a username: ')).toLowerCase();
    }
    if (!name) die('no username given');
    await conn.reducers.registerUser({ username: name });
    user = await findUser(conn, identity);
  }
  out(`Logged in to ${at} (database ${db}) as ${user?.username ?? wanted}`);
}

async function authStatus() {
  const cfg = loadConfig();
  out(`server    ${cfg.server}`);
  out(`database  ${cfg.database}`);
  if (!cfg.token) {
    out('account   not logged in (spacehub auth login --username <name>)');
    return;
  }
  const { conn, identity } = await open();
  const user = await findUser(conn, identity);
  out(`account   ${user ? user.username : 'identity has no username yet (spacehub auth login --username <name>)'}`);
  out(`identity  ${identity.toHexString()}`);
  out(`token     ${process.env.SPACEHUB_TOKEN ? 'from SPACEHUB_TOKEN' : `saved in ${configFile()}`}`);
}

function authToken() {
  out(loadConfig().token ?? die('not logged in'));
}

function authLogout(args: string[]) {
  const cfg = loadConfig();
  if (!cfg.token) die(`not logged in to ${cfg.server}`);
  if (!bool(args, '--yes', '-y')) {
    die(
      `the token is the only key to this account; back it up with "spacehub auth token" first,\n` +
        `then run "spacehub auth logout --yes"`
    );
  }
  removeToken(cfg.server);
  out(`Logged out of ${cfg.server}`);
}

// ---------------------------------------------------------------- space

async function spaceCreate(args: string[]) {
  const description = opt(args, '-d', '--description') ?? '';
  const source = opt(args, '--source', '-s');
  const remote = opt(args, '--remote', '-r') ?? 'origin';
  const pushAfter = bool(args, '--push');
  const cloneAfter = bool(args, '--clone', '-c');
  const name = (args[0] ?? die('usage: spacehub space create <name>')).replace(/\.git$/, '');
  if (name.includes('/')) die('create takes a bare name; spaces are created under your username');
  if (pushAfter && !source) die('--push needs --source <dir>');
  const owner = await username();
  const { conn } = await open();
  await conn.reducers.createSpace({ name, description });
  const fullName = `${owner}/${name}`;
  const url = `spacehub://${fullName}`;
  out(`Created space ${fullName}`);
  if (source) {
    await runOrDie('git', ['-C', source, 'remote', 'add', remote, url]);
    out(`Added remote ${remote} -> ${url}`);
    if (pushAfter) await runOrDie('git', ['-C', source, 'push', '-u', remote, 'HEAD']);
  } else if (cloneAfter) {
    await runOrDie('git', ['clone', url]);
  } else {
    out(`\n  git clone ${url}\n  # or, in an existing repository:\n  git remote add origin ${url} && git push -u origin HEAD`);
  }
}

async function spaceList(args: string[]) {
  const owner = args[0];
  const { conn } = await open();
  const query = owner ? tables.space.where(s => s.owner.eq(owner)) : tables.space;
  const spaces = await snapshot(conn, query, () => [...conn.db.space.iter()].filter(s => !owner || s.owner === owner));
  if (spaces.length === 0) {
    out(owner ? `no spaces for ${owner}` : 'no spaces yet');
    return;
  }
  const width = Math.max(...spaces.map(s => s.fullName.length));
  for (const s of spaces.sort((a, b) => Number(b.pushedAt.microsSinceUnixEpoch - a.pushedAt.microsSinceUnixEpoch))) {
    out(`${s.fullName.padEnd(width)}  ${when(s.pushedAt)}  ${s.description}`.trimEnd());
  }
}

async function spaceView(args: string[]) {
  const fullName = await resolveSpace(args[0]);
  const sp = await requireSpace(fullName);
  const { conn } = await open();
  const refs = await listRefs(conn, sp.id);
  out(sp.fullName);
  if (sp.description) out(sp.description);
  out();
  out(`url       spacehub://${sp.fullName}`);
  out(`default   ${sp.defaultBranch}`);
  out(`objects   ${sp.objectCount}`);
  out(`created   ${when(sp.createdAt)}`);
  out(`pushed    ${when(sp.pushedAt)}`);
  out();
  if (refs.length === 0) out('(empty: push something to it)');
  for (const r of refs) out(`${r.oid.slice(0, 12)}  ${r.name.replace(/^refs\/(heads|tags)\//, '$1/')}  ${when(r.updatedAt)}`);
}

async function spaceClone(args: string[]) {
  const dash = args.indexOf('--');
  const extra = dash >= 0 ? args.splice(dash).slice(1) : [];
  const fullName = await resolveSpace(args[0] ?? die('usage: spacehub space clone <space> [<dir>]'));
  const dir = args[1];
  await runOrDie('git', ['clone', ...extra, `spacehub://${fullName}`, ...(dir ? [dir] : [])]);
}

async function spaceEdit(args: string[]) {
  const description = opt(args, '--description', '-d');
  const defaultBranch = opt(args, '--default-branch');
  if (description === undefined && defaultBranch === undefined) {
    die('nothing to change; pass --description and/or --default-branch');
  }
  const fullName = await resolveSpace(args[0]);
  const { conn } = await open();
  await conn.reducers.editSpace({ space: fullName, description, defaultBranch });
  out(`Updated ${fullName}`);
}

async function spaceDelete(args: string[]) {
  const yes = bool(args, '--yes', '-y');
  const fullName = await resolveSpace(args[0] ?? die('usage: spacehub space delete <space> --yes'));
  if (!yes) die(`this deletes ${fullName} and all of its history; re-run with --yes`);
  const { conn } = await open();
  await conn.reducers.deleteSpace({ space: fullName });
  out(`Deleted ${fullName}`);
}

async function spaceSync(args: string[]) {
  const prefer = opt(args, '--remote', '-r');
  const pushToo = bool(args, '--push');
  const watch = bool(args, '--watch', '-w');
  const found = (await spaceRemote(prefer)) ?? die('this directory has no spacehub remote');
  const branch = (await git(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  if (!branch) die('not on a branch');
  const sync = async () => {
    await runOrDie('git', ['pull', '--ff-only', found.remote, branch]);
    if (pushToo) await runOrDie('git', ['push', found.remote, branch]);
  };
  await sync();
  if (!watch) return;
  const tick = serialized(sync);
  await followRefs(found.space, refName => {
    if (refName === `refs/heads/${branch}`) void tick();
  });
  note(`Watching ${found.space} ${branch}; syncing on every push (ctrl-c to stop)`);
  await new Promise(() => {});
}

async function spaceWatch(args: string[]) {
  const command = opt(args, '--exec');
  const fullName = await resolveSpace(args[0]);
  const tick = command ? serialized(() => run('sh', ['-c', command])) : null;
  const { conn, sp } = await followRefs(fullName, (refName, oid, sign) => {
    out(`${new Date().toISOString().slice(11, 19)}  ${sign} ${refName}${oid ? ` ${oid.slice(0, 12)}` : ''}`);
    if (tick) void tick();
  });
  out(`Watching ${fullName} (ctrl-c to stop)`);
  for (const r of conn.db.gitRef.iter()) if (r.spaceId === sp.id) out(`          ${r.name} ${r.oid.slice(0, 12)}`);
  await new Promise(() => {});
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const group = args.shift();
  const sub = args.shift();

  if (!group || group === 'help' || group === '--help' || group === '-h') return out(HELP);
  if (group === '--version' || group === 'version') return out(`spacehub ${VERSION}`);

  if (group === 'auth') {
    switch (sub) {
      case 'login': return authLogin(args);
      case 'status': return authStatus();
      case 'token': return authToken();
      case 'logout': return authLogout(args);
    }
    die(`usage: spacehub auth <login|status|token|logout>`);
  }

  if (group === 'space' || group === 'repo') {
    switch (sub) {
      case 'create': return spaceCreate(args);
      case 'list': case 'ls': return spaceList(args);
      case 'view': return spaceView(args);
      case 'clone': return spaceClone(args);
      case 'edit': return spaceEdit(args);
      case 'delete': return spaceDelete(args);
      case 'sync': return spaceSync(args);
      case 'watch': return spaceWatch(args);
    }
    die(`usage: spacehub space <create|list|view|clone|edit|delete|sync|watch>`);
  }

  die(`unknown command "${group}"; see spacehub help`);
}

main()
  .then(() => {
    session?.conn.disconnect();
    process.exit(0);
  })
  .catch(err => {
    note(`spacehub: ${err instanceof Usage ? err.message : errorMessage(err)}`);
    process.exit(1);
  });
