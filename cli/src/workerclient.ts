// The Worker Protocol (worker/1): how space-hub reaches a runner, whatever runs the workers behind it
// (docs/specs/2026-11-03-workers-on-your-own-runners-design.md §5). Nothing here knows a vendor.
//
//   GET    /api/worker                  describe: {protocol, name, kind, capabilities}; without a token, only
//                                       {protocol, capabilities} (enough to offer Connect)
//   POST   /api/connect/token {code, codeVerifier, redirectUri}   Connect: swap the owner's approval for a token
//   DELETE /api/tokens/self             Disconnect: the token revokes itself
//   POST   /api/tasks {text, title?, repo?}   start (Idempotency-Key)
//   GET    /api/tasks/:id               {task, result}
//   GET    /api/tasks/:id/events?after=N
//   POST   /api/tasks/:id/messages {text}     follow up (Idempotency-Key)
//   POST   /api/tasks/:id/stop
//   DELETE /api/tasks/:id               tear down
//
// Errors come back as RunnerError, already worded for the person and with the token removed.
export const PROTOCOL = 'worker/1';
const TIMEOUT_MS = 20_000;

export type Capabilities = { followUp: boolean; stop: boolean; events: boolean; repo: boolean; connect: boolean };
export type Describe = { protocol: string; name: string; kind: string; capabilities: Capabilities };
export const CAPABILITY_KEYS = ['followUp', 'stop', 'events', 'repo', 'connect'] as const;

export class RunnerError extends Error {
  status: number; // what space-hub should answer
  auth: boolean; // the runner refused the token
  constructor(status: number, message: string, auth = false) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

/** Removes the exact token, any hub_… token and any bearer value from text that came from a runner. */
export function redactToken(text: string, token: string): string {
  let out = token ? text.split(token).join('[redacted]') : text;
  out = out.replace(/\bBearer\s+(?!\[redacted\])\S+/gi, 'Bearer [redacted]');
  return out.replace(/\bhub_[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/**
 * A runner's address: https; http to this machine only when `allowLocal` (local development), so people
 * on a deployed hub cannot point it at its own internal ports. Without a trailing slash.
 */
export function checkRunnerUrl(raw: string, allowLocal = false): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new RunnerError(400, 'Use an https:// address.');
  }
  const local = allowLocal && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new RunnerError(400, 'Use an https:// address.');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function capabilitiesOf(value: unknown): Capabilities {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(CAPABILITY_KEYS.map(k => [k, v[k] === true])) as Capabilities;
}

/** A runner at `url`, called with `token` ("" before there is one: the public description and Connect's swap). */
export function runner(url: string, token: string, fetchImpl: typeof fetch = fetch) {
  const host = (() => { try { return new URL(url).host; } catch { return 'The runner'; } })();

  async function call(method: string, path: string, body?: unknown, key?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Never follow a runner somewhere else: the address was checked, where it points was not.
        redirect: 'manual',
      });
    } catch {
      throw new RunnerError(502, `${host} did not answer. Try again in a moment.`);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new RunnerError(502, `${host} answered with a redirect. Connect the address it points to instead.`);
    }
    let data: unknown = null;
    try { data = await response.json(); } catch { /* empty or not JSON */ }
    if (response.ok) return data ?? {};
    const said = redactToken(data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '', token);
    const s = response.status;
    if (s === 401 || s === 403) throw new RunnerError(502, 'That token is not valid for this runner. Connect it again in Settings.', true);
    if (s === 404) throw new RunnerError(404, 'This worker has ended and was torn down.');
    if (s === 400 || s === 409 || s === 422 || s === 429) throw new RunnerError(s, said || `The runner said no (${s}).`);
    throw new RunnerError(502, said || `The runner could not do this right now (${s}).`);
  }

  const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
  return {
    async describe(): Promise<Describe> {
      const d = (await call('GET', '/api/worker')) as Record<string, unknown>;
      const protocol = typeof d.protocol === 'string' ? d.protocol : '';
      if (protocol !== PROTOCOL) throw new RunnerError(400, `This runner speaks ${protocol || 'no known protocol'}; update space-hub.`);
      return {
        protocol,
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 80) : host,
        kind: typeof d.kind === 'string' && d.kind.trim() ? d.kind.trim().slice(0, 80) : 'Runner',
        capabilities: capabilitiesOf(d.capabilities),
      };
    },
    list: () => call('GET', '/api/tasks'),
    start: (input: { text: string; title?: string; repo?: string }, key: string) => call('POST', '/api/tasks', input, key),
    get: (id: string) => call('GET', task(id)),
    events: (id: string, after: number) => call('GET', `${task(id)}/events?after=${Math.max(0, Math.floor(after) || 0)}`),
    followUp: (id: string, text: string, key: string) => call('POST', `${task(id)}/messages`, { text }, key),
    stop: (id: string) => call('POST', `${task(id)}/stop`),
    teardown: (id: string) => call('DELETE', task(id)),
    /** Connect: the one-time code from the owner's approval, swapped for a token (called without one). */
    async exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<string> {
      const out = (await call('POST', '/api/connect/token', input)) as { token?: unknown };
      if (typeof out.token !== 'string' || !out.token || out.token.length > 1000) throw new RunnerError(502, `${host} did not send a token.`);
      return out.token;
    },
    /** Disconnect: this token revokes itself on the runner. */
    revokeSelf: () => call('DELETE', '/api/tokens/self'),
  };
}

export type Runner = ReturnType<typeof runner>;
