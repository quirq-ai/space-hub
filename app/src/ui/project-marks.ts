/** A project's mark (ui/overview.tsx ProjectMark): its initials and the hue of its tint. */
export type Mark = { hue: number; letters: string };

// Seven hues far apart, so marks side by side never look alike.
const HUES = [212, 4, 145, 270, 28, 186, 330];

function slotOf(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash % HUES.length;
}

function lettersOf(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * A space's projects: each its initials on a tint of its own. A name picks
 * its hue; one already taken in the space moves to the next free one (in
 * name order), so a project keeps its hue while the set stays the same.
 */
export function projectHues(names: string[]): Map<string, number> {
  const taken = new Set<number>();
  const hues = new Map<string, number>();
  for (const name of [...new Set(names)].sort()) {
    let slot = slotOf(name);
    for (let i = 0; i < HUES.length && taken.has(slot); i++) slot = (slot + 1) % HUES.length;
    taken.add(slot);
    if (taken.size === HUES.length) taken.clear();
    hues.set(name, HUES[slot]);
  }
  return hues;
}

/** One project's mark, with the hue its space gave it when known. */
export const markOf = (name: string, hue?: number): Mark => ({ hue: hue ?? HUES[slotOf(name)], letters: lettersOf(name) });
