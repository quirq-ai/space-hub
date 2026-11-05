// Repo rooms on the web (module/src/explain.ts): an open explainer and group
// chat for any public GitHub repository.
//
//   GET  /gh/<owner>/<repo>        open the repository's room (made on the first visit, once GitHub
//   GET  /-/gh/<owner>/<repo>      says the repository is public) and go to its group chat; anyone,
//                                  signed in or not, can open one
//   GET  /-/gh?repo=<owner/repo or github.com URL>   the same, from the home page's form
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

  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let wanted: { owner: string; repo: string } | null = null;
  const path = /^\/(?:-\/)?gh\/([^/]+)\/([^/]+?)\/?$/.exec(route);
  if (path) {
    try {
      wanted = parseRepo(`${decodeURIComponent(path[1])}/${decodeURIComponent(path[2])}`);
    } catch {
      wanted = null;
    }
  } else if (route === '/-/gh') {
    wanted = parseRepo(url.searchParams.get('repo') ?? '');
  } else return false;
  if (!wanted) return deps.page(res, 404, 'Not a GitHub repository', 'Use a GitHub repository like owner/repo or https://github.com/owner/repo.'), true;

  const name = roomName(wanted.owner, wanted.repo)!;
  const there = (await deps.exists(`${deps.space}/${name}`).catch(() => false));
  const go = () => {
    res.writeHead(303, { location: roomUrl(deps.space, name), 'cache-control': 'no-store' });
    res.end();
  };
  if (there) return go(), true;
  if (!deps.canOpen) return deps.page(res, 503, 'Rooms are off on this hub', 'This hub has no admin token, so it cannot open rooms for GitHub repositories.'), true;
  opened = opened.filter(at => now - at < 60_000);
  if (opened.length >= OPENS_PER_MINUTE) return deps.page(res, 429, 'Too many new rooms', 'Many rooms were opened in the last minute. Try again in a minute.'), true;
  let info: RepoInfo | null;
  try {
    info = await deps.info(wanted.owner, wanted.repo);
  } catch {
    return deps.page(res, 404, 'No such repository', `GitHub has no public repository ${wanted.owner}/${wanted.repo}.`), true;
  }
  if (!info) return deps.page(res, 503, 'GitHub did not answer', 'The hub could not ask GitHub about this repository. Try again in a minute.'), true;
  if (info.private) return deps.page(res, 404, 'No such repository', `GitHub has no public repository ${wanted.owner}/${wanted.repo}.`), true;
  opened.push(now);
  const session = await deps.sessionOf(req).catch(() => null);
  try {
    await deps.open({ owner: info.owner, repo: info.repo, description: info.description, openedBy: session?.username ?? '' });
  } catch (error) {
    // Two first visits at once: the other one made it.
    if (!(await deps.exists(`${deps.space}/${name}`).catch(() => false))) {
      return deps.page(res, 500, 'The room did not open', (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '')), true;
    }
  }
  return go(), true;
}
