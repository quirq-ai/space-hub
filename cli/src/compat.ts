// Does this CLI match the hub it talks to? The hub reports the client
// protocol it speaks (module/src/protocol.ts, through the client_protocol
// procedure). On a mismatch the CLI stops with what to do, instead of failing
// on a table or column it cannot read.

// Reinstalls the CLI from the latest source; the saved login stays.
export const UPDATE_COMMAND =
  'd="$(mktemp -d)" && git clone -q --depth 1 https://github.com/quirq-ai/space-hub "$d" && "$d/scripts/install-cli.sh"';

export interface HubProtocol {
  current: number; // the protocol the hub speaks
  oldest: number; // the oldest client protocol it still serves
}

// What is wrong with a CLI speaking protocol `mine` talking to a hub that
// speaks `hub`, or null when they match. A hub too old to report its
// protocol (null) gets the benefit of the doubt.
export function protocolProblem(mine: number, hub: HubProtocol | null, server: string): string | null {
  if (!hub) return null;
  if (mine < hub.oldest) {
    return `this spacehub CLI is out of date for the hub at ${server} (it speaks protocol ${mine}; the hub needs ${hub.oldest}). Update it, your login stays:\n  ${UPDATE_COMMAND}`;
  }
  if (mine > hub.current) {
    return `the hub at ${server} runs an older spacehub than this CLI (the hub speaks protocol ${hub.current}; this CLI ${mine}). Update the hub, or use the CLI from the hub's version of spacehub.`;
  }
  return null;
}

// Rows the CLI cannot decode: the hub changed under a running command (it was
// updated, and the reconnect replayed subscriptions before the protocol check
// answered).
export function unreadableData(server: string): string {
  return `cannot read the hub's data at ${server}: the hub was probably updated and no longer matches this spacehub CLI. Update it, your login stays:\n  ${UPDATE_COMMAND}`;
}

// The SDK's error for rows shaped differently from this CLI's bindings.
export function isDecodeError(err: unknown): boolean {
  return err instanceof RangeError && /^Tried to read \d+ byte/.test(err.message);
}
