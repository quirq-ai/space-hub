// GitHub's device flow, for a hub with an OAuth App (signin.ts): the person
// opens github.com/login/device, types the code shown here and says yes, and
// GitHub hands this CLI a token made for that app with no scopes. Such a
// token reads only the public profile and acts as no one, so sending it to
// the hub (which asks GitHub whose it is) risks nothing on GitHub.
//
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// github.com, or a stand-in in tests (SPACEHUB_GITHUB_WEB).
export function githubWeb(env: NodeJS.ProcessEnv = process.env) {
  return (env.SPACEHUB_GITHUB_WEB ?? 'https://github.com').replace(/\/+$/, '');
}

async function post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'spacehub' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`could not reach ${new URL(url).origin}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new Error(`${new URL(url).origin} answered ${res.status} with no JSON`);
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

// Ask GitHub every `interval` seconds until the person said yes (the token),
// said no, or the code ran out. `sleep` is replaced in tests.
export async function deviceToken(
  web: string,
  clientId: string,
  code: DeviceCode,
  sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
): Promise<string> {
  let interval = Math.max(1, code.interval);
  const until = Date.now() + code.expires_in * 1000;
  for (;;) {
    await sleep(interval * 1000);
    const body = await post(`${web}/login/oauth/access_token`, {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof body.access_token === 'string' && body.access_token) return body.access_token;
    switch (body.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval = Number(body.interval) || interval + 5;
        break;
      case 'access_denied':
        throw new Error('sign-in was cancelled on GitHub; nothing was sent to the hub');
      case 'expired_token':
        throw new Error('the code ran out before it was entered; run spacehub auth login again');
      default:
        throw new Error(`GitHub refused the sign-in: ${body.error_description ?? body.error ?? 'no token'}`);
    }
    if (Date.now() > until) throw new Error('the code ran out before it was entered; run spacehub auth login again');
  }
}
