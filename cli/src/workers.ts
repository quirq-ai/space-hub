// Workers on your own runners, served by the web service (docs/specs/2026-11-03-workers-on-your-own-runners-design.md).
// A person connects runners (services that speak the Worker Protocol, workerclient.ts) and launches workers
// from a project's chat on one of them; everyone in the space follows the worker there.
//
//   GET    /-/api/runners                         your runners (never their tokens)
//   POST   /-/api/runners {url, token, name?}     connect one: checked, sealed, saved
//   PATCH  /-/api/runners/<id> {name?, default?}
//   POST   /-/api/runners/<id>/test
//   DELETE /-/api/runners/<id>                    disconnect (its workers stay; a Connect token is revoked)
//   POST   /-/api/runners/connect {url}           the Connect button: {redirect} to the runner's consent page
//   GET    /-/runners/connect/callback            back from it: connected, then to Settings
//   GET    /-/api/workers?space=&project=         {enabled, runners, canLaunch} for the chat
//   GET    /-/api/workers?mine=1                  your workers
//   POST   /-/api/workers {space, project, conversation, text, repo?, title?, runner?}   launch
//   GET    /-/api/workers/<task>                  {task, result, state?, launcher, mine, runner}
//   GET    /-/api/workers/<task>/events?after=N
//   POST   /-/api/workers/<task>/messages {text}  follow up   (the launcher only)
//   POST   /-/api/workers/<task>/stop                         (the launcher only)
//   DELETE /-/api/workers/<task>                  tear down   (the launcher only)
//
// Members of a worker's space read it with the launcher's token, on the server; nobody but this service ever
// holds a runner token, and none appears in an answer. Reads may use a membership answer up to a minute old;
// anything that spends or ends checks membership afresh.
import crypto from 'node:crypto';
import type http from 'node:http';
import { open, seal } from './seal.ts';
import { checkRunnerUrl, redactToken, runner as runnerClient, RunnerError, type Describe } from './workerclient.ts';
import { RUNNER_ID, TASK_ID, type Runner, type RunnerStore, type Worker, type WorkerResult } from './runnerstore.ts';

const RUNNERS = '/-/api/runners';
const WORKERS = '/-/api/workers';
// Connect (spec §6.3): like GitHub sign-in, the PKCE verifier stays here, keyed by a random state that also
// goes in an HttpOnly cookie on the callback's path, so only the browser that pressed Connect can finish it,
// once, within 10 minutes, as the same builder.
export const CONNECT_CALLBACK = '/-/runners/connect/callback';
export const CONNECT_COOKIE = 'spacehub_runner_connect';
const CONNECT_WAIT_MS = 600_000;
const MAX_CONNECTING = 500;
type Connecting = { owner: string; url: string; verifier: string; redirect: string; until: number };
const connecting = new Map<string, Connecting>();
const b64url = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');
const sameText = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookieOf(req: http.IncomingMessage, name: string): string {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
const connectCookie = (value: string, maxAge: number, https: boolean) =>
  `${CONNECT_COOKIE}=${value}; Path=/-/runners/connect; SameSite=Lax; Max-Age=${maxAge}; HttpOnly${https ? '; Secure' : ''}`;
const SPACE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const PROJECT = /^[A-Za-z0-9._-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 3_800; // a chat turn holds the task text and the marker
const MAX_TITLE = 120;
const READ_TTL_MS = 60_000;
const TERMINAL = new Set(['done', 'stopped', 'failed']);
export const NOT_SET_UP = 'Connecting runners is not set up on this hub.';

/** The line a launch turn ends with: the chat shows the worker in its place (unchanged from the shared hub). */
export const taskMarker = (id: string) => `<!-- agenthub:task=${id} -->`;

type Session = { token: string; username: string };
type Places = { spaces: string[]; projects: string[] }; // spaces they own or belong to; projects they collaborate on
type Turn = { id: string; role: string; content: string; links: { label: string; path: string }[] };

export interface WorkersDeps {
  sessionOf: (req: http.IncomingMessage) => Promise<Session | null>;
  placesOf: (session: Session) => Promise<Places>;
  appendChat: (session: Session, input: { project: string; conversation: string; turns: Turn[] }) => Promise<void>;
  sameOrigin: (req: http.IncomingMessage) => boolean;
  /** CONNECT_CALLBACK's full URL, as the browser reached this hub. */
  callbackUrl: (req: http.IncomingMessage) => string;
}
// allowLocal: runners at http://127.0.0.1 or localhost may be connected (local development only).
export type WorkersConfig = { key: Buffer | null; store: RunnerStore; allowLocal?: boolean };

class Reply extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
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
  try { value = JSON.parse(body || '{}'); } catch { throw new Reply(400, 'Send JSON.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Reply(400, 'Send a JSON object.');
  return value as Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const inSpace = (p: Places, space: string) => p.spaces.includes(space) || p.projects.some(x => x.startsWith(`${space}/`));
const canWrite = (p: Places, space: string, project: string) => p.spaces.includes(space) || p.projects.includes(`${space}/${project}`);

/** "owner/repo", from that or a github.com link to the repository, an issue or a pull request. */
export function repoOf(input: string): string {
  const link = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(input);
  return link ? link[1] : input.replace(/\/+$/, '');
}

/** A launch from a chat: where, what, and on which repository. The runner checks the rest. */
export function parseLaunch(input: Record<string, unknown>, builder: string) {
  const space = text(input.space).toLowerCase();
  const project = text(input.project);
  const conversation = text(input.conversation);
  if (!SPACE.test(space) || !PROJECT.test(project) || !/^[^\0]{1,1024}\.json$/.test(conversation) || conversation.split('/').includes('..')) throw new Reply(400, 'Launch from a conversation in a project.');
  const task = text(input.text);
  if (!task) throw new Reply(400, 'Say what the worker should do.');
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

const runnerView = (r: Runner) => ({ id: r.id, name: r.name, kind: r.kind, url: r.url, via: r.via, isDefault: r.isDefault, capabilities: r.capabilities, connectedAt: r.connectedAt, checkedAt: r.checkedAt });

// Only the protocol's fields go on to a browser: a runner's answer is otherwise its own business (and could
// carry anything, even its token).
function taskOf(value: unknown, fallbackId: string) {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : null);
  return { id: s('id') ?? fallbackId, title: s('title') ?? '', repo: s('repo'), status: s('status') ?? '', createdAt: s('createdAt'), lastActivityAt: s('lastActivityAt') };
}

function resultOf(value: unknown): WorkerResult {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    summary: typeof v.summary === 'string' ? v.summary : null,
    links: Array.isArray(v.links) ? v.links.map(l => (typeof l === 'string' ? l : (l as { url?: unknown })?.url)).filter((l): l is string => typeof l === 'string') : [],
    error: typeof v.error === 'string' ? v.error : null,
  };
}

// Every string a runner sends could carry its token (an agent printing it in a summary): take it out of
// the whole answer before it is shown or kept.
const scrub = <T>(value: T, token: string): T => JSON.parse(redactToken(JSON.stringify(value), token));

const viewers = new Map<string, { at: number; places: Places }>();

export async function handleWorkers(cfg: WorkersConfig, deps: WorkersDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const isRunners = route === RUNNERS || route.startsWith(`${RUNNERS}/`);
  const isWorkers = route === WORKERS || route.startsWith(`${WORKERS}/`);
  const isConnectBack = route === CONNECT_CALLBACK;
  if (!isRunners && !isWorkers && !isConnectBack) return false;
  const { store, key } = cfg;
  try {
    const session = await deps.sessionOf(req);
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && !deps.sameOrigin(req)) throw new Reply(403, 'This must be sent from this site.');

    // Membership: cached for reads (cards poll), fresh for anything that spends or ends.
    const placesOf = async (fresh: boolean): Promise<Places> => {
      if (!session) return { spaces: [], projects: [] };
      const k = crypto.createHash('sha256').update(session.token).digest('hex');
      const hit = viewers.get(k);
      if (!fresh && hit && Date.now() - hit.at < READ_TTL_MS) return hit.places;
      const places = await deps.placesOf(session);
      if (viewers.size > 1000) viewers.clear();
      viewers.set(k, { at: Date.now(), places });
      return places;
    };
    const tokenOf = async (r: Runner) => {
      if (!key) throw new Reply(503, NOT_SET_UP);
      const sealed = await store.sealedTokenOf(r.id);
      if (!sealed) throw new Reply(409, 'This runner is not connected.');
      return open(key, sealed);
    };
    const clientFor = async (r: Runner) => { const token = await tokenOf(r); return { client: runnerClient(r.url, token), token }; };
    // A checked runner, saved: its token sealed, and its earlier workers (same address) linked back to it.
    const saveRunner = async (owner: string, address: string, token: string, described: Describe, via: Runner['via'], name: string) => {
      const id = crypto.randomBytes(8).toString('hex');
      await store.addRunner({ id, owner, name: name || redactToken(described.name, token), kind: redactToken(described.kind, token), url: address,
        sealedToken: seal(key!, token), capabilities: described.capabilities, via, isDefault: false });
      for (const w of await store.listWorkers({ launcher: owner })) {
        if (w.runnerUrl === address && w.runnerId !== id && !(await store.getRunner(w.runnerId))) await store.updateWorker(w.taskId, { runnerId: id });
      }
      return id;
    };
    const ownRunner = async (id: string) => {
      if (!session) throw new Reply(401, 'Sign in to use runners.');
      const r = RUNNER_ID.test(id) ? await store.getRunner(id) : null;
      if (!r || r.owner !== session.username) throw new Reply(404, 'No such runner.');
      return r;
    };

    // ------------------------------------------------------------ back from a runner's consent page
    if (isConnectBack) {
      if (req.method !== 'GET') throw new Reply(405, 'Method not allowed.');
      // Only a code for the outcome reaches the app, never text from the runner.
      const done = (outcome: 'connected' | 'denied' | 'expired' | 'full' | 'failed') => {
        res.writeHead(303, { location: `/?runner=${outcome}#/settings`, 'cache-control': 'no-store',
          'set-cookie': connectCookie('', 0, deps.callbackUrl(req).startsWith('https:')) });
        res.end();
        return true;
      };
      const state = url.searchParams.get('state') ?? '';
      const fromCookie = cookieOf(req, CONNECT_COOKIE);
      const c = state ? connecting.get(state) : undefined;
      if (c) connecting.delete(state); // one try, whatever happens next
      if (!c || !fromCookie || !sameText(state, fromCookie) || c.until <= Date.now()) return done('expired');
      if (url.searchParams.get('error')) return done('denied');
      if (!session || session.username !== c.owner || !key) return done('failed');
      let token = '';
      try {
        token = await runnerClient(c.url, '').exchange({ code: url.searchParams.get('code') ?? '', codeVerifier: c.verifier, redirectUri: c.redirect });
        const client = runnerClient(c.url, token);
        const described = await client.describe();
        await client.list();
        // Connect again to a runner already connected: the same runner gets the new token, so runners and the
        // runner's tokens do not pile up; a token space-hub got through Connect before is given back.
        const known = await store.runnerAt(c.owner, c.url);
        if (known) {
          if (known.via === 'connect') {
            try { await (await clientFor(known)).client.revokeSelf(); } catch { /* it can be revoked on the runner */ }
          }
          await store.updateRunner(known.id, { sealedToken: seal(key, token), capabilities: described.capabilities, via: 'connect', checked: true });
        } else {
          await saveRunner(c.owner, c.url, token, described, 'connect', '');
        }
      } catch (err) {
        process.stderr.write(`spacehub-web: workers: connecting ${c.url} failed: ${err instanceof Error ? redactToken(err.message, token) : 'unknown error'}\n`);
        // The runner made a token space-hub will not keep: give it back.
        if (token) { try { await runnerClient(c.url, token).revokeSelf(); } catch { /* it can be revoked on the runner */ } }
        if (!token && err instanceof RunnerError && err.status === 409) return done('full');      // out of tokens
        if (!token && err instanceof RunnerError && err.status === 400) return done('expired');   // its code is gone
        return done('failed');
      }
      return done('connected');
    }

    // ------------------------------------------------------------ runners
    if (isRunners) {
      if (!session) throw new Reply(401, 'Sign in to use runners.');
      const rest = route.slice(RUNNERS.length + 1).split('/').filter(Boolean);
      if (!rest.length) {
        if (req.method === 'GET') return json(res, 200, { enabled: !!key, runners: (await store.listRunners(session.username)).map(runnerView) }), true;
        if (req.method !== 'POST') throw new Reply(405, 'Method not allowed.');
        if (!key) throw new Reply(503, NOT_SET_UP);
        const body = await readJson(req);
        const address = checkRunnerUrl(text(body.url), cfg.allowLocal);
        const token = text(body.token);
        if (!token || token.length > 1000) throw new Reply(400, "Paste the runner's token.");
        const client = runnerClient(address, token);
        let described: Describe;
        try {
          described = await client.describe();
          await client.list(); // the token must work for tasks too, not only describe the runner
        } catch (e) {
          if (e instanceof RunnerError && e.auth) throw new Reply(400, 'That token is not valid for this runner.');
          throw e;
        }
        const id = await saveRunner(session.username, address, token, described, 'paste', text(body.name).slice(0, 80));
        return json(res, 201, { runner: runnerView((await store.getRunner(id))!) }), true;
      }
      if (rest.length === 1 && rest[0] === 'connect') {
        if (req.method !== 'POST') throw new Reply(405, 'Method not allowed.');
        if (!key) throw new Reply(503, NOT_SET_UP);
        const address = checkRunnerUrl(text((await readJson(req)).url), cfg.allowLocal);
        const pasteInstead = "This runner connects with a token: make one in its settings and paste it here.";
        let about: Describe;
        try { about = await runnerClient(address, '').describe(); } catch (e) {
          if (e instanceof RunnerError && e.auth) throw new Reply(400, pasteInstead);
          throw e;
        }
        if (!about.capabilities.connect) throw new Reply(400, pasteInstead);
        const now = Date.now();
        for (const [k, c] of connecting) if (c.until <= now) connecting.delete(k);
        if (connecting.size >= MAX_CONNECTING) throw new Reply(429, 'Too many connections are waiting; try again in a few minutes.');
        const state = b64url(32);
        const verifier = b64url(48);
        const redirect = deps.callbackUrl(req);
        connecting.set(state, { owner: session.username, url: address, verifier, redirect, until: now + CONNECT_WAIT_MS });
        const to = new URL(`${address}/connect`);
        to.search = new URLSearchParams({ client: new URL(redirect).origin, redirect_uri: redirect, state,
          code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
        return json(res, 200, { redirect: to.href }, { 'set-cookie': connectCookie(state, CONNECT_WAIT_MS / 1000, redirect.startsWith('https:')) }), true;
      }
      const r = await ownRunner(rest[0]);
      if (rest.length === 1 && req.method === 'PATCH') {
        const body = await readJson(req);
        await store.updateRunner(r.id, { name: text(body.name).slice(0, 80) || undefined, isDefault: body.default === true });
        return json(res, 200, { runner: runnerView((await store.getRunner(r.id))!) }), true;
      }
      if (rest.length === 1 && req.method === 'DELETE') {
        // A token space-hub got through Connect is space-hub's to give back; a pasted one is the person's own.
        if (r.via === 'connect') {
          try { await (await clientFor(r)).client.revokeSelf(); } catch { /* disconnect anyway; it can be revoked on the runner */ }
        }
        await store.deleteRunner(r.id);
        return json(res, 200, { deleted: true }), true;
      }
      if (rest.length === 2 && rest[1] === 'test' && req.method === 'POST') {
        const { client } = await clientFor(r);
        const described = await client.describe();
        await client.list();
        await store.updateRunner(r.id, { capabilities: described.capabilities, via: r.via, checked: true });
        return json(res, 200, { ok: true, runner: runnerView((await store.getRunner(r.id))!) }), true;
      }
      throw new Reply(404, 'No such route.');
    }

    // ------------------------------------------------------------ workers
    const rest = route.slice(WORKERS.length + 1).split('/').filter(Boolean);
    if (!rest.length) {
      if (req.method === 'GET') {
        if (url.searchParams.get('mine') === '1') {
          if (!session) throw new Reply(401, 'Sign in to see your workers.');
          return json(res, 200, { workers: await store.listWorkers({ launcher: session.username }) }), true;
        }
        const space = (url.searchParams.get('space') ?? '').toLowerCase();
        const project = url.searchParams.get('project') ?? '';
        const runners = session && key ? (await store.listRunners(session.username)).map(runnerView) : [];
        const places = await placesOf(false);
        return json(res, 200, { enabled: !!key, signedIn: !!session, runners, canLaunch: !!runners.length && canWrite(places, space, project) }), true;
      }
      if (req.method !== 'POST') throw new Reply(405, 'Method not allowed.');
      if (!session) throw new Reply(401, 'Sign in to launch workers.');
      if (!key) throw new Reply(503, NOT_SET_UP);
      const body = await readJson(req);
      const launch = parseLaunch(body, session.username);
      if (!canWrite(await placesOf(true), launch.where.space, launch.where.project)) throw new Reply(403, `Only people who can write to ${launch.where.space}/${launch.where.project} can launch workers here.`);
      const mine = await store.listRunners(session.username);
      const chosenId = text(body.runner);
      const r = chosenId ? mine.find(x => x.id === chosenId) : mine.find(x => x.isDefault) ?? mine[0];
      if (chosenId && !r) throw new Reply(404, 'No such runner.');
      if (!r) throw new Reply(409, 'Connect a runner in Settings to launch workers.');
      // A runner without the repo capability is not asked about a repository.
      const { repo, ...rest } = launch.task;
      const taskInput = r.capabilities.repo && repo ? { ...rest, repo } : rest;
      const given = req.headers['idempotency-key'];
      const ikey = typeof given === 'string' && IDEMPOTENCY_KEY.test(given) ? given : crypto.randomBytes(16).toString('hex');
      const { client: starter, token: startToken } = await clientFor(r);
      const started = scrub((await starter.start(taskInput, ikey)) as { task?: { id?: unknown }; result?: unknown }, startToken);
      const taskId = typeof started.task?.id === 'string' && TASK_ID.test(started.task.id) ? started.task.id : '';
      if (!taskId) throw new Reply(502, 'The runner did not say which worker it started.');
      // Worker ids are the runner's; one that is already another launcher's (or another runner's) worker is refused.
      const known = await store.getWorker(taskId);
      if (known && (known.launcher !== session.username || known.runnerUrl !== r.url)) throw new Reply(502, 'The runner reused the id of another worker, so this launch was not saved. Ask its owner to check the runner.');
      if (!known) {
        await store.addWorker({ taskId, runnerId: r.id, runnerUrl: r.url, launcher: session.username, space: launch.where.space,
          project: launch.where.project, conversation: launch.where.conversation, title: launch.task.title });
      }
      let saved = true;
      try {
        await deps.appendChat(session, { project: `${launch.where.space}/${launch.where.project}`, conversation: launch.where.conversation,
          turns: [{ id: crypto.randomUUID(), role: 'user', content: `${launch.message}\n\n${taskMarker(taskId)}`, links: [] }] });
      } catch (err) {
        saved = false;
        process.stderr.write(`spacehub-web: workers: launched ${taskId} but could not save it to the chat: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return json(res, 201, { task: taskOf(started.task, taskId), result: resultOf(started.result), saved,
        launcher: session.username, mine: true, runner: { id: r.id, name: r.name, kind: r.kind, capabilities: r.capabilities } }), true;
    }

    const [id, action, extra] = rest;
    if (!TASK_ID.test(id) || extra !== undefined) throw new Reply(404, 'No such worker.');
    if (!session) throw new Reply(401, 'Sign in to follow workers.');
    const w = await store.getWorker(id);
    if (!w) throw new Reply(404, 'Unknown worker.');
    const steering = !reading;
    if (!inSpace(await placesOf(steering), w.space)) throw new Reply(403, `Only members of ${w.space} can follow its workers.`);
    const r = await store.getRunner(w.runnerId);
    const about = { launcher: w.launcher, mine: w.launcher === session.username,
      runner: r ? { id: r.id, name: r.name, kind: r.kind, capabilities: r.capabilities } : null };
    const copy = (state: 'gone' | 'disconnected' | 'unreachable') => ({
      task: { id: w.taskId, title: w.title, repo: null, status: state === 'gone' ? 'gone' : w.status }, result: w.result ?? { summary: null, links: [], error: null }, state, ...about,
    });

    if (steering) {
      if (w.launcher !== session.username) throw new Reply(403, `Only ${w.launcher} can steer this worker.`);
      if (!r) throw new Reply(409, 'Connect your runner again to steer this worker.');
      const { client } = await clientFor(r);
      if (action === 'messages' && req.method === 'POST') {
        if (!r.capabilities.followUp) throw new Reply(403, "This runner can't take follow-ups.");
        const message = text((await readJson(req)).text);
        if (!message) throw new Reply(400, 'Write a message first.');
        if (message.length > 20_000) throw new Reply(400, 'Keep the message under 20,000 characters.');
        const given = req.headers['idempotency-key'];
        await client.followUp(id, message, typeof given === 'string' && IDEMPOTENCY_KEY.test(given) ? given : crypto.randomBytes(16).toString('hex'));
        return json(res, 202, { ok: true }), true;
      }
      if (action === 'stop' && req.method === 'POST') {
        if (!r.capabilities.stop) throw new Reply(403, "This runner can't stop a worker.");
        const out = (await client.stop(id)) as { stopped?: unknown; reason?: unknown };
        const stopped = out.stopped !== false;
        return json(res, stopped ? 202 : 200, { stopped, ...(stopped || typeof out.reason !== 'string' ? {} : { reason: out.reason }) }), true;
      }
      if (action === undefined && req.method === 'DELETE') {
        const out = (await client.teardown(id)) as { deleted?: unknown };
        if (out.deleted !== false) await store.updateWorker(id, { status: 'gone' });
        return json(res, out.deleted === false ? 202 : 200, out.deleted === false ? { deleted: false, retrying: true } : { deleted: true }), true;
      }
      throw new Reply(404, 'No such route.');
    }

    if (w.status === 'gone') return json(res, 200, copy('gone')), true;
    if (!r) return json(res, 200, copy('disconnected')), true;
    let client, token: string;
    try { ({ client, token } = await clientFor(r)); } catch { return json(res, 200, copy('disconnected')), true; }
    if (action === 'events') {
      if (!r.capabilities.events) throw new Reply(404, "This runner doesn't share a worker's steps.");
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      const page = (await client.events(id, after)) as { events?: unknown; next?: unknown };
      // Steps are the runner's own output; the launcher's token is taken out of them, whatever field it is in.
      const events = scrub(Array.isArray(page.events) ? page.events : [], token);
      return json(res, 200, { events, next: typeof page.next === 'number' ? page.next : after }), true;
    }
    if (action !== undefined) throw new Reply(404, 'No such route.');
    try {
      const got = scrub((await client.get(id)) as { task?: { status?: unknown }; result?: unknown }, token);
      const status = typeof got.task?.status === 'string' ? got.task.status : '';
      if (TERMINAL.has(status) && (w.status !== status || !w.result)) await store.updateWorker(id, { status, result: resultOf(got.result) });
      else if (status && status !== w.status) await store.updateWorker(id, { status });
      return json(res, 200, { task: taskOf(got.task, id), result: resultOf(got.result), ...about }), true;
    } catch (e) {
      if (!(e instanceof RunnerError)) throw e;
      // Not found with this token: torn down elsewhere, or a token that cannot see it (another one, reconnected).
      // Only a tear down from here marks it gone for good; this answer is not kept.
      if (e.status === 404) return json(res, 200, copy('disconnected')), true;
      return json(res, 200, copy(e.auth ? 'disconnected' : 'unreachable')), true;
    }
  } catch (err) {
    if (err instanceof Reply || err instanceof RunnerError) json(res, err.status, { error: err.message });
    else {
      process.stderr.write(`spacehub-web: workers: ${err instanceof Error ? err.message : String(err)}\n`);
      json(res, 500, { error: 'internal error' });
    }
    return true;
  }
}

