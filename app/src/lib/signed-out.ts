/**
 * Leaving the hub when it signs this viewer out: the one place the app handles it. The front door
 * (cli/src/frontdoor.ts) answers every request of a viewer who is no longer a member with a 401 that carries
 * DENIED_HEADER: a builder the owner just suspended, or a session that no longer signs in. Any route's own 401
 * ("Sign in to ...") means the same once this viewer was signed in. watchFetch sees every answer the app gets,
 * so no page has to: on such an answer it marks the viewer as leaving (views waiting for data show that instead
 * of loading forever) and goes to the sign-in page with the reason. The sign-in page (GET /-/login) drops a
 * suspended builder's cookie and says why. Pure but for watchFetch and leave, so it is tested
 * (test/signed-out.test.ts).
 */

/** Set by the front door on every refusal (cli/src/frontdoor.ts DENIED_HEADER). */
export const DENIED_HEADER = "x-spacehub-members-only";

/** Why the app is leaving: the owner suspended this builder, or the session ended (cli/src/livepage.ts). */
export type SignedOutReason = "suspended" | "signed-out";

/**
 * Whether an answer means this viewer's session is over: a front-door refusal, or this hub's own 401 while
 * signed in (`origin`: the page's; another site's 401 is about that site).
 */
export function endsSession(response: { status: number; url: string; headers: { get(name: string): string | null } }, signedIn: boolean, origin: string): boolean {
  if (response.status !== 401) return false;
  if (response.headers.get(DENIED_HEADER) !== null) return true;
  try { return signedIn && new URL(response.url, origin).origin === origin; } catch { return false; }
}

/** The sign-in page, with why the viewer is there and where to come back to. */
export function loginUrl(reason: SignedOutReason, next: string): string {
  const back = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/-/login") ? next : "/";
  return `/-/login?reason=${reason}&next=${encodeURIComponent(back)}`;
}

/** What the app shows while it leaves. */
export function leavingText(reason: SignedOutReason): string {
  return reason === "suspended" ? "Your access to this hub was suspended by its owner." : "Sign in to continue.";
}

// Whether the viewer is signed in, as /-/api/me said (hooks/use-me.ts), and why the app is leaving, once it is.
let signedIn = false;
let leaving: SignedOutReason | null = null;
const listeners = new Set<() => void>();

export function setSignedIn(on: boolean) { signedIn = on; }
export function leavingReason(): SignedOutReason | null { return leaving; }
export function onLeaving(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Leave for the sign-in page, once: whatever asks after the first is already on its way. */
export function leave(reason: SignedOutReason, go: (url: string) => void = url => location.assign(url)) {
  if (leaving) return;
  leaving = reason;
  signedIn = false;
  listeners.forEach(listener => listener());
  go(loginUrl(reason, location.pathname + location.search + location.hash));
}

/**
 * Watch every answer the app's fetch gets (installed once, main.tsx), and leave on one that ends the session.
 * The answer still reaches its caller, which shows an error as before for the moment the page takes to go.
 */
export function watchFetch(target: { fetch: typeof fetch } = globalThis) {
  const inner = target.fetch.bind(target);
  target.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await inner(...args);
    if (endsSession(response, signedIn, location.origin)) leave("signed-out");
    return response;
  };
}

/** For tests: back to a fresh page's state. */
export function resetSignedOut() { signedIn = false; leaving = null; listeners.clear(); }
