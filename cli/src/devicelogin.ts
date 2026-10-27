// The CLI's side of a hub's device sign-in (signin.ts): ask the hub for a
// GitHub code, show it, then ask the hub until GitHub has said yes. GitHub
// gives the token to the hub; it never passes through here.

async function postHub(url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`could not reach ${url}`);
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const seconds = (value: unknown, fallback: number) => Math.min(Math.max(Number(value) || fallback, 1), 60);

// The hub's answer once signed in ({builder, token, created}), or null when
// the hub has no GitHub OAuth App (an older hub, or one without an app), so
// sign-in sends gh's token instead. Only a 404 means that: any other failure
// stops here, so a hub that is down never gets gh's token by accident.
export async function deviceSignIn(
  web: string,
  host: string,
  note: (line: string) => void,
  // Runs before the code is shown; throws to stop (a hub that is not the default asks first).
  confirm: () => Promise<void> = async () => {},
  sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
): Promise<Record<string, unknown> | null> {
  const start = await postHub(`${web}/-/api/auth/github/device`);
  if (start.status === 404) return null;
  const b = start.body;
  if (start.status !== 200 || !b) throw new Error(String(b?.error ?? `GitHub sign-in failed to start (HTTP ${start.status})`));
  const { session, user_code: code, verification_uri: uri } = b;
  // The hub names what to show: only GitHub's own page and a plain code are shown.
  let page: URL | null = null;
  try {
    page = typeof uri === 'string' ? new URL(uri) : null;
  } catch {}
  if (typeof session !== 'string' || typeof code !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(code) || page?.origin !== 'https://github.com') {
    throw new Error(`${host} sent a sign-in that is not GitHub's; nothing was done`);
  }
  await confirm();
  note(`To sign in to ${host} with GitHub, open ${page.href} and enter the code ${code}`);
  note(`(${host} gets your GitHub login and nothing else: no access to your repositories)`);
  let wait = seconds(b.interval, 5);
  for (;;) {
    await sleep(wait * 1000);
    const poll = await postHub(`${web}/-/api/auth/github/device/poll`, { session });
    if (poll.status !== 200 || !poll.body) throw new Error(String(poll.body?.error ?? `GitHub sign-in failed (HTTP ${poll.status})`));
    if (poll.body.status === 'done') return poll.body;
    if (poll.body.status !== 'pending') throw new Error(`${host} answered the sign-in with something unexpected`);
    wait = seconds(poll.body.interval, wait);
  }
}
