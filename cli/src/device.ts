// GitHub's device flow, run by the hub for its OAuth App (signin.ts): the hub
// asks GitHub for a code, the CLI shows it, the person enters it on
// github.com and says yes, and the hub, polling GitHub with the device code
// only it holds, receives a token with no scopes. The token never leaves the
// hub, so no other server can be handed it to replay here.
//
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

function local(host: string) {
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/.test(host);
}

// github.com, or a stand-in on this machine in tests (SPACEHUB_GITHUB_WEB):
// https, or plain http to a local host only.
export function githubWeb(env: NodeJS.ProcessEnv = process.env) {
  const web = (env.SPACEHUB_GITHUB_WEB ?? 'https://github.com').replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(web);
  } catch {
    throw new Error(`SPACEHUB_GITHUB_WEB is not a URL: ${web}`);
  }
  if (u.username || u.password || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && local(u.host)))) {
    throw new Error('SPACEHUB_GITHUB_WEB must be an https origin, or http on this machine');
  }
  return u.origin;
}

async function post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'spacehub' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('GitHub did not answer; try again');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new Error(`GitHub answered ${res.status} with no JSON`);
  return body;
}

export async function deviceCode(web: string, clientId: string): Promise<DeviceCode> {
  const body = await post(`${web}/login/device/code`, { client_id: clientId, scope: '' });
  if (typeof body.error === 'string') {
    const hint = body.error === 'device_flow_disabled' ? " (the hub's GitHub OAuth App needs \"Enable Device Flow\" ticked)" : '';
    throw new Error(`GitHub refused to start sign-in: ${body.error_description ?? body.error}${hint}`);
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
    throw new Error('GitHub sent no sign-in code');
  }
  return { device_code, user_code, verification_uri, expires_in: Number(expires_in) || 900, interval: Number(interval) || 5 };
}

export type Poll =
  | { kind: 'token'; token: string }
  | { kind: 'pending'; interval?: number } // interval: GitHub asked to slow down
  | { kind: 'denied' }
  | { kind: 'expired' };

// One question to GitHub: has the person said yes yet?
export async function pollToken(web: string, clientId: string, code: string): Promise<Poll> {
  const body = await post(`${web}/login/oauth/access_token`, {
    client_id: clientId,
    device_code: code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (typeof body.access_token === 'string' && body.access_token) return { kind: 'token', token: body.access_token };
  switch (body.error) {
    case 'authorization_pending':
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'pending', interval: Number(body.interval) || undefined };
    case 'access_denied':
      return { kind: 'denied' };
    case 'expired_token':
      return { kind: 'expired' };
    default:
      throw new Error(`GitHub refused the sign-in: ${body.error_description ?? body.error ?? 'no token'}`);
  }
}
