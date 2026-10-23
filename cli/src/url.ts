// Hub URLs. A hub remote is always called "quirq" and always points at a
// quirq URL:
//
//   quirq://hub.quirq.dev/alice/notes   a space on a named hub
//   quirq://alice/notes                 a space on the hub you are logged in to
//                                       (hub.quirq.dev unless you chose another)
//
// URLs we write always name the host, so a clone keeps working whatever server
// the CLI is logged in to later. spacehub://owner/name URLs from older clones
// are still read (like quirq://owner/name), never written.
export const SCHEME = 'quirq';
export const REMOTE = 'quirq';

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/;
const PART = /^[^/\s:@]+$/;

export interface HubUrl {
  // ws:// or wss:// address of the hub, from the URL's host; absent when the
  // URL names none (use the configured server).
  server?: string;
  // owner/name
  space: string;
}

// This machine only: the whole host (and an optional port), never a prefix,
// so localhost.example.com or 127.evil.com still get wss://.
function local(host: string) {
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/.test(host);
}

// The websocket address for a host: plain ws:// only on this machine.
export function serverOfHost(host: string): string {
  return `${local(host) ? 'ws' : 'wss'}://${host}`;
}

export function hostOfServer(server: string): string {
  return server.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
}

export function hubUrl(server: string, space: string): string {
  return `${SCHEME}://${hostOfServer(server)}/${space}`;
}

export function parseHubUrl(raw: string): HubUrl | null {
  const m = /^(quirq|spacehub):(?:\/\/)?(.*)$/.exec(raw.trim());
  if (!m) return null;
  const parts = m[2].replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  let server: string | undefined;
  if (parts.length === 3 && m[1] === SCHEME) {
    const host = parts.shift()!;
    if (!HOST.test(host)) return null;
    server = serverOfHost(host);
  }
  if (parts.length !== 2 || !PART.test(parts[0]) || !PART.test(parts[1])) return null;
  return { ...(server ? { server } : {}), space: `${parts[0]}/${parts[1]}` };
}
