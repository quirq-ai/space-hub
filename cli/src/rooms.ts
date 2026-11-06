// Repo rooms on the web (module/src/explain.ts): an open explainer and group
// chat for any public GitHub repository.
//
//   GET  /gh/<owner>/<repo>        open the repository's room (made on the first visit, once GitHub
//   GET  /-/gh/<owner>/<repo>      says the repository is public) and go to its group chat; anyone,
//                                  signed in or not, can open one
//   POST /-/api/explain            the same from the explain org's chat, which takes only a GitHub URL:
//                                  {url}, answered with {project} or {error}
//   POST /-/api/ask                ask in a room as the signed-in builder (ask_question), within the
//                                  caps: {space, project, id, content}
//
// Rooms are opened by the hub admin (SPACEHUB_ADMIN_TOKEN): the module lets
// nobody else, so only repositories GitHub vouches for get one. Opening is
// limited to OPENS_PER_MINUTE across the hub.
import type http from 'node:http';
import { DEFAULT_EXPLAIN_SPACE, ROOM_CHAT, roomName } from '../../module/src/explain.ts';

export const OPENS_PER_MINUTE = 30;
const MAX_BODY = 16 * 1024;

export interface RepoInfo {
  /** GitHub's own spelling of the owner and repository. */
  owner: string;
  repo: string;
  description: string;
  private: boolean;
}

export interface RoomsDeps {
  /** The space whose projects are rooms (the module's hub_state "explain_space", "explain" by default). */
  space: string;
  /** Whether the hub can open rooms: it has the admin token. */
  canOpen: boolean;
  /** Whether a project is on the hub. */
  exists: (fullName: string) => Promise<boolean>;
  /** GitHub's word on a repository: null when it does not answer; throws when it does not exist. */
  info: (owner: string, repo: string) => Promise<RepoInfo | null>;
  /** Open the room as the hub admin. */
  open: (input: { owner: string; repo: string; description: string; openedBy: string }) => Promise<void>;
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
  /** Ask as the signed-in builder; rejects with the module's reason. */
  ask: (token: string, input: { project: string; id: string; content: string }) => Promise<void>;
  /** A simple page with a heading and a message, for problems. */
  page: (res: http.ServerResponse, status: number, title: string, message: string) => void;
}

export function explainSpace(env: NodeJS.ProcessEnv = process.env) {
  return env.SPACEHUB_EXPLAIN_SPACE?.trim() || DEFAULT_EXPLAIN_SPACE;
}

/** "owner/repo", "github.com/owner/repo" or a github.com URL (with more after it): the owner and repository. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/^git@github\.com:/i, '');
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/.exec(s);
  return m && roomName(m[1], m[2]) ? { owner: m[1], repo: m[2] } : null;
}

/** A GitHub URL's repository; null for anything else, "owner/repo" alone included. The explain org's chat takes nothing else (app/src/lib/rooms.ts agrees). */
export function parseGithubUrl(input: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#]\S*)?$/i.exec(input.trim());
  return m && roomName(m[1], m[2]) ? { owner: m[1], repo: m[2] } : null;
}

/** Where a room's group chat opens in the app. */
export function roomUrl(space: string, name: string) {
  return `/${space}/${encodeURIComponent(name)}#/files?path=${encodeURIComponent(ROOM_CHAT.slice(0, ROOM_CHAT.lastIndexOf('/')))}`;
}

let opened: number[] = [];
export function forgetOpens() {
  opened = [];
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('too long');
  }
  return JSON.parse(body);
}

type OpenedRoom = { name: string } | { status: number; title: string; message: string };

// The repository's room, opened now when this is its first visit.
async function openRoom(deps: RoomsDeps, wanted: { owner: string; repo: string }, req: http.IncomingMessage, now: number): Promise<OpenedRoom> {
  const name = roomName(wanted.owner, wanted.repo)!;
  if (await deps.exists(`${deps.space}/${name}`).catch(() => false)) return { name };
  if (!deps.canOpen) return { status: 503, title: 'Rooms are off on this hub', message: 'This hub has no admin token, so it cannot open rooms for GitHub repositories.' };
  opened = opened.filter(at => now - at < 60_000);
  if (opened.length >= OPENS_PER_MINUTE) return { status: 429, title: 'Too many new rooms', message: 'Many rooms were opened in the last minute. Try again in a minute.' };
  const missing = { status: 404, title: 'No such repository', message: `GitHub has no public repository ${wanted.owner}/${wanted.repo}.` };
  let info: RepoInfo | null;
  try {
    info = await deps.info(wanted.owner, wanted.repo);
  } catch {
    return missing;
  }
  if (!info) return { status: 503, title: 'GitHub did not answer', message: 'The hub could not ask GitHub about this repository. Try again in a minute.' };
  if (info.private) return missing;
  opened.push(now);
  const session = await deps.sessionOf(req).catch(() => null);
  try {
    await deps.open({ owner: info.owner, repo: info.repo, description: info.description, openedBy: session?.username ?? '' });
  } catch (error) {
    // Two first visits at once: the other one made it.
    if (!(await deps.exists(`${deps.space}/${name}`).catch(() => false))) {
      return { status: 500, title: 'The room did not open', message: (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '') };
    }
  }
  return { name };
}

/** Handle the room routes; false when the request is not one of them. */
export async function handleRooms(deps: RoomsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, now = Date.now()): Promise<boolean> {
  const route = url.pathname;
  if (route === '/-/api/ask') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Ask with POST.' }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const session = await deps.sessionOf(req);
    if (!session) return json(res, 401, { error: 'Sign in to ask.' }), true;
    let input: unknown;
    try {
      input = await readJson(req);
    } catch {
      return json(res, 400, { error: 'Send a space, project, id and question.' }), true;
    }
    const o = input as Record<string, unknown> | null;
    if (!o || typeof o.space !== 'string' || typeof o.project !== 'string' || typeof o.id !== 'string' || typeof o.content !== 'string') {
      return json(res, 400, { error: 'Send a space, project, id and question.' }), true;
    }
    const content = o.content.trim();
    if (!content || content.length > 4000) return json(res, 400, { error: 'A question has 1 to 4000 characters.' }), true;
    try {
      await deps.ask(session.token, { project: `${o.space}/${o.project}`, id: o.id, content });
      return json(res, 200, { ok: true }), true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
      return json(res, /Ask again tomorrow/.test(message) ? 429 : /permission denied/.test(message) ? 403 : 400, { error: message }), true;
    }
  }

  if (route === '/-/api/explain') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Send a URL with POST.' }), true;
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Send JSON.' }), true;
    const input = await readJson(req).catch(() => null);
    const sent = (input as { url?: unknown } | null)?.url;
    const wanted = typeof sent === 'string' ? parseGithubUrl(sent) : null;
    if (!wanted) return json(res, 400, { error: 'Only a GitHub repository URL works here, like https://github.com/owner/repo.' }), true;
    const room = await openRoom(deps, wanted, req, now);
    return ('name' in room ? json(res, 200, { project: room.name }) : json(res, room.status, { error: room.message })), true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = /^\/(?:-\/)?gh\/([^/]+)\/([^/]+?)\/?$/.exec(route);
  if (!path) return false;
  let wanted: { owner: string; repo: string } | null = null;
  try {
    wanted = parseRepo(`${decodeURIComponent(path[1])}/${decodeURIComponent(path[2])}`);
  } catch {
    wanted = null;
  }
  if (!wanted) return deps.page(res, 404, 'Not a GitHub repository', 'Use a GitHub repository like owner/repo or https://github.com/owner/repo.'), true;
  const room = await openRoom(deps, wanted, req, now);
  if (!('name' in room)) return deps.page(res, room.status, room.title, room.message), true;
  res.writeHead(303, { location: roomUrl(deps.space, room.name), 'cache-control': 'no-store' });
  res.end();
  return true;
}
