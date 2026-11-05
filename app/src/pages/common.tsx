import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { History, Users } from "lucide-react";
import { activityLine, groupActivity, placeUrl, pushedFiles, type ActivityItem, type AgentInfo, type Here, type Meta } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, AvatarStack, Empty, PersonLink, SkeletonRows } from "@/ui/primitives";
import { dayOf, FILTERS, keepActivity, liveRows, MODES, type ActivityFilter } from "@/lib/activity";
import { Browser } from "@/ui/cards";

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

/** A place's sections. When they do not fit (a phone), they scroll sideways, fade at the edge that has more, and keep the active one in view. */
export function Tabs({ tabs, active }: { tabs: Tab[]; active: string }) {
  const bar = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const update = () => setEdges(current => {
      const next = { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 };
      return next.left === current.left && next.right === current.right ? current : next;
    });
    // Scrolls only the bar, never the page.
    const on = el.querySelector<HTMLElement>(".tab.active");
    if (on && (on.offsetLeft < el.scrollLeft || on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth)) el.scrollLeft = on.offsetLeft - 24;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { el.removeEventListener("scroll", update); observer.disconnect(); };
  }, [active, tabs.map(tab => `${tab.key}:${tab.count ?? ""}`).join(" ")]);
  return <div className={`tabs-wrap${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`}><nav className="tabs" aria-label="Sections" ref={bar}>{tabs.map(tab => <a key={tab.key} href={tab.href} onClick={onLink} className={tab.key === active ? "tab active" : "tab"} aria-current={tab.key === active ? "page" : undefined}>
    {tab.label}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
  </a>)}</nav></div>;
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
  // Under a heading per day, newest first; `--i` keeps counting across days for the entrance stagger.
  const days: { day: string; groups: ActivityItem[][] }[] = [];
  for (const group of groupActivity(items)) {
    const day = dayOf(group[0].at);
    const last = days[days.length - 1];
    if (last?.day === day) last.groups.push(group);
    else days.push({ day, groups: [group] });
  }
  let index = 0;
  return <div className="activity-days">{days.map(({ day, groups }) => <section key={day} className="activity-day">
    <h3 className="activity-day-title">{day}</h3>
    <ol className={`activity${compact ? " compact" : ""}`}>{groups.map(group => {
      const i = index++;
      return group.length > 1
        ? <PushGroup key={keyOf(group[0])} group={group} compact={compact} index={i} />
        : <ActivityRow key={keyOf(group[0])} item={group[0]} compact={compact} index={i} />;
    })}</ol>
  </section>)}</div>;
}

const NONE: Record<ActivityFilter, string> = { all: "", humans: "No builder has done anything here yet.", agents: "No agent has done anything here yet." };

/** A place's activity with a filter (lib/activity.ts); `agents` names the agents, since an activity row only says who. */
export function ActivityStream({ items, agents, compact = false, empty }: { items: ActivityItem[]; agents: string[]; compact?: boolean; empty?: string }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const isAgent = new Set(agents);
  const shown = items.filter(item => keepActivity(filter, item, isAgent));
  const counts = new Map(FILTERS.map(option => [option.key, option.key === filter ? shown.length : items.filter(item => keepActivity(option.key, item, isAgent)).length]));
  return <div className="activity-stream">
    {items.length > 0 && <div className="activity-filter-bar"><div className="segmented activity-filter" role="group" aria-label="Show">{FILTERS.map(option => <button key={option.key} type="button" className={filter === option.key ? "on" : undefined} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>{option.label}<span className="tab-count">{counts.get(option.key)}</span></button>)}</div></div>}
    {shown.length || filter === "all" ? <ActivityList items={shown} compact={compact} empty={empty} /> : <p className="quiet activity-none">{NONE[filter]}</p>}
  </div>;
}

/** The right-hand panel's content: who is here (on Home, who is live on the hub), then the place's activity. */
export function ActivityPanel({ meta }: { meta: Meta | undefined }) {
  if (!meta) return <div className="feed"><SkeletonRows rows={6} /></div>;
  const agents = meta.level === "project" ? meta.agents : [...new Set([...meta.agentList.map(agent => agent.name), ...(meta.level === "space" ? meta.agents : [])])];
  return <div className="feed">
    <LiveNow variant="panel" title={meta.level === "hub" ? "Live now" : "Here now"} here={meta.here} agents={meta.level === "project" ? [] : meta.agentList} known={agents} place={meta.level === "project" ? meta.fullName : ""} />
    <ActivityStream items={meta.activity} agents={agents} compact />
  </div>;
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

/** Who is connected now (lib/activity.ts): how many, in a page header, or each one at the top of the right-hand panel. */
export function LiveNow({ here, agents = [], known = [], place = "", variant, title = "Here now" }: { here: Here[]; agents?: AgentInfo[]; known?: string[]; place?: string; variant: "strip" | "panel"; title?: string }) {
  const rows = liveRows(here, agents, known, place);
  if (variant === "strip") return rows.length ? <div className="live-strip">
    <span className="strip-here"><i className="online-dot" />Live now</span><span className="live-count">{rows.length}</span>
  </div> : null;
  return <section className="live-panel" aria-label={title}>
    <h3 className="activity-day-title">{title}{rows.length > 0 && <span className="quiet"> {rows.length}</span>}</h3>
    {rows.length ? <ul className="live-list">{rows.map(row => <li key={row.name}>
      <a className="person" href={"/" + encodeURIComponent(row.name)} onClick={onLink}><Avatar name={row.name} size={22} kind={row.agent ? "agent" : undefined} /><span>{row.name}</span></a>
      <span className="live-doing" title={row.text}>{row.text}</span><i className="online-dot" title="Connected now" />
    </li>)}</ul> : <p className="quiet live-none">Nobody is connected right now.</p>}
  </section>;
}

export function HereNow({ here }: { here: Here[] }) {
  if (!here.length) return <p className="quiet">Nobody is connected right now.</p>;
  return <ul className="people-list">{here.map((who, index) => <li key={index}><PersonLink name={who.agent} /><span className="quiet">{MODES[who.mode] ?? who.mode}{who.project ? ` · ${who.project}` : ""}</span><span className="online-dot" title="Connected now" /></li>)}</ul>;
}

/** People and agents as cards, grouped by what they may do (each card can say why), with who is connected right now. */
export function People({ groups, here = [], agents = [], counted = n => `${n} ${n === 1 ? "person" : "people and agents"}` }: { groups: { title: string; names: string[]; note?: string; detail?: (name: string) => string }[]; here?: Here[]; agents?: string[]; counted?: (n: number) => string }) {
  const shown = groups.filter(group => group.names.length);
  if (!shown.length) return <Empty icon={<Users size={20} />} title="No people yet" />;
  const online = new Set(here.map(who => who.agent));
  const total = new Set(shown.flatMap(group => group.names)).size;
  return <Browser head={<>{counted(total)}{online.size ? <> · <span className="strip-here"><i className="online-dot" />{online.size} here now</span></> : null}</>} groups={shown.map(group => ({ key: group.title, title: group.title, note: group.note, compact: true, cards: group.names.map(name => ({
    key: name, name, search: group.title, href: "/" + encodeURIComponent(name), title: name, detail: group.detail?.(name),
    icon: <Avatar name={name} size={28} kind={agents.includes(name) ? "agent" : undefined} />,
    labels: online.has(name) ? <span className="label done" title="Connected now"><i className="online-dot" />Here now</span> : undefined,
  })) }))} />;
}
