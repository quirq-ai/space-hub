// Full-instance recovery is a separate, global operator surface. It never
// inherits authority from an org, project, agent, or work queue.
import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canonicalPath, InstanceVault } from './instancevault.ts';
import { InstanceConnections } from './instanceconnections.ts';
import { RelayError, type RelayOp, type SubhubRelay } from './subhubrelay.ts';

const PREFIX = '/-/api/instance-recovery';
export interface InstanceRecoveryDeps {
  vault: InstanceVault | null;
  authorize(req: http.IncomingMessage): Promise<boolean>;
  source: string;
  storage: string;
  containers: string[];
  restoreRoot: string;
  remote?: { url: string; token: string } | null;
  connections?: InstanceConnections;
  machineName?: string;
  relay?: SubhubRelay; // live questions to connected machines, for /subhub/<name>
}

// How long an operator waits for a machine: the page's own reads give up
// after 20 seconds, and verifying a backup reads it all.
const ASK_MS: Record<RelayOp, number> = { storage: 12_000, snapshot: 30_000, verify: 30 * 60_000 };

// A connected machine's page (/subhub/<name>): its last report, and when it
// is online, what it says about its storage right now.
async function subhub(deps: InstanceRecoveryDeps, res: http.ServerResponse, rest: string, method: string) {
  const connections = deps.connections ?? fail(503, 'Sub-hub connections are unavailable');
  const relay = deps.relay ?? fail(503, 'Live sub-hub views are not on for this hub');
  const m = /^\/([^/]+)(?:\/snapshots\/([a-f0-9]{32})(\/verify)?)?$/.exec(rest);
  if (!m) fail(404, 'No such sub-hub page');
  let name: string;
  try { name = decodeURIComponent(m[1]); } catch { fail(400, 'Invalid sub-hub name'); }
  const connection = connections.list().filter(item => item.name === name).sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? fail(404, `No sub-hub named ${name} has connected to this hub`);
  const op: RelayOp = m[3] ? 'verify' : m[2] ? 'snapshot' : 'storage';
  if ((op === 'verify') !== (method === 'POST') || (method !== 'GET' && method !== 'POST')) fail(405, 'Method not allowed');
  if (!connection.online) {
    if (op !== 'storage') fail(503, `${name} is offline; its storage can be read while it runs spacehub subhub run`);
    json(res, 200, { connection, live: null, error: `${name} is offline: this is its last report` }); return;
  }
  try {
    const answer = await relay.ask(connection.id, op, m[2], ASK_MS[op]);
    json(res, 200, op === 'storage' ? { connection, live: answer } : answer);
  } catch (error) {
    if (!(error instanceof RelayError)) throw error;
    if (op === 'storage') { json(res, 200, { connection, live: null, error: error.message }); return; }
    fail(error.status, error.message);
  }
}
export function recoveryRemote(url: string | undefined, token: string | undefined) {
  if (!url && !token) return null;
  if (!url || !token || token.length < 32) throw new Error('Full-instance recovery needs both a service URL and its private token');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw new Error('Recovery service URL must use HTTPS or loopback HTTP, without credentials');
  return { url: parsed.href.replace(/\/+$/, ''), token };
}
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage, limit = 8192): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, 'Recovery request is too large'); chunks.push(chunk); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid recovery request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a recovery request object');
  return value as Record<string, unknown>;
}
export function restoreTarget(root: string, requested: string) {
  if (!root) fail(503, 'Set SPACEHUB_RESTORE_ROOT to enable UI restores; the CLI can restore to a new directory');
  if (!requested || !path.isAbsolute(requested)) fail(400, 'Choose an absolute new directory inside the configured restore root');
  const resolvedRoot = canonicalPath(root), target = canonicalPath(requested);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail(400, 'Restore destination must be a new child of the configured restore root');
  for (let at = resolvedRoot; ; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) fail(400, 'Restore storage cannot use symlinks or junctions');
    if (path.dirname(at) === at) break;
  }
  return target;
}
function bearer(req: http.IncomingMessage) { return /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1]; }
function payloadPath(url: URL): string {
  const value = url.searchParams.get('path');
  if (url.searchParams.getAll('path').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'path') || !value || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) fail(400, 'Choose a relative file from the instance manifest');
  return value;
}
async function proxy(deps: InstanceRecoveryDeps, req: http.IncomingMessage, res: http.ServerResponse, route: string, query?: URLSearchParams) {
  const target = new URL(PREFIX.slice(1) + route, deps.remote!.url + '/');
  if (query) target.search = query.toString();
  const input = req.method === 'POST' ? route === '/restore' ? await body(req) : {} : undefined;
  let response: Response;
  try { response = await fetch(target, { method: req.method, redirect: 'error', signal: AbortSignal.timeout(30 * 60_000),
    headers: { authorization: `Bearer ${deps.remote!.token}`, ...(input ? { 'content-type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined }); }
  catch { fail(502, 'The full-instance backup source could not be reached'); }
  const file = /^\/source\/snapshots\/([a-f0-9]{32})\/file$/.exec(route);
  if (file && response.ok) {
    const size = response.headers.get('content-length'), sha256 = response.headers.get('x-spacehub-sha256');
    if (!size || !/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256) || response.headers.get('x-spacehub-snapshot') !== file[1] || !response.body) { await response.body?.cancel(); fail(502, 'The backup source returned invalid file metadata'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-sha256': sha256, 'x-spacehub-snapshot': file[1] });
    await pipeline(Readable.fromWeb(response.body as any), res); return;
  }
  const limit = /\/manifest$/.test(route) ? 64 * 1024 * 1024 : 2 * 1024 * 1024;
  const parts: Uint8Array[] = []; let size = 0;
  if (response.body) for await (const part of response.body as any) { size += part.length; if (size > limit) { await response.body.cancel().catch(() => {}); fail(502, 'Recovery service response is too large'); } parts.push(part); }
  let value: any;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(502, 'The Sub-hub returned an invalid recovery response'); }
  if (route === '/status' && response.ok && value && typeof value === 'object') value = { ...value, sourceAvailable: value.sourceAvailable ?? value.available === true };
  json(res, response.status, value);
}
export async function handleInstanceRecovery(deps: InstanceRecoveryDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
  try {
    const route = url.pathname.slice(PREFIX.length);
    const heartbeat = /^\/connections\/([a-f0-9]{32})\/heartbeat$/.exec(route);
    if (heartbeat && req.method === 'POST') {
      if (req.headers.origin || !bearer(req)) fail(403, 'Use the private Sub-hub machine credential');
      const connections = deps.connections ?? fail(503, 'Sub-hub connections are unavailable');
      json(res, 200, connections.heartbeat(heartbeat[1], bearer(req)!, await body(req, 256 * 1024))); return true;
    }
    const machine = /^\/connections\/([a-f0-9]{32})\/requests(?:\/([a-f0-9]{32}))?$/.exec(route);
    if (machine) {
      const token = bearer(req);
      if (req.headers.origin || !token || !deps.connections?.owns(machine[1], token)) fail(403, 'Use the private Sub-hub machine credential');
      const relay = deps.relay ?? fail(404, 'Live sub-hub views are not on for this hub');
      if (!machine[2] && req.method === 'GET') { json(res, 200, { requests: await relay.poll(machine[1], 25_000) }); return true; }
      if (machine[2] && req.method === 'POST') {
        try { relay.answer(machine[1], machine[2], await body(req, 8 * 1024 * 1024)); }
        catch (error) { if (error instanceof RelayError) fail(error.status, error.message); throw error; }
        json(res, 200, { ok: true }); return true;
      }
      fail(405, 'Method not allowed');
    }
    if (route.startsWith('/source/')) {
      const machine = !req.headers.origin && bearer(req) && deps.connections?.authorize(bearer(req)!);
      if (!machine && !(await deps.authorize(req))) fail(403, 'Full-instance source access requires a registered Sub-hub or hub operator');
      const manifest = /^\/source\/snapshots\/([a-f0-9]{32})\/manifest$/.exec(route), file = /^\/source\/snapshots\/([a-f0-9]{32})\/file$/.exec(route);
      if (req.method !== 'GET' || !(route === '/source/snapshots' || manifest || file)) fail(404, 'No such full-instance source action');
      const relative = file ? payloadPath(url) : undefined;
      if (deps.remote) { await proxy(deps, req, res, route, relative ? new URLSearchParams({ path: relative }) : undefined); return true; }
      const vault = deps.vault ?? fail(503, 'No full-instance backup source is configured');
      if (route === '/source/snapshots') { json(res, 200, { snapshots: vault.list() }); return true; }
      if (manifest) { json(res, 200, await vault.exportManifest(manifest[1])); return true; }
      const saved = await vault.openPayload(file![1], relative!);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': saved.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-spacehub-sha256': saved.sha256, 'x-spacehub-snapshot': file![1] });
      await pipeline(saved.stream, res); return true;
    }
    if (!(await deps.authorize(req))) fail(403, 'Full-instance recovery requires a hub operator; org ownership does not grant this access');
    if (route.startsWith('/subhubs/')) { await subhub(deps, res, route.slice('/subhubs'.length), req.method ?? 'GET'); return true; }
    if (route === '/connections') {
      const connections = deps.connections ?? fail(503, 'Sub-hub connections are unavailable');
      if (req.method === 'GET') { json(res, 200, { connections: connections.list() }); return true; }
      if (req.method === 'POST') {
        const input = await body(req);
        if (typeof input.name !== 'string' || ((input.id === undefined) !== (input.token === undefined)) || (input.id !== undefined && (typeof input.id !== 'string' || typeof input.token !== 'string'))) fail(400, 'Choose a machine name and valid optional enrollment');
        json(res, 200, connections.register(input.name, input.id === undefined ? undefined : { id: input.id as string, token: input.token as string })); return true;
      }
      fail(404, 'No such Sub-hub connection action');
    }
    if (deps.remote) {
      const allowed = (req.method === 'GET' && ['/status', '/snapshots'].includes(route)) || (req.method === 'POST' && (route === '/restore' || /^\/snapshots\/[a-f0-9]{32}\/verify$/.test(route)));
      if (!allowed) fail(404, 'No such full-instance recovery action');
      await proxy(deps, req, res, route); return true;
    }
    if (route === '/status' && req.method === 'GET') {
      json(res, 200, { scope: 'instance', source: deps.source, machineName: deps.machineName ?? os.hostname(), available: !!deps.vault, sourceAvailable: !!deps.vault, canManage: true,
        cli: { storage: deps.storage, restoreRoot: deps.restoreRoot },
        ...(!deps.vault ? { error: 'Connect a full-instance vault with SPACEHUB_RECOVERY_DIR, or open spacehub subhub serve on the recovery machine' } : {}),
        ...(!deps.vault ? { sourceError: 'No full-instance backup source is configured. Connected Sub-hubs will wait and retry automatically.' } : {}),
      }); return true;
    }
    const vault = deps.vault ?? fail(503, 'No full-instance backup vault is connected');
    if (route === '/snapshots' && req.method === 'GET') { json(res, 200, { snapshots: vault.list() }); return true; }
    const verify = /^\/snapshots\/([a-f0-9]{32})\/verify$/.exec(route);
    if (verify && req.method === 'POST') { json(res, 200, await vault.verify(verify[1])); return true; }
    if (route === '/restore' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id) || typeof input.directory !== 'string') fail(400, 'Choose a full-instance snapshot and a new restore directory');
      const directory = restoreTarget(deps.restoreRoot, input.directory);
      fs.mkdirSync(path.resolve(deps.restoreRoot), { recursive: true, mode: 0o700 });
      json(res, 200, await vault.restore(input.id, directory)); return true;
    }
    fail(404, 'No such full-instance recovery action');
  } catch (error: any) {
    const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
    if (!res.headersSent) json(res, status, { error: error.status ? error.message : status === 404 ? 'No such full-instance backup file' : 'Instance recovery failed' });
    else res.destroy();
    return true;
  }
}
