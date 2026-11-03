import { BookOpen, SquareCheck, Users, type LucideIcon } from "lucide-react";

/**
 * A dock icon: one of xo-swarm's app pictures (public/dock-*.png, with its
 * dark-mode version), or a glyph on a tile drawn to match where none fits.
 */
export type DockIcon = { src: string; dark?: string } | { glyph: LucideIcon; hue: number };

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
  vision: { glyph: SquareCheck, hue: 265 },
  goals: { glyph: SquareCheck, hue: 145 },
  library: { glyph: BookOpen, hue: 28 },
};

/** A project's top folder: its section's icon, else the Files folder. */
export const sectionIcon = (name: string): DockIcon => SECTIONS[name.toLowerCase()] ?? FILES;

/** An org's or a builder's projects. */
export const PROJECT_ICON = picture("space");

/** The hub's front page in three parts. */
export const HOME_ICONS: Record<"home" | "agents" | "builders", DockIcon> = {
  home: picture("apps"),
  agents: picture("agent"),
  builders: { glyph: Users, hue: 210 },
};
