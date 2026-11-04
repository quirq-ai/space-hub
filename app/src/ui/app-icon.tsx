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
    case "settings": return <><g fill={glass}>{[0, 45, 90, 135, 180, 225, 270, 315].map(turn => <rect key={turn} x="56" y="26" width="16" height="22" rx="5" transform={`rotate(${turn} 64 66)`} />)}<circle cx="64" cy="66" r="27" /></g><circle cx="64" cy="66" r="11" fill={cut} /></>;
    case "folder": return <path d="M26 48a9 9 0 0 1 9-9h19l9 9h30a9 9 0 0 1 9 9v31a9 9 0 0 1-9 9H35a9 9 0 0 1-9-9z" fill={glass} />;
    case "guide": return <><path d="M38 32h44a8 8 0 0 1 8 8v56H44a6 6 0 0 1-6-6z" fill={glass} /><path d="M50 50h26M50 62h20" stroke={cut} strokeWidth="6" strokeLinecap="round" /></>;
    case "agents": return <><circle cx="64" cy="29" r="7" fill={glass} /><rect x="60" y="30" width="8" height="16" rx="4" fill={glass} /><rect x="32" y="44" width="64" height="50" rx="16" fill={glass} /><circle cx="50" cy="67" r="7" fill={cut} /><circle cx="78" cy="67" r="7" fill={cut} /><rect x="51" y="80" width="26" height="5" rx="2.5" fill={cut} /></>;
    case "builders": return <><g fill={glass} opacity=".72"><circle cx="82" cy="47" r="12" /><path d="M62 94c0-15 9-25 20-25s20 10 20 25z" /></g><g fill={glass}><circle cx="52" cy="50" r="15" /><path d="M24 98c0-18 12-30 28-30s28 12 28 30z" /></g></>;
    case "code": return <><path d="M50 46L32 66l18 20M78 46l18 20-18 20" fill="none" stroke={glass} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" /><path d="M70 40L58 92" stroke={glass} strokeWidth="9" strokeLinecap="round" /></>;
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
    <img className={`app-icon-img${icon.dark ? " app-icon-light" : ""}${icon.round ? "" : " app-icon-tile"}`} src={icon.src} alt="" width={size} height={size} draggable={false} />
    {icon.dark && <img className="app-icon-img app-icon-dark" src={icon.dark} alt="" width={size} height={size} draggable={false} />}
  </>;
  const { art, hue } = icon;
  // Settings is gray, like the system's own.
  const sat = icon.gray ? [10, 8, 30, 12] : [92, 86, 100, 84];
  return <svg className="app-icon-art" viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={`hsl(${hue} ${sat[0]}% ${icon.gray ? 72 : 68}%)`} /><stop offset="1" stopColor={`hsl(${hue} ${sat[1]}% ${icon.gray ? 46 : 47}%)`} /></linearGradient>
      <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".32" /><stop offset=".55" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor={`hsl(${hue} ${sat[2]}% 88%)`} /></linearGradient>
      <filter id={`${id}f`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodColor={`hsl(${hue} ${icon.gray ? 10 : 90}% 24%)`} floodOpacity=".38" /></filter>
    </defs>
    <rect width="128" height="128" rx="29" fill={`url(#${id}t)`} />
    <rect width="128" height="128" rx="29" fill={`url(#${id}s)`} />
    <g filter={`url(#${id}f)`}><Glyph art={art} glass={`url(#${id}g)`} cut={`hsl(${hue} ${sat[3]}% ${icon.gray ? 50 : 52}%)`} letters={icon.letters} /></g>
    {art !== "letters" && !icon.gray && <path d={SPARK} fill="#fff" />}
  </svg>;
}
