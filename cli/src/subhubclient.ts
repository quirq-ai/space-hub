import { normalizeServer } from './config.ts';

export function parentWeb(server: string) {
  const url = new URL(normalizeServer(server).replace(/^ws/, 'http'));
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Parent must be a hub origin without credentials or a path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Parent must use HTTPS (or local HTTP)');
  return url.origin;
}

export class SubhubClient {
  base: string;
  token: string;
  constructor(server: string, token: string) { this.base = parentWeb(server); this.token = token; }
  async request(method: string, route: string, value?: unknown, idempotency?: string): Promise<any> {
    const response = await fetch(this.base + '/-/api/subhubs' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.token}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...(idempotency ? { 'idempotency-key': idempotency } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) throw new Error(answer?.error ?? `Parent does not support sub-hubs (HTTP ${response.status}); deploy the updated parent first`);
    return answer;
  }
  async protocol(capability?: string) {
    const value = await this.request('GET', '/protocol');
    if (value.version !== 1) throw new Error('Update this CLI to match the parent sub-hub protocol');
    if (capability && !value.capabilities?.includes(capability)) throw new Error(`The parent needs an update for ${capability}`);
  }
}
