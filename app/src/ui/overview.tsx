import type { CSSProperties, ReactNode } from "react";
import { onLink } from "@/router";
import { markOf } from "./project-marks";

/** Frosted glass under a bar that floats over the page (the top bar, the dock): the page blurred behind a tint. */
export function Glass() {
  return <span className="glass" aria-hidden="true"><span className="glass-effect" /><span className="glass-tint" /></span>;
}

/** A place's overview: its main column, and beside it on a wide screen (below it on a narrow one) what happened lately. */
export function Overview({ label, side, children }: { label: string; side?: ReactNode; children: ReactNode }) {
  return <div className="overview" aria-label={label}><div className="overview-main">{children}</div>{side && <aside className="overview-side">{side}</aside>}</div>;
}

/** A place at a glance: a few numbers side by side in one panel. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>;
}

/** One number in the stats panel: what it counts, the number, a line on it. A link when it leads somewhere. */
export function Stat({ title, icon, aside, href, children }: { title: string; icon?: ReactNode; aside?: ReactNode; href?: string; children: ReactNode }) {
  const body = <>
    <span className="stat-title">{icon}<span>{title}</span>{aside && <span className="stat-aside">{aside}</span>}</span>
    {children}
  </>;
  return href ? <a className="stat" href={href} onClick={onLink}>{body}</a> : <section className="stat">{body}</section>;
}

/** A panel with a title line (and something on its right, like "See all"), holding a list, a goal or a README. */
export function Panel({ title, icon, aside, className, children }: { title?: ReactNode; icon?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel-block${className ? " " + className : ""}`}>
    {title && <h2 className="panel-title">{icon}<span>{title}</span>{aside && <span className="panel-aside">{aside}</span>}</h2>}
    {children}
  </section>;
}

/** A project's mark: its initials on a quiet tint of its own color, the same wherever the project shows. */
export function ProjectMark({ name, hue, size = 32 }: { name: string; hue?: number; size?: number }) {
  const mark = markOf(name, hue);
  return <span className="project-mark" style={{ "--hue": mark.hue, width: size, height: size, fontSize: Math.round(size * .4) } as CSSProperties} aria-hidden="true">{mark.letters}</span>;
}
