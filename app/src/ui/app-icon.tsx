import { useId } from "react";
import type { DockIcon, DockArt } from "@/shell/dock-icons";

// A four-point spark, like the ones on xo-swarm's icons.
const SPARK = "M96 18c1.6 8.4 4.6 11.4 13 13-8.4 1.6-11.4 4.6-13 13-1.6-8.4-4.6-11.4-13-13 8.4-1.6 11.4-4.6 13-13z";

/** The glyph of a drawn icon, in frosted glass (`glass`) with cuts in the tile's color (`cut`). */
function Glyph({ art, glass, cut, letters }: { art: DockArt; glass: string; cut: string; letters?: string }) {
  switch (art) {
    case "vision": return <><rect x="34" y="38" width="56" height="56" rx="15" fill={glass} /><path d="M48 66l11 11 21-22" fill="none" stroke={cut} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /></>;
    case "goals": return <><circle cx="62" cy="68" r="29" fill={glass} /><circle cx="62" cy="68" r="18" fill={cut} /><circle cx="62" cy="68" r="8" fill={glass} /></>;
    case "library": return <><path d="M30 44c11-4 22-3 31 3v46c-9-6-20-7-31-3z" fill={glass} /><path d="M98 44c-11-4-22-3-31 3v46c9-6 20-7 31-3z" fill={glass} /></>;
    case "builders": return <><g opacity=".7"><circle cx="80" cy="52" r="10" fill={glass} /><path d="M64 92c0-14 7-22 16-22s16 8 16 22z" fill={glass} /></g><circle cx="54" cy="56" r="12" fill={glass} /><path d="M31 96c0-17 10-26 23-26s23 9 23 26z" fill={glass} /></>;
    case "letters": return <text x="64" y="68" textAnchor="middle" dominantBaseline="central" fontSize={letters && letters.length > 1 ? 46 : 58} fontWeight="700" letterSpacing="-1" fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif" fill={glass}>{letters}</text>;
  }
}

/**
 * An app icon: one of xo-swarm's pictures (its dark version in dark mode),
 * or one drawn in their look: a vivid tile with a sheen, a glyph of frosted
 * glass with a soft shadow, and a spark.
 */
export function AppIcon({ icon, size = 54 }: { icon: DockIcon; size?: number }) {
  const id = useId().replace(/:/g, "");
  if ("src" in icon) return <>
    <img className={`app-icon-img${icon.dark ? " app-icon-light" : ""}`} src={icon.src} alt="" width={size} height={size} draggable={false} />
    {icon.dark && <img className="app-icon-img app-icon-dark" src={icon.dark} alt="" width={size} height={size} draggable={false} />}
  </>;
  const { art, hue } = icon;
  return <svg className="app-icon-art" viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={`hsl(${hue} 92% 68%)`} /><stop offset="1" stopColor={`hsl(${hue} 86% 47%)`} /></linearGradient>
      <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".32" /><stop offset=".55" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor={`hsl(${hue} 100% 88%)`} /></linearGradient>
      <filter id={`${id}f`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodColor={`hsl(${hue} 90% 24%)`} floodOpacity=".38" /></filter>
    </defs>
    <rect width="128" height="128" rx="29" fill={`url(#${id}t)`} />
    <rect width="128" height="128" rx="29" fill={`url(#${id}s)`} />
    <g filter={`url(#${id}f)`}><Glyph art={art} glass={`url(#${id}g)`} cut={`hsl(${hue} 84% 52%)`} letters={icon.letters} /></g>
    {art !== "letters" && <path d={SPARK} fill="#fff" />}
  </svg>;
}
