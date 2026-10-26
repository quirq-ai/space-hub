// The web service acting as the hub admin (the identity that owns the
// database, whose token the entrypoint hands it), over SpacetimeDB's HTTP API
// on the internal port: SQL reads of private tables, reducer calls and new
// identities. Shared by the xo API (xo.ts) and GitHub sign-in (signin.ts),
// with their small JSON-over-HTTP helpers.
import http from 'node:http';

const MAX_BODY = 512 * 1024;

export interface AdminHttp {
  adminToken: string; // the database owner's token
  http: string; // SpacetimeDB's HTTP API inside the container
  db: string;
}

// An answer for the caller: its HTTP status and message.
export class Reply extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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

// A refusal from the module comes back as status 530 with its message.
export async function stdb(cfg: AdminHttp, path: string, body: string, contentType: string): Promise<string> {
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
export async function select(cfg: AdminHttp, query: string): Promise<Record<string, unknown>[]> {
  const out = JSON.parse(await stdb(cfg, `/v1/database/${encodeURIComponent(cfg.db)}/sql`, query, 'text/plain'));
  const first = Array.isArray(out) ? out[0] : null;
  const names: string[] = (first?.schema?.elements ?? []).map((e: { name?: unknown }) =>
    typeof e.name === 'string' ? e.name : ((e.name as { some?: string } | undefined)?.some ?? '')
  );
  return (first?.rows ?? []).map((row: unknown[]) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

export function call(cfg: AdminHttp, reducer: string, args: unknown[]) {
  return stdb(cfg, `/v1/database/${encodeURIComponent(cfg.db)}/call/${reducer}`, JSON.stringify(args), 'application/json');
}

// A new identity and its token, for a builder the admin makes.
export async function newIdentity(cfg: AdminHttp): Promise<{ identity: string; token: string }> {
  const made = JSON.parse(await stdb(cfg, '/v1/identity', '', 'application/json'));
  if (typeof made?.identity !== 'string' || typeof made?.token !== 'string') throw new Reply(502, 'the hub did not make an identity');
  return { identity: made.identity, token: made.token };
}
