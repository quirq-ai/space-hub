// Parent-side control plane. The store is private, durable and single-writer;
// authorization stays with the hub, and nodes receive no builder credentials.
import type http from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SubhubStore } from './subhubstore.ts';

const PREFIX = '/-/api/subhubs';
const MAX_READ = 8 * 1024 * 1024;
const MAX_DRIVE = 16 * 1024 * 1024;
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
async function rawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) { req.resume(); fail(413, 'Drive files are limited to 16 MiB'); }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) fail(413, 'Drive files are limited to 16 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function boundedResponse(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail(502, 'Drive response exceeds its size limit'); }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) for await (const chunk of response.body as any) {
    length += chunk.length;
    if (length > limit) fail(502, 'Drive response exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    if (route === '/protocol' && req.method === 'GET') { json(res, 200, { version: 1, capabilities: ['backup', 'queue', 'immutable-read', 'active-drive', 'activity', 'node-settings'] }); return true; }
    const actor = async (space: string, owner = false) => (await deps.authorize(req, space, owner)) ?? fail(403, owner ? 'Space owner required' : 'Space membership required');
    const spaces = async () => {
      const requested = url.searchParams.get('space');
      if (requested) { await actor(requested); return [requested]; }
      const allowed = await Promise.all(store.spaces().map(async space => await deps.authorize(req, space, false) ? space : null));
      return allowed.filter((space): space is string => !!space);
    };
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
      const allowed = await spaces();
      json(res, 200, { nodes: allowed.flatMap(space => store.nodes(space)) }); return true;
    }
    if (route === '/activity' && req.method === 'GET') {
      const allowed = await spaces();
      json(res, 200, { activity: allowed.flatMap(space => store.activity(space)).sort((a, b) => b.at - a.at).slice(0, 200) }); return true;
    }
    const settingsRoute = /^\/nodes\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(route);
    if (settingsRoute && req.method === 'PATCH') {
      const input = await body(req);
      const owner = await actor(String(input.space ?? ''), true);
      const { space, ...changes } = input;
      json(res, 200, { node: store.updateNode(settingsRoute[1], space, changes, owner) }); return true;
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
    if (route === '/drive/files' || route === '/drive/file') {
      for (const key of url.searchParams.keys()) {
        if (!['space', 'node', 'path', 'prefix'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'Unsupported drive parameters');
      }
      const space = url.searchParams.get('space') ?? '';
      await actor(space);
      const node = store.nodes(space).find(item => item.id === url.searchParams.get('node')) ?? fail(404, 'No such sub-hub in this space');
      if (!node.enabled || node.mode !== 'drive') fail(409, 'Select an enabled active drive');
      if (!node.healthy || !node.url) fail(503, 'This drive is offline or has no reachable advertised URL');
      const listing = route === '/drive/files';
      const read = req.method === 'GET' || req.method === 'HEAD';
      if ((listing && req.method !== 'GET') || (!listing && !read && req.method !== 'PUT')) fail(405, 'Unsupported drive method');
      const filename = url.searchParams.get('path') ?? '';
      const prefix = url.searchParams.get('prefix') ?? '';
      const checkedPrefix = prefix.replace(/\/$/, '');
      if ((!listing && (!cleanPath(filename) || Buffer.byteLength(filename) > 4096 || /[\x00-\x1f\x7f:]/.test(filename))) || (listing && prefix && (!cleanPath(checkedPrefix) || Buffer.byteLength(prefix) > 4096 || /[\x00-\x1f\x7f:]/.test(prefix)))) fail(400, 'Use a relative drive file path');
      const target = new URL(listing ? 'v1/drive/files' : 'v1/drive/file', node.url.replace(/\/+$/, '') + '/');
      target.search = new URLSearchParams(listing ? (prefix ? { prefix } : {}) : { path: filename }).toString();
      const headers: Record<string, string> = { authorization: `Bearer ${store.nodeToken(node.id)}` };
      let upload: Buffer | undefined;
      if (req.method === 'PUT') {
        const match = req.headers['if-match'];
        const fresh = req.headers['if-none-match'];
        if (match && fresh) fail(400, 'Use one version precondition');
        if (typeof match === 'string' && /^(?:"[a-f0-9]{64}"|[a-f0-9]{64})$/.test(match)) headers['if-match'] = match;
        else if (fresh === '*') headers['if-none-match'] = '*';
        else fail(428, 'Upload requires If-None-Match: * or the existing file version in If-Match');
        upload = await rawBody(req, MAX_DRIVE);
        headers['content-type'] = 'application/octet-stream';
      }
      let response: Response;
      try { response = await (deps.fetch ?? fetch)(target, { method: req.method, headers, body: upload, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch { fail(502, 'The active drive could not be reached; data was not redirected to another node'); }
      const data = await boundedResponse(response, listing ? 4 * 1024 * 1024 : MAX_DRIVE);
      if (!response.ok) {
        let message = 'Active drive request failed';
        try { const parsed = JSON.parse(data.toString('utf8')); if (typeof parsed.error === 'string') message = parsed.error.slice(0, 500); } catch {}
        fail(response.status >= 400 && response.status < 600 ? response.status : 502, message);
      }
      if (listing || req.method === 'PUT') {
        let result: any;
        try { result = JSON.parse(data.toString('utf8')); } catch { fail(502, 'The drive returned invalid metadata'); }
        if (listing && !Array.isArray(result?.files)) fail(502, 'The drive returned invalid file metadata');
        if (upload && (result?.file?.path !== filename || result.file.size !== upload.length || result.file.sha256 !== createHash('sha256').update(upload).digest('hex'))) fail(502, 'The drive did not confirm the uploaded file');
        json(res, 200, result); return true;
      }
      const etag = response.headers.get('etag') ?? '';
      if (!/^"[a-f0-9]{64}"$/.test(etag) || (req.method !== 'HEAD' && createHash('sha256').update(data).digest('hex') !== etag.slice(1, -1))) fail(502, 'Drive file integrity check failed');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename.split('/').at(-1)!)}`, 'content-length': req.method === 'HEAD' ? response.headers.get('content-length') ?? '0' : data.length, etag, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-source': node.id });
      res.end(req.method === 'HEAD' ? undefined : data); return true;
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
