// Agenthub: worker agents launched from a project's chat, served by the web
// service at /-/api/agenthub/. A member writes a message in a channel and
// presses Launch instead of Send: the service starts a task on the org's
// Agents Hub (a sandbox and an agent that works on GitHub), and saves the
// message to the channel's chat with the task's id, so everyone in the
// channel sees the worker and follows it there.
//
//   GET    /-/api/agenthub?space=<org>         {enabled, signedIn, allowed}: may I launch here
//   POST   /-/api/agenthub/tasks               {space, project, conversation, text, repo?, title?}
//   GET    /-/api/agenthub/tasks/<id>          {task, result}
//   GET    /-/api/agenthub/tasks/<id>/events   what happened, step by step (?after=N)
//   POST   /-/api/agenthub/tasks/<id>/messages {text}: follow up, once it is not running
//   POST   /-/api/agenthub/tasks/<id>/stop
//   DELETE /-/api/agenthub/tasks/<id>          tear it down (its sandbox and history)
//
// The agents belong to the orgs named in SPACEHUB_AGENTHUB_SPACES: their
// members (and owners) launch and steer them, nobody else. The Agents Hub
// token (SPACEHUB_AGENTHUB_TOKEN) stays on the server; the browser only talks
// to this service with its session cookie. Without SPACEHUB_AGENTHUB_URL and
// SPACEHUB_AGENTHUB_TOKEN the routes answer that agents are not set up.
import crypto from 'node:crypto';
import type http from 'node:http';
import { Reply } from './admin.ts';

const PREFIX = '/-/api/agenthub';
const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SPACE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const PROJECT = /^[A-Za-z0-9._-]{1,100}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_BODY = 64 * 1024;
// A chat turn holds the task text and the marker that names the task.
const MAX_TEXT = 3_800;
const MAX_TITLE = 120;
const TIMEOUT_MS = 20_000;
// Worker cards re-read their task every few seconds; who is signed in, and
// where they are a member, is checked against the database once a minute.
const SESSION_TTL_MS = 60_000;

/** The line a launch turn ends with: the chat shows the worker in its place. */
export const taskMarker = (id: string) => `<!-- agenthub:task=${id} -->`;

export interface AgentHubConfig {
  url: string; // the Agents Hub's address, without a trailing slash
  token: string; // its API token (Settings, Agent access): never sent to a browser
  spaces: Set<string>; // the orgs whose members launch agents
}

export function agentHubConfig(env: NodeJS.ProcessEnv = process.env): AgentHubConfig | null {
  const url = (env.SPACEHUB_AGENTHUB_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.SPACEHUB_AGENTHUB_TOKEN ?? '').trim();
  if (!url || !token) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error('SPACEHUB_AGENTHUB_URL must be an https:// address');
  const spaces = new Set((env.SPACEHUB_AGENTHUB_SPACES ?? '').split(/[\s,]+/).map(name => name.trim().toLowerCase()).filter(Boolean));
  return { url, token, spaces };
}

type Session = { token: string; username: string };
type Turn = { id: string; role: string; content: string; links: { label: string; path: string }[] };

export interface AgentHubDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<Session | null>;
  /** The spaces the builder may push to: its own and those it is a member or owner of. */
  spacesOf: (session: Session) => Promise<string[]>;
  /** Save turns to a conversation as the builder (the module's append_chat). */
  appendChat: (session: Session, input: { project: string; conversation: string; turns: Turn[] }) => Promise<void>;
  sameOrigin: (req: http.IncomingMessage) => boolean;
}

type Viewer = { session: Session; spaces: Set<string> } | null;
const viewers = new Map<string, { viewer: Viewer; until: number }>();

async function viewerOf(deps: AgentHubDeps, req: http.IncomingMessage): Promise<Viewer> {
  const cookie = /(?:^|;\s*)spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
  if (!cookie) return null;
  const key = crypto.createHash('sha256').update(cookie).digest('hex');
  const now = Date.now();
  const hit = viewers.get(key);
  if (hit && hit.until > now) return hit.viewer;
  const session = await deps.sessionOf(req);
  const viewer = session ? { session, spaces: new Set((await deps.spacesOf(session)).map(space => space.toLowerCase())) } : null;
  if (viewers.size > 1000) for (const [k, v] of viewers) if (v.until <= now) viewers.delete(k);
  viewers.set(key, { viewer, until: now + SESSION_TTL_MS });
  return viewer;
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Reply(415, 'Send JSON.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Reply(413, 'This message is too long.');
  }
  let value: unknown;
  try {
    value = JSON.parse(body || '{}');
  } catch {
    throw new Reply(400, 'Send JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Reply(400, 'Send a JSON object.');
  return value as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** "owner/repo", from that or a github.com link to the repository, an issue or a pull request. */
export function repoOf(input: string): string {
  const link = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(input);
  return link ? link[1] : input.replace(/\/+$/, '');
}

/** A launch from a chat: where, what, and on which repository. The Agents Hub checks the rest. */
export function parseLaunch(input: Record<string, unknown>, builder: string) {
  const space = text(input.space).toLowerCase();
  const project = text(input.project);
  const conversation = text(input.conversation);
  if (!SPACE.test(space) || !PROJECT.test(project) || !/^[^\0]{1,1024}\.json$/.test(conversation) || conversation.split('/').includes('..')) throw new Reply(400, 'Launch from a conversation in a project.');
  const task = text(input.text);
  if (!task) throw new Reply(400, 'Say what the agent should do.');
  if (task.length > MAX_TEXT) throw new Reply(400, `Keep the task under ${MAX_TEXT.toLocaleString('en-US')} characters.`);
  const repo = repoOf(text(input.repo));
  if (repo && !REPO.test(repo)) throw new Reply(400, 'The repository is owner/name, or a link to it on GitHub.');
  const title = (text(input.title) || task.split('\n')[0]).replace(/[#*_`>]/g, '').trim().slice(0, MAX_TITLE) || 'Worker';
  return {
    where: { space, project, conversation },
    task: { title, text: `${task}\n\n(Launched by ${builder} from ${space}/${project}, ${conversation}.)`, ...(repo ? { repo } : {}) },
    message: task,
  };
}

function parseFollowUp(input: Record<string, unknown>) {
  const message = text(input.text);
  if (!message) throw new Reply(400, 'Write a message first.');
  if (message.length > 20_000) throw new Reply(400, 'Keep the message under 20,000 characters.');
  return { text: message };
}

function idempotencyKey(req: http.IncomingMessage) {
  const given = req.headers['idempotency-key'];
  return typeof given === 'string' && IDEMPOTENCY_KEY.test(given) ? given : crypto.randomBytes(16).toString('hex');
}

/** One call to the Agents Hub, with the token; its answer as status and JSON. */
async function upstream(cfg: AgentHubConfig, method: string, path: string, body?: unknown, key?: string) {
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/api/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Reply(502, 'The Agents Hub did not answer. Try again in a moment.');
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    /* Empty or not JSON. */
  }
  if (response.ok) return { status: response.status, data: data ?? { ok: true } };
  const said = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
  // The hub's own token was refused: the builder's session is fine, the hub's setup is not.
  if (response.status === 401 || response.status === 403) throw new Reply(502, 'The Agents Hub refused this hub’s token. Ask the hub admin to set a new SPACEHUB_AGENTHUB_TOKEN.');
  if (response.status === 404) throw new Reply(404, 'This worker has ended and was torn down.');
  if (response.status === 409) throw new Reply(409, said || 'The agent is still working. Follow up when it finishes.');
  if (response.status >= 500) throw new Reply(502, said || 'The Agents Hub could not do this right now.');
  throw new Reply(response.status, said || `The Agents Hub said no (${response.status}).`);
}

const taskIdOf = (data: unknown) => {
  const value = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const task = value.task && typeof value.task === 'object' ? (value.task as Record<string, unknown>) : value;
  return typeof task.id === 'string' && TASK_ID.test(task.id) ? task.id : '';
};

/** Answers the request and returns true when it is an Agenthub route. */
export async function handleAgentHub(cfg: AgentHubConfig | null, deps: AgentHubDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  if (route !== PREFIX && !route.startsWith(PREFIX + '/')) return false;
  try {
    const viewer = await viewerOf(deps, req);
    // Members of an org with agents may launch in its projects, and follow any worker.
    const memberOf = (space: string) => !!cfg && !!viewer && cfg.spaces.has(space) && viewer.spaces.has(space);
    const anyMember = !!cfg && !!viewer && [...cfg.spaces].some(space => viewer.spaces.has(space));
    if (route === PREFIX) {
      if (req.method !== 'GET') throw new Reply(405, 'Read this with GET.');
      const space = (url.searchParams.get('space') ?? '').toLowerCase();
      return json(res, 200, { enabled: !!cfg && (!space || cfg.spaces.has(space)), signedIn: !!viewer, allowed: space ? memberOf(space) : anyMember }), true;
    }
    if (!cfg) throw new Reply(503, 'Agents are not set up on this hub.');
    if (!viewer) throw new Reply(401, 'Sign in to work with agents.');
    if (!anyMember) throw new Reply(403, 'Only members of an org with agents can work with them.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !deps.sameOrigin(req)) throw new Reply(403, 'This must be sent from this site.');

    const rest = route.slice(PREFIX.length + 1).split('/');
    if (rest[0] !== 'tasks') throw new Reply(404, 'No such route.');
    const [, id, action, extra] = rest;
    if (id === undefined || id === '') {
      if (req.method !== 'POST') throw new Reply(405, 'Method not allowed.');
      const launch = parseLaunch(await readJson(req), viewer.session.username);
      if (!memberOf(launch.where.space)) throw new Reply(403, `Only members of ${launch.where.space} can launch its agents${cfg.spaces.has(launch.where.space) ? '' : ', and it has none set up'}.`);
      const started = await upstream(cfg, 'POST', 'tasks', launch.task, idempotencyKey(req));
      const task = taskIdOf(started.data);
      // The launch is a message in the channel: the chat shows the worker under it.
      let saved = true;
      try {
        await deps.appendChat(viewer.session, {
          project: `${launch.where.space}/${launch.where.project}`,
          conversation: launch.where.conversation,
          turns: [{ id: crypto.randomUUID(), role: 'user', content: task ? `${launch.message}\n\n${taskMarker(task)}` : launch.message, links: [] }],
        });
      } catch (err) {
        saved = false;
        process.stderr.write(`spacehub-web: agenthub: launched ${task || 'a task'} but could not save it to the chat: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return json(res, started.status, { ...(started.data as object), saved }), true;
    }
    if (!TASK_ID.test(id) || extra !== undefined) throw new Reply(404, 'No such worker.');
    const task = `tasks/${encodeURIComponent(id)}`;
    if (action === undefined) {
      if (req.method === 'GET') return json(res, 200, (await upstream(cfg, 'GET', task)).data), true;
      if (req.method === 'DELETE') return json(res, 200, (await upstream(cfg, 'DELETE', task)).data), true;
      throw new Reply(405, 'Method not allowed.');
    }
    if (action === 'events' && req.method === 'GET') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      return json(res, 200, (await upstream(cfg, 'GET', `${task}/events?after=${after}`)).data), true;
    }
    if (action === 'messages' && req.method === 'POST') {
      const message = parseFollowUp(await readJson(req));
      return json(res, 200, (await upstream(cfg, 'POST', `${task}/messages`, message, idempotencyKey(req))).data), true;
    }
    if (action === 'stop' && req.method === 'POST') return json(res, 200, (await upstream(cfg, 'POST', `${task}/stop`)).data), true;
    throw new Reply(404, 'No such route.');
  } catch (err) {
    if (err instanceof Reply) json(res, err.status, { error: err.message });
    else {
      process.stderr.write(`spacehub-web: agenthub: ${err instanceof Error ? err.message : String(err)}\n`);
      json(res, 500, { error: 'internal error' });
    }
    return true;
  }
}
