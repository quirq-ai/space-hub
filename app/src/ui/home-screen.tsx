import type { ReactNode } from "react";
import { onLink } from "@/router";
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

/** Widgets in a grid: a large one (two by two) beside small ones, wide ones across two columns. */
export function Widgets({ children }: { children: ReactNode }) {
  return <div className="widgets">{children}</div>;
}

export type WidgetSize = "small" | "wide" | "large" | "full";

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

/** Apps on the home screen, like xo-swarm's application page: each icon with its name under it, a dot when it changed since you looked. */
export function AppGrid({ title, apps }: { title?: string; apps: HomeApp[] }) {
  if (!apps.length) return null;
  return <section className="springboard" aria-label={title}>
    {title && <h2 className="springboard-title">{title}<span>{apps.length}</span></h2>}
    <ul className="app-grid">{apps.map(app => <li key={app.key}>
      <a className="app-tile" href={app.href} onClick={onLink} title={app.title ?? app.label}>
        <span className="app-tile-icon"><AppIcon icon={app.icon} size={64} />{app.badge && <i className="app-badge" title="New since you last looked" />}</span>
        <span className="app-tile-name">{app.label}</span>
      </a>
    </li>)}</ul>
  </section>;
}
