import type { ReactNode } from "react";
import { History, Users } from "lucide-react";
import { activityLine, type ActivityItem, type Here } from "@/api";
import { onLink } from "@/router";
import { Ago, Avatar, Empty, PersonLink } from "@/ui/primitives";

export function PageHeader({ crumbs, title, subtitle, leading, actions, children }: {
  crumbs?: { label: string; href: string }[]; title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return <header className="page-header">
    {crumbs && crumbs.length > 0 && <nav className="crumbs" aria-label="Breadcrumb">{crumbs.map((crumb, i) => <span key={i}>{i > 0 && <span className="crumb-sep">/</span>}<a href={crumb.href} onClick={onLink}>{crumb.label}</a></span>)}</nav>}
    <div className="page-title-row">
      {leading}
      <div className="page-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
    {children}
  </header>;
}

export type Tab = { key: string; label: string; href: string; count?: number };

export function Tabs({ tabs, active }: { tabs: Tab[]; active: string }) {
  return <nav className="tabs" aria-label="Sections">{tabs.map(tab => <a key={tab.key} href={tab.href} onClick={onLink} className={tab.key === active ? "tab active" : "tab"} aria-current={tab.key === active ? "page" : undefined}>
    {tab.label}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
  </a>)}</nav>;
}

export function ActivityList({ items, empty = "Nothing has happened here yet.", compact = false }: { items: ActivityItem[]; empty?: string; compact?: boolean }) {
  if (!items.length) return <Empty icon={<History size={20} />} title="No activity yet"><p>{empty}</p></Empty>;
  return <ol className={`activity${compact ? " compact" : ""}`}>{items.map((item, index) => {
    const line = activityLine(item);
    return <li key={index}>
      <Avatar name={item.agent || "hub"} size={compact ? 20 : 28} />
      <div className="activity-body">
        <div className="activity-line"><a className="strong" href={"/" + encodeURIComponent(item.agent)} onClick={onLink}>{item.agent || "someone"}</a> {line.verb} {line.href ? <a href={line.href} onClick={onLink}>{line.where}</a> : <span>{line.where}</span>}</div>
        {line.detail && <div className="activity-detail">{line.detail}</div>}
      </div>
      <span className="activity-time"><Ago iso={item.at} /></span>
    </li>;
  })}</ol>;
}

const MODES: Record<string, string> = { watch: "watching", sync: "syncing", autosync: "editing", agent: "running", app: "in the app" };

export function HereNow({ here }: { here: Here[] }) {
  if (!here.length) return <p className="quiet">Nobody is connected right now.</p>;
  return <ul className="people-list">{here.map((who, index) => <li key={index}><PersonLink name={who.agent} /><span className="quiet">{MODES[who.mode] ?? who.mode}{who.project ? ` · ${who.project}` : ""}</span><span className="online-dot" title="Connected now" /></li>)}</ul>;
}

export function People({ groups }: { groups: { title: string; names: string[]; note?: string }[] }) {
  const shown = groups.filter(group => group.names.length);
  if (!shown.length) return <Empty icon={<Users size={20} />} title="No people yet" />;
  return <div className="people-groups">{shown.map(group => <section key={group.title}>
    <h2 className="section-title">{group.title} <span className="quiet">{group.names.length}</span></h2>
    {group.note && <p className="quiet">{group.note}</p>}
    <ul className="people-grid">{group.names.map(name => <li key={name}><a href={"/" + encodeURIComponent(name)} onClick={onLink} className="person-card"><Avatar name={name} size={36} /><span>{name}</span></a></li>)}</ul>
  </section>)}</div>;
}
