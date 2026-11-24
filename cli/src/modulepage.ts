// The module's own pages (route/ui) and data (route/api), asked for on behalf
// of a verified viewer. The module has no caller identity over HTTP, so the
// web service is the only way to it with one: it checks the session
// (viewer.ts), then asks the module with
//
//   X-Spacehub-Viewer  the builder's name, or empty when signed out
//   X-Spacehub-Secret  this start's secret, which the module checks
//                      (module/src/reader.ts webViewer)
//
// The module then shows only the projects that builder may read (canRead,
// module/src/store.ts): a private project is a missing one. Without the right
// secret the module answers as for someone signed out. The proxy
// (docker/server.Caddyfile) sends every module page here (GET /-/ui, the
// original URI in X-Spacehub-Uri) and strips both headers from clients.
//
// The secret: the entrypoint makes one per container start
// (SPACEHUB_WEB_SECRET; without it this service makes its own), and this
// service sets it in the module as the hub admin (set_web_secret, hub_state
// "webSecret", a private table) before it serves. It never leaves the
// container.
import crypto from 'node:crypto';
import http from 'node:http';
import { call, type AdminHttp } from './admin.ts';

export const VIEWER_HEADER = 'x-spacehub-viewer';
export const SECRET_HEADER = 'x-spacehub-secret';

/** Where the module answers, and the secret that vouches for a viewer. */
export interface ModuleLink {
  /** SpacetimeDB's HTTP address. */
  http: string;
  db: string;
  /** This start's secret; null when it could not be set (every page is then for someone signed out). */
  secret: string | null;
}

/** SPACEHUB_WEB_SECRET, or a new random one. */
export function webSecret(env: NodeJS.ProcessEnv = process.env): string {
  const given = (env.SPACEHUB_WEB_SECRET ?? '').trim();
  if (given && !/^[A-Za-z0-9_-]{32,256}$/.test(given)) throw new Error('SPACEHUB_WEB_SECRET must be 32 to 256 letters, digits, "-" or "_"');
  return given || crypto.randomBytes(32).toString('hex');
}

/**
 * Set the secret in the module as the admin, retrying until the database
 * answers. Resolves once set; never rejects (a hub without an admin cannot,
 * and says so).
 */
export async function registerSecret(admin: AdminHttp | null, secret: string, opts: { tries?: number; waitMs?: number } = {}): Promise<boolean> {
  if (!admin) {
    process.stderr.write('spacehub-web: no SPACEHUB_ADMIN_TOKEN, so module pages show every viewer only public projects, signed out\n');
    return false;
  }
  const tries = opts.tries ?? 60;
  for (let i = 1; ; i++) {
    try {
      await call(admin, 'set_web_secret', [secret]);
      return true;
    } catch (err) {
      if (i >= tries) {
        process.stderr.write(`spacehub-web: could not set the web secret: ${err instanceof Error ? err.message : String(err)}\n`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, opts.waitMs ?? 1000));
    }
  }
}

/** The headers that tell the module who is asking. */
export function asViewer(link: ModuleLink, viewer: string | null): Record<string, string> {
  return link.secret ? { [SECRET_HEADER]: link.secret, [VIEWER_HEADER]: viewer ?? '' } : {};
}

export function moduleUrl(link: ModuleLink, route: 'ui' | 'api', search = ''): string {
  return `${link.http}/v1/database/${encodeURIComponent(link.db)}/route/${route}${search}`;
}

/**
 * Whether `viewer` may read the project "<space>/<project>": the module's own
 * rule (canRead), asked of the module. False when it cannot be asked.
 */
export async function canReadProject(link: ModuleLink, viewer: string | null, fullName: string): Promise<boolean> {
  try {
    const res = await fetch(moduleUrl(link, 'api', `?${new URLSearchParams({ readable: fullName })}`), { headers: asViewer(link, viewer), signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    return ((await res.json()) as { readable?: unknown }).readable === true;
  } catch {
    return false;
  }
}

// Answers passed back as the module sent them.
const PASSED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'location', 'cache-control',
  'content-security-policy', 'x-content-type-options', 'referrer-policy', 'content-disposition'];

/**
 * GET /-/ui: a module page for this viewer. `uri` is the page the browser
 * asked for (the proxy's X-Spacehub-Uri). Only GET and HEAD: the module's
 * pages are read only.
 */
export function proxyPage(link: ModuleLink, req: http.IncomingMessage, res: http.ServerResponse, uri: string, viewer: string | null): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed.\n');
    return Promise.resolve();
  }
  const headers: Record<string, string> = { 'x-spacehub-uri': uri.startsWith('/') ? uri : '/', host: req.headers.host ?? 'localhost', ...asViewer(link, viewer) };
  for (const name of ['x-forwarded-proto', 'range', 'if-none-match']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return new Promise(resolve => {
    const upstream = http.request(moduleUrl(link, 'ui'), { method: req.method, headers, timeout: 30_000 }, answer => {
      const out: Record<string, string | string[]> = {};
      for (const name of PASSED) {
        const value = answer.headers[name];
        if (value !== undefined) out[name] = value;
      }
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
      answer.on('end', resolve);
      answer.on('error', () => {
        res.destroy();
        resolve();
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('the page timed out')));
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('The hub could not render this page. Try again.\n');
      } else res.destroy();
      resolve();
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  });
}
