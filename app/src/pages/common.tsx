import type { CSSProperties, ReactNode } from "react";
import { History, Users } from "lucide-react";
import { activityLine, groupActivity, placeUrl, pushedFiles, type ActivityItem, type Here } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, AvatarStack, Empty, PersonLink } from "@/ui/primitives";

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
  // Keyed by the row (a group by its newest push), not its position, so a new
  // row mounts at the top instead of every row changing its text.
  const seen = new Map<string, number>();
  const keyOf = (item: ActivityItem) => {
    const row = `${item.at} ${item.agent} ${item.kind} ${item.path} ${item.subject}`;
    const copies = seen.get(row) ?? 0;
    seen.set(row, copies + 1);
    return `${row} ${copies}`;
  };
  return <ol className={`activity${compact ? " compact" : ""}`}>{groupActivity(items).map((group, index) => group.length > 1
    ? <PushGroup key={keyOf(group[0])} group={group} compact={compact} index={index} />
    : <ActivityRow key={keyOf(group[0])} item={group[0]} compact={compact} index={index} />)}</ol>;
}

function ActivityRow({ item, compact, index }: { item: ActivityItem; compact: boolean; index: number }) {
  const line = activityLine(item);
  return <li style={{ "--i": index } as CSSProperties}>
    <Avatar name={item.agent || "hub"} size={compact ? 20 : 28} />
    <div className="activity-body">
      <div className="activity-line"><a className="strong" href={"/" + encodeURIComponent(item.agent)} onClick={onLink}>{item.agent || "someone"}</a> {line.verb} {line.href ? <a href={line.href} onClick={onLink}>{line.where}</a> : <span>{line.where}</span>}</div>
      {line.detail && <div className="activity-detail">{line.commit ? <a href={line.commit} onClick={onLink}>{line.detail}</a> : line.detail}</div>}
    </div>
    <span className="activity-time"><Ago iso={item.at} /></span>
  </li>;
}

const names = (list: string[]) => list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;

/** Pushes minutes apart to one branch, as one line: who, how many commits, and what they touched. */
function PushGroup({ group, compact, index }: { group: ActivityItem[]; compact: boolean; index: number }) {
  const newest = group[0];
  const line = activityLine(newest);
  const people = [...new Set(group.map(item => item.agent || "someone"))];
  const commits = group.reduce((sum, item) => sum + Math.max(item.count, 1), 0);
  const [space, project] = newest.path.split("/");
  const branch = newest.subject.replace(/^refs\/(heads|tags)\//, "");
  // Chat turns and autosync name the files they changed; a conversation's log opens with its conversation.
  const touched = group.map(item => pushedFiles(item.text));
  const files = touched.every(Boolean) ? [...new Set(touched.flat().map(path => path!.replace(/\.log\.jsonl$/i, ".json")))] : [];
  // Otherwise the newest commit someone wrote a message for says the most.
  const written = group.find((item, i) => !touched[i]) ?? newest;
  const writtenHref = activityLine(written).commit;
  return <li style={{ "--i": index } as CSSProperties}>
    <AvatarStack names={people} max={3} size={compact ? 20 : 28} />
    <div className="activity-body">
      <div className="activity-line">{people.map((name, i) => <span key={name}>{i > 0 && (i === people.length - 1 ? " and " : ", ")}<a className="strong" href={"/" + encodeURIComponent(name)} onClick={onLink}>{name}</a></span>).slice(0, 3)}{people.length > 3 && ` and ${people.length - 3} more`} pushed {commits} commits to {line.href ? <a href={line.href} onClick={onLink}>{line.where}</a> : <span>{line.where}</span>}</div>
      <div className="activity-detail">{branch} · {files.length && project
        ? files.slice(0, 3).map((path, i) => <span key={path}>{i > 0 && ", "}<a href={placeUrl({ space, project }, hashOf("files", { path }))} onClick={onLink}>{path}</a></span>)
        : <>{writtenHref ? <a href={writtenHref} onClick={onLink}>{written.text}</a> : written.text} <span className="quiet">and {group.length - 1} more</span></>}{files.length > 3 && ` and ${files.length - 3} more`}</div>
      <details className="activity-more"><summary>{group.length} pushes by {names(people)}</summary>
        <ol>{group.map((item, i) => { const one = activityLine(item); return <li key={i}><Avatar name={item.agent || "hub"} size={16} /><span className="activity-detail">{one.commit ? <a href={one.commit} onClick={onLink}>{item.text || one.detail}</a> : item.text || one.detail}</span><span className="activity-time"><Ago iso={item.at} /></span></li>; })}</ol>
      </details>
    </div>
    <span className="activity-time"><Ago iso={newest.at} /></span>
  </li>;
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
