// Avatars for the app: GET /-/avatar/<name> answers with an image for any
// builder, org or agent. A name backed by a GitHub account (a builder who
// signed up with GitHub, an org linked to one) gets its GitHub picture,
// fetched here so visitors' browsers never contact GitHub; everyone else gets
// initials on a color derived from the name. Answers are cached in memory.
import crypto from 'node:crypto';
import type http from 'node:http';

const NAME = /^[a-z0-9][a-z0-9-]{0,38}$/;
const MAX_BYTES = 512 * 1024;
const MAX_CACHED = 2000;
const PICTURE_TTL = 6 * 60 * 60 * 1000;
const INITIALS_TTL = 10 * 60 * 1000;

interface Cached {
  type: string;
  body: Buffer;
  expires: number;
}

export interface AvatarDeps {
  /** The module's answer for a name: its kind and GitHub login (module/src/workspace.ts avatarOf). */
  lookup: (name: string) => Promise<{ kind: string; githubLogin: string }>;
  /** Where GitHub pictures come from; tests point it at a stand-in. */
  githubBase?: string;
}

const cache = new Map<string, Cached>();

/** Two letters from a name, on one of eight calm hues picked by the name. */
export function initialsSvg(name: string, kind: string): string {
  const parts = name.split('-').filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  const hue = [212, 160, 262, 28, 340, 190, 98, 0][crypto.createHash('sha1').update(name).digest()[0] % 8];
  const radius = kind === 'org' || kind === 'agent' ? 22 : 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="${radius}" fill="hsl(${hue} 45% 88%)"/><text x="48" y="50" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="38" font-weight="600" fill="hsl(${hue} 40% 30%)">${letters.replace(/[<&]/g, '')}</text></svg>`;
}

async function picture(base: string, login: string): Promise<Cached | null> {
  try {
    const response = await fetch(`${base}/${encodeURIComponent(login)}.png?size=96`, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type.split(';')[0])) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length <= MAX_BYTES ? { type: type.split(';')[0], body, expires: Date.now() + PICTURE_TTL } : null;
  } catch {
    return null;
  }
}

async function avatar(deps: AvatarDeps, name: string): Promise<Cached> {
  const hit = cache.get(name);
  if (hit && hit.expires > Date.now()) return hit;
  let found: Cached | null = null;
  let kind = '';
  try {
    const info = await deps.lookup(name);
    kind = info.kind;
    if (info.githubLogin) found = await picture(deps.githubBase ?? 'https://github.com', info.githubLogin);
  } catch {
    /* Without the module, initials still show who it is. */
  }
  found ??= { type: 'image/svg+xml', body: Buffer.from(initialsSvg(name, kind)), expires: Date.now() + INITIALS_TTL };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(name, found);
  return found;
}

/** GET /-/avatar/<name>; false when the request is not one. */
export async function handleAvatar(deps: AvatarDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/-\/avatar\/([^/]+)$/.exec(url.pathname);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const name = decodeURIComponent(match[1]).toLowerCase();
  if (!NAME.test(name)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return true;
  }
  const found = await avatar(deps, name);
  res.writeHead(200, {
    'content-type': found.type,
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(found.body);
  return true;
}
