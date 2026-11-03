import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { navigate, onLink } from "@/router";
import type { DockIcon } from "@/shell/dock-icons";
import { AppIcon } from "./app-icon";

/**
 * xo-swarm's liquid glass, as layers under whatever sits on it: the
 * backdrop blurred (and, with `distort`, bent through the shell's
 * GlassFilter), a frosted tint, and a shine along the edge.
 */
export function Glass({ distort = false }: { distort?: boolean }) {
  return <span className={`glass${distort ? " distort" : ""}`} aria-hidden="true"><span className="glass-effect" /><span className="glass-tint" /><span className="glass-shine" /></span>;
}

/** A place's home screen, on the wallpaper: its widgets, then its apps. */
export function HomeScreen({ label, children }: { label: string; children: ReactNode }) {
  return <div className="home" aria-label={label}>{children}</div>;
}

/** Small widgets in one row: a place at a glance. */
export function Widgets({ children }: { children: ReactNode }) {
  return <div className="widgets">{children}</div>;
}

export type WidgetSize = "small" | "full";

/** A widget: a pane of glass with a title, the time or a meter on its right, and what it shows. A link when it leads somewhere. */
export function Widget({ title, icon, aside, href, size = "small", className, children }: {
  title?: ReactNode; icon?: ReactNode; aside?: ReactNode; href?: string; size?: WidgetSize; className?: string; children: ReactNode;
}) {
  const body = <>
    <Glass />
    <span className="widget-body">
      {title && <span className="widget-title">{icon}<span>{title}</span>{aside && <span className="widget-aside">{aside}</span>}</span>}
      {children}
    </span>
  </>;
  const name = `widget ${size}${className ? " " + className : ""}`;
  return href ? <a className={name} href={href} onClick={onLink}>{body}</a> : <section className={name}>{body}</section>;
}

export type HomeApp = { key: string; label: string; href: string; icon: DockIcon; badge?: boolean; title?: string };

export type AppGroup = { title?: string; apps: HomeApp[] };

/**
 * A place's apps, like macOS's Launchpad: a search field, then each group's
 * big icons in a centered grid with their names under them, a dot on one
 * that changed since you looked. Enter opens the first match.
 */
export function Launchpad({ label, groups }: { label: string; groups: AppGroup[] }) {
  const [query, setQuery] = useState("");
  const total = groups.reduce((sum, group) => sum + group.apps.length, 0);
  if (!total) return null;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (app: HomeApp) => words.every(word => `${app.label} ${app.title ?? ""}`.toLowerCase().includes(word));
  const shown = groups.map(group => ({ ...group, apps: group.apps.filter(match) })).filter(group => group.apps.length);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setQuery("");
    if (event.key === "Enter" && shown.length) navigate(shown[0].apps[0].href);
  };
  return <section className="launchpad" aria-label={label}>
    {total > 6 && <label className="launch-search"><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={keys} placeholder="Search" aria-label={`Search ${label}`} /></label>}
    {shown.map(group => <div key={group.title ?? ""} className="launch-group">
      {group.title && <h2 className="launch-title">{group.title}<span>{group.apps.length}</span></h2>}
      <ul className="app-grid">{group.apps.map(app => <li key={app.key}>
        <a className="app-tile" href={app.href} onClick={onLink} title={app.title ?? app.label}>
          <span className="app-tile-icon"><AppIcon icon={app.icon} size={84} />{app.badge && <i className="app-badge" title="New since you last looked" />}</span>
          <span className="app-tile-name">{app.label}</span>
        </a>
      </li>)}</ul>
    </div>)}
    {words.length > 0 && !shown.length && <p className="launch-none">Nothing here matches “{query}”.</p>}
  </section>;
}
