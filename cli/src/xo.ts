// xo.quirq.dev's door to the hub, served by the web service at /-/api/xo/v1/.
// xo.quirq.dev checks who a user is with Clerk, then keeps what xo knows about
// them (projects, spaces and their refs, invites) here, and asks here for the
// hub agent its users push with:
//
//   GET  records/<clerk user id>   {"version": N, "doc": {...} | null}
//   PUT  records/<clerk user id>   {"version": N, "doc": {...}}: written only if the record is
//                                  still at version N (0: there is none yet); 409 otherwise
//   POST agents/<clerk user id>    {"username": "Suraj", "github": {"id": 1234, "login": "octocat"}}:
//                                  the builder of the GitHub account the user connected to
//                                  XO, made on the first call and named after its login, with
//                                  the xo username as its display name (and a second name, see
//                                  linkGithub): {"agent": "octocat", "token": "..."}. Without
//                                  "github" (an xo server from before GitHub was needed): the
//                                  builder the user has, else one named after the xo username
//
// Every request carries `Authorization: Bearer $SPACEHUB_XO_KEY`; without that
// variable the routes do not exist. The service reads and writes the private
// xo tables as the hub admin (admin.ts).
import http from 'node:http';
import crypto from 'node:crypto';
import { type AdminHttp, call, json, newIdentity, readJson, Reply, select } from './admin.ts';
import type { GithubApi } from './github';

const PREFIX = '/-/api/xo/v1/';
// Clerk user ids (user_2abc...); the same rule as the module's, so an id can
// go into a SQL literal as it is.
const SUBJECT = /^[A-Za-z0-9_]{1,64}$/;

export interface XoConfig extends AdminHttp {
  key: string; // shared with xo.quirq.dev
  github?: GithubApi; // asked whether an xo username is someone's GitHub login
}

// `http` is SpacetimeDB's HTTP API, as the rest of the web service reaches it.
export function xoConfig(db: string, http: string, github?: GithubApi): XoConfig | null {
  const key = process.env.SPACEHUB_XO_KEY ?? '';
  if (!key) return null;
  const adminToken = process.env.SPACEHUB_ADMIN_TOKEN ?? '';
  if (!adminToken) throw new Error('SPACEHUB_XO_KEY is set but SPACEHUB_ADMIN_TOKEN is not: the xo API needs the hub admin');
  if (key.length < 32) throw new Error('SPACEHUB_XO_KEY must be at least 32 characters');
  return { key, adminToken, http, db, ...(github ? { github } : {}) };
}

function authorized(req: http.IncomingMessage, key: string) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- routes

async function getRecord(cfg: XoConfig, subject: string) {
  const [row] = await select(cfg, `SELECT doc, version FROM xo_record WHERE subject = '${subject}'`);
  if (!row) return { version: 0, doc: null };
  return { version: Number(row.version), doc: JSON.parse(String(row.doc)) };
}

async function putRecord(cfg: XoConfig, subject: string, body: Record<string, unknown>) {
  const { version, doc } = body;
  if (!Number.isSafeInteger(version) || (version as number) < 0) throw new Reply(400, '"version" must be a whole number');
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Reply(400, '"doc" must be a JSON object');
  try {
    await call(cfg, 'xo_put_record', [subject, version, JSON.stringify(doc)]);
  } catch (err) {
    if (err instanceof Reply && /stale:/.test(err.message)) throw new Reply(409, 'the record changed since it was read');
    throw err;
  }
  return { version: (version as number) + 1 };
}

// The builder this xo user signs in as, with its token (also xosignin.ts):
// their GitHub account's (xo_link), else the one xo made before GitHub was
// needed (xo_agent).
export async function agentOf(cfg: XoConfig, subject: string) {
  const [link] = await select(cfg, `SELECT username FROM xo_link WHERE subject = '${subject}'`);
  if (link) {
    const name = String(link.username);
    if (!NAME.test(name)) return null;
    const [row] = await select(cfg, `SELECT username, token FROM github_account WHERE username = '${name}'`);
    return row ? { agent: String(row.username), token: String(row.token) } : null;
  }
  const [row] = await select(cfg, `SELECT username, token FROM xo_agent WHERE subject = '${subject}'`);
  return row ? { agent: String(row.username), token: String(row.token) } : null;
}

// Hub names (the module's rule), and GitHub's for logins.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// The xo username as a second name of the builder: only a valid hub name
// that is not someone else's GitHub login, so a GitHub user never finds their
// own login taken here (the module checks it is free). "" for none, also
// when GitHub does not answer: the next sign-in asks again.
async function secondName(cfg: XoConfig, xoName: string, id: number, login: string): Promise<string> {
  const name = xoName.trim().toLowerCase();
  if (!NAME.test(name) || name === login.toLowerCase()) return '';
  const api = cfg.github;
  if (!api) return '';
  try {
    const res = await fetch(`${api.base}/users/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'spacehub', ...(api.token ? { authorization: `Bearer ${api.token}` } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return name;
    if (!res.ok) return '';
    const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return user?.id === id ? name : '';
  } catch {
    return '';
  }
}

// The builder of the GitHub account an xo user connected to XO, made on the
// first sign-in (xo_link_github in the module, which also folds in a builder
// xo made before, and sets the display name and second name).
async function linkGithub(cfg: XoConfig, subject: string, body: Record<string, unknown>) {
  const github = body.github as { id?: unknown; login?: unknown } | null;
  // Clerk keeps GitHub's account id as a string.
  const raw = typeof github?.id === 'string' && /^[1-9][0-9]{0,15}$/.test(github.id) ? Number(github.id) : github?.id;
  const login = github?.login;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0 || typeof login !== 'string' || !GITHUB_LOGIN.test(login)) {
    throw new Reply(400, '"github" must be {"id": the GitHub account id, "login": its login}');
  }
  const xoName = typeof body.username === 'string' ? body.username.slice(0, 64) : '';
  const [known] = await select(cfg, `SELECT username FROM github_account WHERE github_id = ${raw}`);
  const [legacy] = known ? [null] : await select(cfg, `SELECT username FROM xo_agent WHERE subject = '${subject}'`);
  const made = known || legacy ? null : await newIdentity(cfg);
  const alias = await secondName(cfg, xoName, raw, login);
  try {
    await call(cfg, 'xo_link_github', [subject, raw, login, xoName, alias, made?.identity ?? '', made?.token ?? '']);
  } catch (err) {
    if (err instanceof Reply && /is taken|is reserved|a name is/.test(err.message)) {
      const why = /"[^"]*" is (taken|reserved)/.exec(err.message)?.[0] ?? err.message;
      throw new Reply(409, `cannot sign in as ${login}: the name ${why} on this hub; ask the hub's admin`);
    }
    throw err;
  }
  const [row] = await select(cfg, `SELECT username, token FROM github_account WHERE github_id = ${raw}`);
  if (!row) throw new Reply(500, 'the GitHub account has no builder after linking');
  return { agent: String(row.username), token: String(row.token) };
}

async function ensureAgent(cfg: XoConfig, subject: string, body: Record<string, unknown>) {
  if (body.github !== undefined) return linkGithub(cfg, subject, body);
  const found = await agentOf(cfg, subject);
  if (found) return found;
  const username = body.username;
  if (typeof username !== 'string' || !username) throw new Reply(400, '"username" is required');
  const made = await newIdentity(cfg);
  try {
    await call(cfg, 'xo_link_agent', [subject, username, made.identity, made.token]);
  } catch (err) {
    // Another request made it first: that one stands.
    const raced = await agentOf(cfg, subject);
    if (raced) return raced;
    if (err instanceof Reply && /is taken|is reserved|agent name/.test(err.message)) throw new Reply(409, err.message);
    throw err;
  }
  return { agent: username, token: made.token };
}

// Answers the request and returns true when it is an xo API route.
export async function handleXo(cfg: XoConfig | null, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const route = new URL(req.url ?? '/', 'http://local').pathname;
  if (!route.startsWith(PREFIX) || !cfg) return false;
  try {
    if (!authorized(req, cfg.key)) throw new Reply(401, 'missing or wrong xo key');
    const m = /^(records|agents)\/([^/]+)$/.exec(route.slice(PREFIX.length));
    if (!m) throw new Reply(404, 'no such route');
    const [, kind, subject] = m;
    if (!SUBJECT.test(subject)) throw new Reply(400, 'invalid xo user id');
    if (kind === 'records' && req.method === 'GET') return json(res, 200, await getRecord(cfg, subject)), true;
    if (kind === 'records' && req.method === 'PUT') return json(res, 200, await putRecord(cfg, subject, await readJson(req))), true;
    if (kind === 'agents' && req.method === 'POST') return json(res, 200, await ensureAgent(cfg, subject, await readJson(req))), true;
    throw new Reply(405, 'method not allowed');
  } catch (err) {
    // A database refusal that no route turned into a 409 is not shown as it is.
    if (err instanceof Reply) json(res, err.status, { error: err.status === 530 ? 'the hub database refused this' : err.message });
    else {
      process.stderr.write(`spacehub-web: xo api: ${err instanceof Error ? err.message : String(err)}\n`);
      json(res, 500, { error: 'internal error' });
    }
    return true;
  }
}
