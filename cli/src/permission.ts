// The hub refuses with "permission denied: only owners of "quirq" can do
// this". The CLI adds who it is signed in as and who could do it instead, so
// the refusal says where to go next.

// The spaces a refusal names ("quirq", or the space of "quirq/site"), first
// first; none when it is not a permission refusal.
export function spacesNamed(message: string): string[] {
  if (!/permission denied/.test(message)) return [];
  const spaces: string[] = [];
  for (const m of message.matchAll(/"([^"]+)"/g)) {
    const space = m[1].split('/')[0];
    if (space && !spaces.includes(space)) spaces.push(space);
  }
  return spaces;
}

export interface SpaceOwners {
  space: string;
  owners: string[];
}

// Lines to print under the refusal. `me` is the signed-in builder (null when
// the identity has none).
export function permissionHelp(me: string | null, server: string, owners: SpaceOwners[]): string[] {
  const lines = [me ? `you are signed in as ${me} on ${server}` : `you are not signed in as a builder on ${server} (spacehub auth login)`];
  const known = owners.filter(o => o.owners.length);
  for (const o of known) lines.push(`owners of ${o.space}: ${o.owners.join(', ')}`);
  if (known.length) lines.push(`ask ${known.length === 1 && known[0].owners.length === 1 ? 'them' : 'one of them'} to do it, or run it signed in as an owner`);
  return lines;
}
