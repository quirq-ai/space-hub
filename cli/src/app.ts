// The hub's app: open-chat's interface over the whole hub. The proxy sends
// the hub's own pages here; the module still renders the code views
// (tree, blob, raw, commits, commit, refs, activity) and the guide.
//
//   GET  /, /<space>, /<space>/<project>   the app's page (its path within a project is in the #hash);
//                                          a visitor who is not signed in is sent from / to the
//                                          hub's front project (visitorHome)
//   GET  /-/app/<file>                     the app's script, styles and images (built from app/)
//   GET  /-/api/view?space=&project=&path= the hub, a space or a project as folders and files
//                                          (the module's /api, see module/src/workspace.ts)
//   GET  /-/api/me                         who is signed in
//   GET  /-/avatar/<name>                  a builder's, org's or agent's picture (avatar.ts)
//   POST /-/api/chat                       save chat turns as the signed-in builder (append_chat)
//   POST /-/api/space-picture              an org owner picks the GitHub organization whose picture
//                                          the org shows, or clears it (set_space_github)
//   POST /-/api/start-chat                 start an org's, an agent's or a project's chat (start_chat)
//   POST /-/api/project-visibility         an owner of the project's space makes it public or private
//                                          (set_project_visibility)
//   POST /-/api/project-member             an owner of the project's space adds or removes a collaborator,
//                                          or a collaborator leaves (add/remove_project_member)
//
// The browser never talks to SpacetimeDB: reads come from the module over
// HTTP, asked for as the verified viewer (modulepage.ts), so a private project
// is there only for those who may read it; a chat is saved with the session's
// own token, so the module's push rules decide who may write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Conn } from './conn';
import { findUser } from './conn';
import { forgetAvatar, handleAvatar } from './avatar';
import { visitorLanding } from './visitor';
import { asViewer, moduleUrl, type ModuleLink } from './modulepage';
import { projectMemberAction } from './projectmember';

export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; frame-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};
// Pages the proxy sends here: the hub, a space, a project.
const PAGE = /^\/(?:([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_.-]+))?)?\/?$/;
const MAX_BODY = 64 * 1024;

export interface AppDeps {
  dir: string;
  internalHttp: string;
  db: string;
  /** Run `fn` on a connection made with `token`, closed afterwards. */
  withConn: <T>(token: string, fn: (conn: Conn, identity: Parameters<typeof findUser>[1]) => Promise<T>) => Promise<T>;
  /** The signed-in builder, verified against the database (web.ts, viewer.ts); the only way this file learns who is asking. */
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
  /** Whether the request comes from a hub operator (SPACEHUB_RECOVERY_OPERATORS), who alone sees Sub-hubs and backups. */
  operator?: (req: http.IncomingMessage) => Promise<boolean>;
  /** The hub owner's builder name, or null (hubowner.ts); the owner alone sees Settings → Hub. */
  owner?: () => Promise<string | null>;
  /** The module, asked for data as a viewer (modulepage.ts). */
  module: ModuleLink;
  /** The verified builder's name, or null (frontdoor.ts builder, cached briefly). */
  viewerName: (req: http.IncomingMessage) => Promise<string | null>;
}

/** Where the built app lives: SPACEHUB_APP_DIR, else app/dist beside this checkout. */
export function appDir(): string {
  if (process.env.SPACEHUB_APP_DIR) return process.env.SPACEHUB_APP_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../app/dist');
}

let version: { dir: string; hash: string } | null = null;
function versionOf(dir: string) {
  if (version?.dir === dir) return version.hash;
  const hash = crypto.createHash('sha256');
  for (const name of ['app.js', 'app.css']) {
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      /* A missing build shows up as a failed script load, not a crash. */
    }
  }
  version = { dir, hash: hash.digest('hex').slice(0, 12) };
  return version.hash;
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function appPage(dir: string, title: string) {
  const v = versionOf(dir);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/-/app/quirq-icon.svg"><script src="/-/app/theme.js?v=${v}"></script><link rel="stylesheet" href="/-/app/app.css?v=${v}"></head><body><div id="root"></div><script type="module" src="/-/app/app.js?v=${v}"></script></body></html>`;
}

function json(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('This message is too long.');
  }
  return JSON.parse(body);
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The turns a browser may send; the module checks the rest. */
export function parseChat(input: unknown) {
  if (!object(input) || typeof input.space !== 'string' || typeof input.project !== 'string' || typeof input.conversation !== 'string' || !Array.isArray(input.turns)) return null;
  const turns = input.turns.map(turn => {
    if (!object(turn) || typeof turn.id !== 'string' || typeof turn.role !== 'string' || typeof turn.content !== 'string') return null;
    const links = turn.links === undefined ? [] : Array.isArray(turn.links) && turn.links.every(link => object(link) && typeof link.label === 'string' && typeof link.path === 'string') ? (turn.links as { label: string; path: string }[]).map(({ label, path }) => ({ label, path })) : null;
    return links ? { id: turn.id, role: turn.role, content: turn.content, links } : null;
  });
  if (turns.some(turn => !turn)) return null;
  return { project: `${input.space}/${input.project}`, conversation: input.conversation, turns: turns as { id: string; role: string; content: string; links: { label: string; path: string }[] }[] };
}

// Changes the app makes as the signed-in builder, each through one reducer,
// so the module's own checks decide who may.
const ACTIONS: Record<string, { what: string; usage: string; call: (input: Record<string, unknown>) => ((conn: Conn) => Promise<unknown>) | null; after?: (input: Record<string, unknown>) => void }> = {
  '/-/api/space-picture': {
    what: 'change the picture',
    usage: 'Send a space and a GitHub organization.',
    call: ({ space, login }) => (typeof space === 'string' && typeof login === 'string' ? conn => conn.reducers.setSpaceGithub({ space, login }) : null),
    after: ({ space }) => forgetAvatar(String(space)),
  },
  '/-/api/start-chat': {
    what: 'start a chat',
    usage: 'Send a space, and a project or "".',
    call: ({ space, project }) => (typeof space === 'string' && typeof project === 'string' ? conn => conn.reducers.startChat({ space, project }) : null),
  },
  // Only owners of the project's space may; the module refuses anyone else (setProjectVisibility).
  '/-/api/project-visibility': {
    what: 'change who can see the project',
    usage: 'Send a project (space/name) and a visibility, "public" or "private".',
    call: ({ project, visibility }) => (typeof project === 'string' && (visibility === 'public' || visibility === 'private')
      ? conn => conn.reducers.setProjectVisibility({ project, visibility })
      : null),
  },
  // Owners of the project's space add and remove collaborators, and a collaborator may leave; the module
  // refuses anyone else, and an agent only its own owners add (addProjectMember, removeProjectMember).
  '/-/api/project-member': projectMemberAction,
};

/** Handle the app's routes; false when the request is not one of them. */
export async function handleApp(deps: AppDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const lookup = async (name: string) => {
    const response = await fetch(`${deps.internalHttp}/v1/database/${encodeURIComponent(deps.db)}/route/api?avatar=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`avatar lookup failed: ${response.status}`);
    return (await response.json()) as { kind: string; githubLogin: string };
  };
  if (await handleAvatar({ lookup, githubBase: process.env.SPACEHUB_GITHUB_AVATARS }, req, res, url)) return true;

  if (req.method === 'GET' && route.startsWith('/-/app/')) {
    const name = route.slice('/-/app/'.length);
    const type = TYPES[path.extname(name)];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !type) return false;
    try {
      const body = fs.readFileSync(path.join(deps.dir, name));
      const cache = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
    return true;
  }

  if (req.method === 'GET' && route === '/-/api/view') {
    // As the verified viewer, never as a cookie says: a private project it may not read is not there.
    const upstream = await fetch(moduleUrl(deps.module, 'api', url.search), { headers: asViewer(deps.module, await deps.viewerName(req)) });
    const body = await upstream.text();
    const etag = upstream.headers.get('etag');
    const matches = etag && (req.headers['if-none-match'] ?? '').split(',').some(value => value.trim().replace(/^W\//, '') === etag);
    if (matches) {
      res.writeHead(304, { etag, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(etag ? { etag } : {}) });
    res.end(body);
    return true;
  }

  if (req.method === 'GET' && route === '/-/api/me') {
    const session = await deps.sessionOf(req);
    const owner = session && deps.owner ? (await deps.owner().catch(() => null)) === session.username : false;
    json(res, 200, { name: session?.username ?? null, operator: session && deps.operator ? await deps.operator(req) : false, ...(owner ? { owner: true } : {}) });
    return true;
  }

  if (route === '/-/api/chat') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Send chat messages with POST.' }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const session = await deps.sessionOf(req);
    if (!session) return json(res, 401, { error: 'Sign in to save chats.' }), true;
    let input: ReturnType<typeof parseChat>;
    try {
      input = parseChat(await readJson(req));
    } catch (error) {
      return json(res, 400, { error: error instanceof Error && error.message.includes('too long') ? error.message : 'Invalid chat message.' }), true;
    }
    if (!input) return json(res, 400, { error: 'Send a space, project, conversation and its new messages.' }), true;
    try {
      await deps.withConn(session.token, conn => conn.reducers.appendChat(input));
      return json(res, 200, { ok: true }), true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
      return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
    }
  }

  const action = ACTIONS[route];
  if (action) {
    if (req.method !== 'POST') return json(res, 405, { error: `Send it with POST to ${action.what}.` }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const session = await deps.sessionOf(req);
    if (!session) return json(res, 401, { error: `Sign in to ${action.what}.` }), true;
    let input: unknown;
    try {
      input = await readJson(req);
    } catch {
      input = null;
    }
    const call = object(input) ? action.call(input) : null;
    if (!call) return json(res, 400, { error: action.usage }), true;
    try {
      await deps.withConn(session.token, conn => call(conn));
      action.after?.(input as Record<string, unknown>);
      return json(res, 200, { ok: true }), true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
      return json(res, /permission denied/.test(message) ? 403 : 400, { error: message }), true;
    }
  }

  const page = req.method === 'GET' || req.method === 'HEAD' ? PAGE.exec(route) : null;
  if (page) {
    const [, space, project] = page;
    const landing = space ? null : await visitorLanding(deps, req);
    if (landing) {
      res.writeHead(302, { location: landing, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const title = space ? `${project ? `${space}/${project}` : space} · spacehub` : 'spacehub';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': APP_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    res.end(appPage(deps.dir, title));
    return true;
  }
  return false;
}
