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
// xo tables as the hub admin (the identity that owns the database, whose token
// the entrypoint hands it), over SpacetimeDB's HTTP API on the internal port.
import http from 'node:http';
import crypto from 'node:crypto';

const PREFIX = '/-/api/xo/v1/';
const MAX_BODY = 512 * 1024;
// Clerk user ids (user_2abc...); the same rule as the module's, so an id can
// go into a SQL literal as it is.
const SUBJECT = /^[A-Za-z0-9_]{1,64}$/;

export interface XoConfig {
  key: string; // shared with xo.quirq.dev
  adminToken: string; // the database owner's token
  http: string; // SpacetimeDB's HTTP API inside the container
  db: string;
}

export function xoConfig(db: string): XoConfig | null {
  const key = process.env.SPACEHUB_XO_KEY ?? '';
  if (!key) return null;
  const adminToken = process.env.SPACEHUB_ADMIN_TOKEN ?? '';
  if (!adminToken) throw new Error('SPACEHUB_XO_KEY is set but SPACEHUB_ADMIN_TOKEN is not: the xo API needs the hub admin');
  if (key.length < 32) throw new Error('SPACEHUB_XO_KEY must be at least 32 characters');
  return { key, adminToken, http: (process.env.SPACEHUB_INTERNAL_HTTP ?? 'http://127.0.0.1:3001').replace(/\/+$/, ''), db };
}

class Reply extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req: http.IncomingMessage, key: string) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Reply(413, `body is larger than ${MAX_BODY} bytes`);
    parts.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Reply(400, 'body must be JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Reply(400, 'body must be a JSON object');
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------- SpacetimeDB over HTTP

async function stdb(cfg: XoConfig, path: string, body: string, contentType: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${cfg.http}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.adminToken}`, 'content-type': contentType },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Reply(502, 'the hub database did not answer');
  }
  const text = await resp.text();
  if (!resp.ok) throw new Reply(resp.status === 401 || resp.status === 403 ? 502 : 530, text.slice(0, 300) || `database answered ${resp.status}`);
  return text;
}

// Rows of a one-statement SELECT, as objects keyed by column name.
async function select(cfg: XoConfig, query: string): Promise<Record<string, unknown>[]> {
  const out = JSON.parse(await stdb(cfg, `/v1/database/${encodeURIComponent(cfg.db)}/sql`, query, 'text/plain'));
  const first = Array.isArray(out) ? out[0] : null;
  const names: string[] = (first?.schema?.elements ?? []).map((e: { name?: unknown }) =>
    typeof e.name === 'string' ? e.name : ((e.name as { some?: string } | undefined)?.some ?? '')
  );
  return (first?.rows ?? []).map((row: unknown[]) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

function call(cfg: XoConfig, reducer: string, args: unknown[]) {
  return stdb(cfg, `/v1/database/${encodeURIComponent(cfg.db)}/call/${reducer}`, JSON.stringify(args), 'application/json');
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

async function agentOf(cfg: XoConfig, subject: string) {
  const [row] = await select(cfg, `SELECT username, token FROM xo_agent WHERE subject = '${subject}'`);
  return row ? { agent: String(row.username), token: String(row.token) } : null;
}

async function ensureAgent(cfg: XoConfig, subject: string, body: Record<string, unknown>) {
  const found = await agentOf(cfg, subject);
  if (found) return found;
  const username = body.username;
  if (typeof username !== 'string' || !username) throw new Reply(400, '"username" is required');
  const made = JSON.parse(await stdb(cfg, '/v1/identity', '', 'application/json'));
  if (typeof made?.identity !== 'string' || typeof made?.token !== 'string') throw new Reply(502, 'the hub did not make an identity');
  try {
    await call(cfg, 'xo_link_agent', [subject, username, made.identity, made.token]);
  } catch (err) {
    // Another request made it first: that one stands.
    const raced = await agentOf(cfg, subject);
    if (raced) return raced;
    if (err instanceof Reply && /is taken|is reserved|agent name/.test(err.message)) throw new Reply(409, err.message);
    throw err;
  }
  return { agent: username, token: made.token as string };
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
    if (err instanceof Reply) json(res, err.status, { error: err.message });
    else {
      process.stderr.write(`spacehub-web: xo api: ${err instanceof Error ? err.message : String(err)}\n`);
      json(res, 500, { error: 'internal error' });
    }
    return true;
  }
}
