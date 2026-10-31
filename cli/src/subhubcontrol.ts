// Parent-side control plane. The store is private, durable and single-writer;
// authorization stays with the hub, and nodes receive no builder credentials.
import type http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SubhubStore } from './subhubstore.ts';

const PREFIX = '/-/api/subhubs';
const MAX_READ = 8 * 1024 * 1024;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const OID = /^[a-f0-9]{40}$/;
export interface SubhubControlDeps {
  authorize(req: http.IncomingMessage, space: string, owner: boolean): Promise<string | null>;
  currentHead(project: string): Promise<string | null>;
  localRead(project: string, oid: string, filename: string, req: http.IncomingMessage): Promise<Response>;
  fetch?: typeof fetch;
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage): Promise<any> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'Send JSON');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) fail(413, 'Request too large');
    parts.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { fail(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a JSON object');
  return value;
}
function bearer(req: http.IncomingMessage) { return /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''; }
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function cleanPath(value: string) {
  return value && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

export async function handleSubhubControl(store: SubhubStore | null, deps: SubhubControlDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
  try {
    if (!store) fail(503, 'Sub-hubs are disabled; configure SPACEHUB_SUBHUB_DIR on the parent');
    const route = url.pathname.slice(PREFIX.length);
    if (route === '/protocol' && req.method === 'GET') { json(res, 200, { version: 1, capabilities: ['backup', 'queue', 'immutable-read'] }); return true; }
    const actor = async (space: string, owner = false) => (await deps.authorize(req, space, owner)) ?? fail(403, owner ? 'Space owner required' : 'Space membership required');
    const nodeAuth = (id: string) => {
      if (req.headers.origin) fail(403, 'Node APIs do not accept browser requests');
      const token = bearer(req);
      if (!store.authenticateNode(id, token)) fail(401, 'Invalid node credential');
      return token;
    };
    if (route === '/nodes/register' && req.method === 'POST') {
      const input = await body(req);
      const owner = await actor(String(input.space ?? ''), true);
      json(res, 201, store.register(input, owner)); return true;
    }
    if (route === '/nodes' && req.method === 'GET') {
      const space = url.searchParams.get('space') ?? '';
      await actor(space); json(res, 200, { nodes: store.nodes(space) }); return true;
    }
    const nodeRoute = /^\/nodes\/([a-z0-9][a-z0-9_-]{0,63})\/(heartbeat|work|receipt)$/.exec(route);
    if (nodeRoute) {
      const [, id, action] = nodeRoute;
      const token = nodeAuth(id);
      if (action === 'heartbeat' && req.method === 'POST') { json(res, 200, store.heartbeat(id, token, await body(req))); return true; }
      if (action === 'work' && req.method === 'GET') { json(res, 200, { work: store.assignments(id, token) }); return true; }
      if (action === 'receipt' && req.method === 'POST') { const input = await body(req); json(res, 200, { work: store.receipt(id, token, input.ids) }); return true; }
      fail(405, 'Unsupported method');
    }
    if (route === '/work') {
      if (req.method === 'POST') {
        const input = await body(req);
        const name = await actor(String(input.space ?? ''));
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !key.trim()) fail(400, 'Idempotency-Key is required');
        json(res, 202, { work: store.enqueue({ ...input, idempotencyKey: key }, name) }); return true;
      }
      if (req.method === 'GET') {
        const space = url.searchParams.get('space') ?? '';
        await actor(space); json(res, 200, { work: store.listWork(space) }); return true;
      }
    }
    const workRoute = /^\/work\/([A-Za-z0-9-]{1,128})(?:\/(claim|complete|release))?$/.exec(route);
    if (workRoute) {
      const [, id, action] = workRoute;
      const work = store.work(id) ?? fail(404, 'No such work item');
      const worker = await actor(work.space);
      if (!action && req.method === 'GET') { json(res, 200, { work }); return true; }
      if (req.method !== 'POST') fail(405, 'Unsupported method');
      const input = await body(req);
      if (action === 'claim') { json(res, 200, { work: store.claim(id, worker, input.leaseSeconds ?? 60) }); return true; }
      if (action === 'complete') { json(res, 200, { work: store.complete(id, worker, input.fence, input.result) }); return true; }
      if (action === 'release') { json(res, 200, { work: store.release(id, worker, input.fence) }); return true; }
    }
    if (route === '/read' && (req.method === 'GET' || req.method === 'HEAD')) {
      for (const key of url.searchParams.keys()) {
        if (!['project', 'oid', 'path'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'Unsupported read parameters');
      }
      const project = url.searchParams.get('project') ?? '';
      const filename = url.searchParams.get('path') ?? '';
      if (!PROJECT.test(project) || !cleanPath(filename)) fail(400, 'Invalid project or file path');
      const oid = url.searchParams.get('oid') || await deps.currentHead(project) || '';
      if (!OID.test(oid)) fail(404, 'Project has no readable commit');
      const selected = !req.headers.range && store.route(project, oid);
      if (selected) {
        try {
          const target = new URL('v1/file', selected.url.replace(/\/+$/, '') + '/');
          target.search = new URLSearchParams({ project, oid, snapshot: selected.snapshot, path: filename }).toString();
          const response = await (deps.fetch ?? fetch)(target, {
            method: req.method, redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${store.nodeToken(selected.nodeId)}` },
          });
          if (!response.ok || response.headers.get('x-spacehub-oid') !== oid || response.headers.get('x-spacehub-snapshot') !== selected.snapshot || Number(response.headers.get('content-length') ?? 0) > MAX_READ) {
            await response.body?.cancel(); throw new Error('Replica is not current or exceeds the read limit');
          }
          const parts: Uint8Array[] = [];
          let length = 0;
          if (response.body && req.method !== 'HEAD') {
            for await (const part of response.body as any) { length += part.length; if (length > MAX_READ) throw new Error('Replica file too large'); parts.push(part); }
          }
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-source': selected.nodeId, 'x-spacehub-oid': oid });
          res.end(req.method === 'HEAD' ? undefined : Buffer.concat(parts)); return true;
        } catch { /* A missing, stale or unreachable node falls back to the authority. */ }
      }
      const response = await deps.localRead(project, oid, filename, req);
      const safeHeaders: Record<string, string> = {};
      for (const name of ['content-range', 'accept-ranges', 'content-length', 'etag']) { const value = response.headers.get(name); if (value) safeHeaders[name] = value; }
      res.writeHead(response.status, { ...safeHeaders, 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-source': 'parent', 'x-spacehub-oid': oid });
      if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); }
      else await pipeline(Readable.fromWeb(response.body as any), res);
      return true;
    }
    fail(404, 'No such sub-hub route');
  } catch (error: any) {
    if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'Sub-hub request failed' });
    else res.destroy();
    return true;
  }
}
