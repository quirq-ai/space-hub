// Full-instance recovery is a separate, global operator surface. It never
// inherits authority from an org, project, agent, or work queue.
import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { InstanceVault } from './instancevault.ts';

const PREFIX = '/-/api/instance-recovery';
export interface InstanceRecoveryDeps {
  vault: InstanceVault | null;
  authorize(req: http.IncomingMessage): Promise<boolean>;
  source: string;
  storage: string;
  containers: string[];
  restoreRoot: string;
  remote?: { url: string; token: string } | null;
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
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) fail(413, 'Recovery request is too large'); chunks.push(chunk); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid recovery request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a recovery request object');
  return value as Record<string, unknown>;
}
export function restoreTarget(root: string, requested: string) {
  if (!root) fail(503, 'Set SPACEHUB_RESTORE_ROOT to enable UI restores; the CLI can restore to a new directory');
  if (!requested || !path.isAbsolute(requested)) fail(400, 'Choose an absolute new directory inside the configured restore root');
  const resolvedRoot = path.resolve(root), target = path.resolve(requested);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail(400, 'Restore destination must be a new child of the configured restore root');
  for (let at = resolvedRoot; ; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) fail(400, 'Restore storage cannot use symlinks or junctions');
    if (path.dirname(at) === at) break;
  }
  return target;
}
export async function handleInstanceRecovery(deps: InstanceRecoveryDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
  try {
    if (!(await deps.authorize(req))) fail(403, 'Full-instance recovery requires a hub operator; org ownership does not grant this access');
    const route = url.pathname.slice(PREFIX.length);
    if (deps.remote) {
      const allowed = (req.method === 'GET' && ['/status', '/snapshots'].includes(route)) || (req.method === 'POST' && (route === '/restore' || /^\/snapshots\/[a-f0-9]{32}\/verify$/.test(route)));
      if (!allowed) fail(404, 'No such full-instance recovery action');
      const input = req.method === 'POST' ? route === '/restore' ? await body(req) : {} : undefined;
      const target = new URL('' + PREFIX.slice(1) + route, deps.remote.url + '/');
      let response: Response;
      try { response = await fetch(target, { method: req.method, redirect: 'error', signal: AbortSignal.timeout(10 * 60_000),
        headers: { authorization: `Bearer ${deps.remote.token}`, ...(input ? { 'content-type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined }); }
      catch { fail(502, 'The full-instance Sub-hub could not be reached'); }
      const parts: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const part of response.body as any) { size += part.length; if (size > 2 * 1024 * 1024) fail(502, 'Recovery service response is too large'); parts.push(part); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(502, 'The Sub-hub returned an invalid recovery response'); }
      json(res, response.status, value); return true;
    }
    if (route === '/status' && req.method === 'GET') {
      json(res, 200, { scope: 'instance', source: deps.source, available: !!deps.vault, canManage: true,
        cli: { containers: deps.containers, storage: deps.storage, restoreRoot: deps.restoreRoot },
        ...(!deps.vault ? { error: 'Connect a full-instance vault with SPACEHUB_RECOVERY_DIR, or open spacehub subhub serve on the recovery machine' } : {}),
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
    if (!res.headersSent) json(res, error.status ?? 400, { error: error.message ?? 'Instance recovery failed' });
    else res.destroy();
    return true;
  }
}
