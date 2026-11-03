/** What a drawn icon shows (ui/app-icon.tsx): a section's glyph, or a project's initials. */
export type DockArt = "vision" | "goals" | "library" | "letters" | "settings" | "folder" | "guide" | "agents" | "builders";

/**
 * A dock or app-grid icon: one of xo-swarm's app pictures (public/dock-*.png,
 * with its dark-mode version), or one drawn in their look where none fits.
 */
export type DockIcon = { src: string; dark?: string; round?: boolean } | { art: DockArt; hue: number; letters?: string; gray?: boolean };

// Bump with the pictures: they are cached for good.
const VERSION = "1";
const picture = (name: string, paired = true): DockIcon => paired
  ? { src: `/-/app/dock-${name}-light.png?v=${VERSION}`, dark: `/-/app/dock-${name}-dark.png?v=${VERSION}` }
  : { src: `/-/app/dock-${name}.png?v=${VERSION}` };

const FILES = picture("files");
const SECTIONS: Record<string, DockIcon> = {
  chat: picture("messages", false),
  files: FILES,
  insights: picture("overview"),
  ideas: picture("overview"),
  activity: picture("usage"),
  apps: picture("apps"),
  vision: { art: "vision", hue: 265 },
  goals: { art: "goals", hue: 145 },
  library: { art: "library", hue: 22 },
};

/** A top folder on a project's home screen: its section's icon, else a folder in a color of its own. */
export const folderIcon = (name: string): DockIcon => SECTIONS[name.toLowerCase()] ?? { art: "folder", hue: HUES[slotOf(name)] };

/** The dock's own apps (the hub's front page, its agents and its builders), plus settings and the guide. */
export const APP_ICONS = {
  home: picture("apps"),
  agents: { art: "agents", hue: 262 },
  builders: { art: "builders", hue: 208 },
  settings: { art: "settings", hue: 220, gray: true },
  guide: { art: "guide", hue: 22 },
} satisfies Record<string, DockIcon>;

/** A space's own picture (GitHub's, or the hub's default) as an app icon. */
export const spaceIcon = (src: string): DockIcon => ({ src });

// Seven hues far apart, so tiles side by side never look alike.
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
 * A space's projects: each its initials on a tile of its own color. A name
 * picks its color; one already taken in the space moves to the next free one
 * (in name order), so a project keeps its color while the set stays the same.
 */
export function projectIcons(names: string[]): Map<string, DockIcon> {
  const taken = new Set<number>();
  const icons = new Map<string, DockIcon>();
  for (const name of [...new Set(names)].sort()) {
    let slot = slotOf(name);
    for (let i = 0; i < HUES.length && taken.has(slot); i++) slot = (slot + 1) % HUES.length;
    taken.add(slot);
    if (taken.size === HUES.length) taken.clear();
    icons.set(name, { art: "letters", hue: HUES[slot], letters: lettersOf(name) });
  }
  return icons;
}

/** One project on its own (another space's, say). */
export const projectIcon = (name: string): DockIcon => projectIcons([name]).get(name)!;
