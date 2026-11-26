// Every route of the hub's one public port, as the code has them, and the
// requests the members-only leak test (scripts/routeprobe.ts, run by
// scripts/leak-test.sh) sends to cover each. The inventory is read from the
// code itself:
//   - the Caddyfile's handle blocks (docker/server.Caddyfile);
//   - every "/-/..." or "/gh/..." path the web service's code names (the files
//     web.ts imports, as string literals and route regexes);
//   - the module's own pages (module/src/ui.ts: the views of a project and
//     the hub's pages).
// A route the inventory finds that LIST does not name fails the test (and
// cli npm test), so a new route cannot ship without its leak check.
import fs from 'node:fs';
import path from 'node:path';

export interface Probe {
  /** The request path and query, as sent (not normalised). */
  path: string;
  method?: 'GET' | 'POST';
  /** A JSON body (POST); an empty form otherwise. */
  json?: unknown;
  /** Sent as an API call (Accept: application/json) rather than a page. */
  api?: boolean;
  /** Open to anyone on a members-only hub (frontdoor.ts ROUTES, or the database's client endpoints). */
  open?: boolean;
  /** Members-only off: an anonymous browser gets the hub's data here today (proves the probe means something). */
  shows?: boolean;
  /** A Server-Sent Events stream: read for a moment, then hang up. */
  stream?: boolean;
}

// The project the leak test makes (private in the private run), and one of its commits (filled in by the test).
const P = '/alice/leakproj';

/** Inventory key → the requests that cover it. */
export const LIST: Record<string, Probe[]> = {
  // Caddy
  // The database's own two endpoints go straight to SpacetimeDB, which answers
  // a plain HTTP request there with nothing at all; the leak test's first
  // half covers them with the real protocol (scripts/leakprobe.ts).
  'caddy handle @client': [],
  'caddy handle /healthz': [{ path: '/healthz', open: true }],
  'caddy handle @hubpages': [{ path: '/-/guide' }, { path: '/-/builders', shows: true }, { path: '/-/builders/alice' }],
  'caddy handle /-/*': [{ path: '/-/' }, { path: '/-/no-such-route' }],
  'caddy handle /gh/*': [{ path: '/gh/octocat/hello-world' }],
  'caddy handle @app': [{ path: '/' }, { path: '/alice' }, { path: P }, { path: `${P}/` }],
  'caddy handle *': [
    { path: '/?view=code', shows: true },
    { path: '/alice?view=code', shows: true },
    { path: `${P}?view=code`, shows: true },
    { path: '/v1/database/spacehub-leak/sql', method: 'POST' },
    { path: '/v1/database/spacehub-leak/route/api' },
    // Path tricks: a sign-in path that is not one.
    { path: `/-/login/../..${P}/raw/main/a.txt` },
    { path: `/-/app/../..${P}/raw/main/a.txt` },
    { path: `/-/login%2F..${P}` },
  ],
  // The module's pages (ui.ts)
  'module tree': [{ path: `${P}/tree/main`, shows: true }],
  'module blob': [{ path: `${P}/blob/main/a.txt`, shows: true }],
  'module raw': [{ path: `${P}/raw/main/a.txt`, shows: true }],
  'module commits': [{ path: `${P}/commits/main`, shows: true }],
  'module commit': [{ path: `${P}/commit/{commit}`, shows: true }],
  'module refs': [{ path: `${P}/refs`, shows: true }],
  'module branches': [{ path: `${P}/branches`, shows: true }],
  'module tags': [{ path: `${P}/tags`, shows: true }],
  'module activity': [{ path: `${P}/activity`, shows: true }],
  'module guide': [{ path: '/guide' }],
  'module builders': [{ path: '/builders' }],
  // The web service
  "web '/-/'": [{ path: '/-/' }],
  "web '/-/login'": [{ path: '/-/login', open: true }, { path: '/-/login?next=/x', open: true }],
  "web '/-/login/github'": [{ path: '/-/login/github', open: true }],
  "web '/-/login/github/callback'": [{ path: '/-/login/github/callback?code=x&state=y', open: true }],
  "web '/-/login/xo'": [{ path: '/-/login/xo', open: true }],
  "web '/-/login/xo/callback'": [{ path: '/-/login/xo/callback?code=x&state=y', open: true }],
  "web '/-/signup'": [{ path: '/-/signup', open: true }, { path: '/-/signup?invite=abcdefgh', open: true }, { path: '/-/signup', method: 'POST', open: true }],
  "web '/-/logout'": [{ path: '/-/logout', method: 'POST', open: true }],
  "web '/-/app/'": [{ path: '/-/app/shell.css', open: true }, { path: '/-/app/theme.js', open: true }],
  "web '/-/app/app.css'": [{ path: '/-/app/app.css', open: true }],
  "web '/-/app/app.js'": [{ path: '/-/app/app.js', open: true }],
  "web '/-/app/theme.js'": [{ path: '/-/app/theme.js', open: true }],
  "web '/-/app/quirq-icon.svg'": [{ path: '/-/app/quirq-icon.svg', open: true }],
  "web '/-/api/auth/github'": [{ path: '/-/api/auth/github', method: 'POST', json: {}, api: true, open: true }],
  "web '/-/api/auth/github/device'": [{ path: '/-/api/auth/github/device', method: 'POST', json: {}, api: true, open: true }],
  "web '/-/api/auth/github/device/poll'": [{ path: '/-/api/auth/github/device/poll', method: 'POST', json: {}, api: true, open: true }],
  "web '/-/api/xo/v1/'": [{ path: '/-/api/xo/v1/records/someone', api: true, open: true }],
  "web '/-/api/instance-recovery'": [{ path: '/-/api/instance-recovery/status', api: true, open: true }, { path: '/-/api/instance-recovery/source/snapshots', api: true, open: true }],
  "web '/-/new'": [{ path: '/-/new' }, { path: '/-/new', method: 'POST' }],
  "web regex ^\\/-\\/sync\\/([^/]+)\\/([^/]+)$": [{ path: `/-/sync${P}`, method: 'POST' }],
  "web regex ^\\/-\\/link\\/([^/]+)$": [{ path: '/-/link/alice', method: 'POST' }],
  "web '/-/live'": [{ path: `/-/live?path=${encodeURIComponent(P)}`, stream: true, shows: true }],
  "web '/-/live.js'": [{ path: '/-/live.js' }],
  "web regex ^\\/-\\/avatar\\/([^/]+)$": [{ path: '/-/avatar/alice' }],
  "web '/-/api/view'": [
    { path: '/-/api/view', api: true, shows: true },
    { path: '/-/api/view?space=alice', api: true, shows: true },
    { path: '/-/api/view?space=alice&project=leakproj', api: true, shows: true },
    { path: '/-/api/view?space=alice&project=leakproj&view=tree&ref=main', api: true },
    { path: '/-/api/view?space=alice&project=leakproj&activity=1', api: true },
    { path: '/-/api/view?activity=1', api: true, shows: true },
  ],
  // The module's pages through the web service (modulepage.ts); asked directly, the proxy drops X-Spacehub-Uri and it is the home page.
  "web '/-/ui'": [{ path: '/-/ui' }],
  "web '/-/api/me'": [{ path: '/-/api/me', api: true }],
  "web '/-/api/chat'": [{ path: '/-/api/chat', method: 'POST', json: {}, api: true }],
  "web '/-/api/space-picture'": [{ path: '/-/api/space-picture', method: 'POST', json: {}, api: true }],
  "web '/-/api/start-chat'": [{ path: '/-/api/start-chat', method: 'POST', json: {}, api: true }],
  "web '/-/api/project-visibility'": [{ path: '/-/api/project-visibility', method: 'POST', json: {}, api: true }],
  "web '/-/api/project-member'": [{ path: '/-/api/project-member', method: 'POST', json: {}, api: true }],
  "web '/-/api/ask'": [{ path: '/-/api/ask', method: 'POST', json: {}, api: true }],
  "web '/-/api/explain'": [{ path: '/-/api/explain', method: 'POST', json: {}, api: true }],
  "web regex ^\\/(?:-\\/)?gh\\/([^/]+)\\/([^/]+?)\\/?$": [{ path: '/-/gh/octocat/hello-world' }, { path: '/gh/octocat/hello-world' }],
  "web '/-/api/hub'": [{ path: '/-/api/hub', api: true }],
  "web '/-/api/runners'": [{ path: '/-/api/runners', api: true }],
  "web '/-/api/workers'": [{ path: '/-/api/workers?space=alice&project=leakproj', api: true }, { path: '/-/api/workers?mine=1', api: true }],
  "web '/-/runners/connect/callback'": [{ path: '/-/runners/connect/callback?code=x&state=y' }],
  "web '/-/runners/agents-hub/start'": [{ path: '/-/runners/agents-hub/start' }],
  "web '/-/runners/agents-hub/cancel'": [{ path: '/-/runners/agents-hub/cancel' }],
  "web '/-/runners/agents-hub/wait'": [{ path: '/-/runners/agents-hub/wait' }],
  "web '/-/runners/agents-hub/check'": [{ path: '/-/runners/agents-hub/check', method: 'POST', json: {}, api: true }],
  // Asked directly (Caddy drops a client's X-Forwarded-Uri), it answers for "/".
  "web '/-/auth/check'": [{ path: '/-/auth/check' }],
};

const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** The cli/src files web.ts runs, following its relative imports. */
function webFiles(root: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !fs.existsSync(path.join(root, file))) return;
    seen.add(file);
    for (const m of read(root, file).matchAll(/from '\.\/([\w]+)(?:\.ts)?'/g)) visit(`cli/src/${m[1]}.ts`);
  };
  visit('cli/src/web.ts');
  return [...seen].sort();
}

/** Every route the code has, each with where it was found. */
export function inventory(root: string): { key: string; where: string }[] {
  const found = new Map<string, string>();
  const add = (key: string, where: string) => {
    if (!found.has(key)) found.set(key, where);
  };
  const caddy = 'docker/server.Caddyfile';
  for (const m of read(root, caddy).matchAll(/^\thandle(?: (\S+))? \{$/gm)) add(`caddy handle ${m[1] ?? '*'}`, caddy);
  for (const file of webFiles(root)) {
    const text = read(root, file);
    for (const m of text.matchAll(/(['"`])(\/(?:-|gh)\/[^'"`]*)\1/g)) add(`web '${m[2].split(/[?#]|\$\{/)[0]}'`, file);
    // frontdoor.ts's regexes only sort the routes into open and members-only.
    if (file === 'cli/src/frontdoor.ts') continue;
    for (const m of text.matchAll(/\/\^((?:\\.|\[[^\]\n]*\]|[^/\n\\[])*)\/[a-z]*/g)) {
      if (/^\\\/(?:-\\\/|\(\?:-\\\/\)\?gh|gh\\\/)/.test(m[1])) add(`web regex ^${m[1]}`, file);
    }
  }
  const ui = read(root, 'module/src/ui.ts');
  const route = /\n {2}route\(segs: string\[\]\): UiResponse \{([\s\S]*?)\n {2}\}\n/.exec(ui)?.[1] ?? '';
  const hub = /\n {2}hubPage\(segs: string\[\]\)[^{]*\{([\s\S]*?)\n {2}\}\n/.exec(ui)?.[1] ?? '';
  if (!route || !hub) throw new Error('module/src/ui.ts: route() or hubPage() not found; update scripts/routes.ts');
  for (const m of route.matchAll(/case '([\w-]+)':/g)) add(`module ${m[1]}`, 'module/src/ui.ts route()');
  for (const m of hub.matchAll(/segs\[0\] === '([\w-]+)'/g)) add(`module ${m[1]}`, 'module/src/ui.ts hubPage()');
  return [...found].map(([key, where]) => ({ key, where }));
}

/** Routes in the code that LIST does not cover, and LIST entries no longer in the code. */
export function unlisted(root: string): { missing: { key: string; where: string }[]; stale: string[] } {
  const inv = inventory(root);
  const keys = new Set(inv.map(r => r.key));
  return { missing: inv.filter(r => !(r.key in LIST)), stale: Object.keys(LIST).filter(k => !keys.has(k)) };
}
