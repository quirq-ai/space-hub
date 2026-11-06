/**
 * The dock's own pictures for the hub's places: Home (all spaces), Orgs,
 * Agents and Builders. Each is drawn white, two-tone, on a coloured tile
 * (`.dock-icon.tone.tone-<name>` in shell.css), like app icons in a dock.
 * module/src/style.ts draws the same Home picture for the server pages.
 */
import type { ReactNode } from "react";

export type DockTone = "home" | "orgs" | "agents" | "builders";

const W = "#fff";
const SOFT = "rgba(255,255,255,.3)";
const line = { stroke: W, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Glyph({ children }: { children: ReactNode }) {
  return <svg className="dock-glyph" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}

/** A house with a lit door. */
export function HomeGlyph() {
  return <Glyph>
    <path d="M4 10.4 12 3.8l8 6.6v8.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19.2Z" fill={SOFT} {...line} />
    <path d="M9.6 20.8v-4.6a2.4 2.4 0 0 1 4.8 0v4.6Z" fill={W} />
  </Glyph>;
}

/** A tower and its wing, windows lit. */
export function OrgsGlyph() {
  return <Glyph>
    <rect x="4" y="3.5" width="10.5" height="17" rx="1.6" fill={SOFT} {...line} />
    <path d="M14.5 9.5h4a1.5 1.5 0 0 1 1.5 1.5v9.5h-5.5" fill={SOFT} {...line} />
    {[[6.6, 6.4], [10, 6.4], [6.6, 9.9], [10, 9.9], [6.6, 13.4], [10, 13.4]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1.9" height="1.9" rx=".45" fill={W} />)}
    <rect x="16.4" y="12.6" width="1.7" height="1.7" rx=".4" fill={W} />
    <rect x="16.4" y="16" width="1.7" height="1.7" rx=".4" fill={W} />
    <path d="M7.8 20.5v-2.6h2.9v2.6" fill={W} />
  </Glyph>;
}

/** A friendly robot with an antenna. */
export function AgentsGlyph() {
  return <Glyph>
    <path d="M12 7.6V4.8" {...line} />
    <circle cx="12" cy="3.7" r="1.6" fill={W} />
    <rect x="4.6" y="7.6" width="14.8" height="11.6" rx="3.6" fill={SOFT} {...line} />
    <path d="M2.8 12v3.2M21.2 12v3.2" {...line} />
    <circle cx="9.4" cy="12.6" r="1.7" fill={W} />
    <circle cx="14.6" cy="12.6" r="1.7" fill={W} />
    <path d="M10 16.3h4" {...line} strokeWidth={1.6} />
  </Glyph>;
}

/** Two builders, one in front. */
export function BuildersGlyph() {
  return <Glyph>
    <circle cx="16.4" cy="7.6" r="2.7" fill={SOFT} {...line} />
    <path d="M14.2 13.4a5.2 5.2 0 0 1 7 4.9v1.4h-4.5" fill={SOFT} {...line} />
    <circle cx="9" cy="8.4" r="3.5" fill={W} />
    <path d="M2.6 20.2a6.4 6.4 0 0 1 12.8 0Z" fill={W} />
  </Glyph>;
}
