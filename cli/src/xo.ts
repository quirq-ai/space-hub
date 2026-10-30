// xo.quirq.dev's door to the hub, served by the web service at /-/api/xo/v1/.
// xo.quirq.dev checks who a user is with Clerk, then keeps what xo knows about
// them (projects, spaces and their refs, invites) here, and asks here for the
// hub agent its users push with:
//
//   GET  records/<clerk user id>   {"version": N, "doc": {...} | null}
//   PUT  records/<clerk user id>   {"version": N, "doc": {...}}: written only if the record is
//                                  still at version N (0: there is none yet); 409 otherwise
//   POST agents/<clerk user id>    {"username": "suraj"}: the user's agent, made on first
//                                  call: {"agent": "suraj", "token": "..."}
//
// Every request carries `Authorization: Bearer $SPACEHUB_XO_KEY`; without that
// variable the routes do not exist. The service reads and writes the private
// xo tables as the hub admin (admin.ts).
import http from 'node:http';
import crypto from 'node:crypto';
import { type AdminHttp, call, json, newIdentity, readJson, Reply, select } from './admin.ts';

const PREFIX = '/-/api/xo/v1/';
// Clerk user ids (user_2abc...); the same rule as the module's, so an id can
// go into a SQL literal as it is.
const SUBJECT = /^[A-Za-z0-9_]{1,64}$/;

export interface XoConfig extends AdminHttp {
  key: string; // shared with xo.quirq.dev
}

// `http` is SpacetimeDB's HTTP API, as the rest of the web service reaches it.
export function xoConfig(db: string, http: string): XoConfig | null {
  const key = process.env.SPACEHUB_XO_KEY ?? '';
  if (!key) return null;
  const adminToken = process.env.SPACEHUB_ADMIN_TOKEN ?? '';
  if (!adminToken) throw new Error('SPACEHUB_XO_KEY is set but SPACEHUB_ADMIN_TOKEN is not: the xo API needs the hub admin');
  if (key.length < 32) throw new Error('SPACEHUB_XO_KEY must be at least 32 characters');
  return { key, adminToken, http, db };
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

// The hub agent xo made for this xo user, with its token (also xosignin.ts).
export async function agentOf(cfg: XoConfig, subject: string) {
  const [row] = await select(cfg, `SELECT username, token FROM xo_agent WHERE subject = '${subject}'`);
  return row ? { agent: String(row.username), token: String(row.token) } : null;
}

async function ensureAgent(cfg: XoConfig, subject: string, body: Record<string, unknown>) {
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
