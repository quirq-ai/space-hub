// Agenthub: the app's launchpad for worker agents, served by the web service
// at /-/api/agenthub/. A builder starts a session from the hub's app and the
// service starts it as a task on an Agents Hub (a sandbox and an agent that
// works on GitHub as the hub's owner), then reads it back:
//
//   GET    /-/api/agenthub                     {enabled, signedIn, allowed, builder}
//   GET    /-/api/agenthub/tasks               the Agents Hub's tasks (?status=)
//   POST   /-/api/agenthub/tasks               {title?, text, repo?}: start one
//   GET    /-/api/agenthub/tasks/<id>          {task, result}
//   GET    /-/api/agenthub/tasks/<id>/events   what happened, step by step (?after=N)
//   POST   /-/api/agenthub/tasks/<id>/messages {text}: follow up, once it is not running
//   POST   /-/api/agenthub/tasks/<id>/stop
//   DELETE /-/api/agenthub/tasks/<id>          tear it down (its sandbox and history)
//
// The Agents Hub token stays on the server (SPACEHUB_AGENTHUB_TOKEN): the
// browser only ever talks to this service, with its session cookie. Every task
// runs as the token's owner, so only the builders named in
// SPACEHUB_AGENTHUB_BUILDERS may use it. Without SPACEHUB_AGENTHUB_URL and
// SPACEHUB_AGENTHUB_TOKEN the routes answer that Agenthub is not set up.
import crypto from 'node:crypto';
import type http from 'node:http';
import { Reply } from './admin.ts';

const PREFIX = '/-/api/agenthub';
const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const STATUSES = new Set(['running', 'done', 'stopped', 'failed', 'ending']);
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 20_000;
const MAX_TITLE = 200;
const TIMEOUT_MS = 20_000;
// A session page re-reads its events every few seconds; who is signed in is
// checked against the database once a minute per session, not on every read.
const SESSION_TTL_MS = 60_000;

export interface AgentHubConfig {
  url: string; // the Agents Hub's address, without a trailing slash
  token: string; // its API token (Settings, Agent access): never sent to a browser
  builders: Set<string>; // who may start and steer sessions
}

export function agentHubConfig(env: NodeJS.ProcessEnv = process.env): AgentHubConfig | null {
  const url = (env.SPACEHUB_AGENTHUB_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.SPACEHUB_AGENTHUB_TOKEN ?? '').trim();
  if (!url || !token) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error('SPACEHUB_AGENTHUB_URL must be an https:// address');
  const builders = new Set((env.SPACEHUB_AGENTHUB_BUILDERS ?? '').split(/[\s,]+/).map(name => name.trim().toLowerCase()).filter(Boolean));
  return { url, token, builders };
}

export interface AgentHubDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<{ token: string; username: string } | null>;
  sameOrigin: (req: http.IncomingMessage) => boolean;
}

type Session = { token: string; username: string } | null;
const sessions = new Map<string, { session: Session; until: number }>();

async function cachedSession(deps: AgentHubDeps, req: http.IncomingMessage): Promise<Session> {
  const cookie = /(?:^|;\s*)spacehub_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
  if (!cookie) return null;
  const key = crypto.createHash('sha256').update(cookie).digest('hex');
  const now = Date.now();
  const hit = sessions.get(key);
  if (hit && hit.until > now) return hit.session;
  const session = await deps.sessionOf(req);
  if (sessions.size > 1000) for (const [k, v] of sessions) if (v.until <= now) sessions.delete(k);
  sessions.set(key, { session, until: now + SESSION_TTL_MS });
  return session;
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

/** What a builder may send to start a session; the Agents Hub checks the rest. */
export function parseStart(input: Record<string, unknown>, builder: string) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Reply(400, 'Say what the agent should do.');
  if (text.length > MAX_TEXT) throw new Reply(400, `Keep the task under ${MAX_TEXT.toLocaleString('en-US')} characters.`);
  const repo = typeof input.repo === 'string' ? input.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '') : '';
  if (repo && !REPO.test(repo)) throw new Reply(400, 'The repository is owner/name, like quirq-ai/space-hub.');
  const given = typeof input.title === 'string' ? input.title.trim() : '';
  const title = (given || text.split('\n')[0]).slice(0, MAX_TITLE).trim();
  // The task runs as the Agents Hub's owner; say who asked, for its history.
  return { title, text: `${text}\n\n(Started from spacehub by ${builder}.)`, ...(repo ? { repo } : {}) };
}

function parseFollowUp(input: Record<string, unknown>) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Reply(400, 'Write a message first.');
  if (text.length > MAX_TEXT) throw new Reply(400, `Keep the message under ${MAX_TEXT.toLocaleString('en-US')} characters.`);
  return { text };
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
  if (response.status === 404) throw new Reply(404, 'This session has ended and was torn down.');
  if (response.status === 409) throw new Reply(409, said || 'The agent is still working. Follow up when it finishes.');
  if (response.status >= 500) throw new Reply(502, said || 'The Agents Hub could not do this right now.');
  throw new Reply(response.status, said || `The Agents Hub said no (${response.status}).`);
}

/** Answers the request and returns true when it is an Agenthub route. */
export async function handleAgentHub(cfg: AgentHubConfig | null, deps: AgentHubDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  if (route !== PREFIX && !route.startsWith(PREFIX + '/')) return false;
  try {
    const session = await cachedSession(deps, req);
    const builder = session?.username.toLowerCase() ?? '';
    const allowed = !!cfg && !!builder && cfg.builders.has(builder);
    if (route === PREFIX) {
      if (req.method !== 'GET') throw new Reply(405, 'Read this with GET.');
      return json(res, 200, { enabled: !!cfg, signedIn: !!session, allowed, builder: session?.username ?? null }), true;
    }
    if (!cfg) throw new Reply(503, 'Agenthub is not set up on this hub.');
    if (!session) throw new Reply(401, 'Sign in to use Agenthub.');
    if (!allowed) throw new Reply(403, 'Agenthub sessions run as the hub’s owner, so only the builders they allow can use them.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !deps.sameOrigin(req)) throw new Reply(403, 'This must be sent from this site.');

    const rest = route.slice(PREFIX.length + 1).split('/');
    if (rest[0] !== 'tasks') throw new Reply(404, 'No such route.');
    const [, id, action, extra] = rest;
    if (id === undefined || id === '') {
      if (req.method === 'GET') {
        const status = url.searchParams.get('status') ?? '';
        const found = await upstream(cfg, 'GET', `tasks${STATUSES.has(status) ? `?status=${status}` : ''}`);
        return json(res, 200, found.data), true;
      }
      if (req.method === 'POST') {
        const task = parseStart(await readJson(req), session.username);
        const started = await upstream(cfg, 'POST', 'tasks', task, idempotencyKey(req));
        return json(res, started.status, started.data), true;
      }
      throw new Reply(405, 'Method not allowed.');
    }
    if (!TASK_ID.test(id) || extra !== undefined) throw new Reply(404, 'No such session.');
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
