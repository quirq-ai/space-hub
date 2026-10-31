import { Fragment, type ReactNode } from "react";
import { Activity, Building2, FolderGit2, Plus, Rocket, Users } from "lucide-react";
import { activeBy, count, kindLabel, latestOf, newestBy, placeUrl, size, type HubMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { Browser, Glyph } from "@/ui/cards";
import { Avatar, AvatarStack, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, PageHeader } from "./common";
import { AgentList } from "./space";

const kindOf = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

/** Home keeps the places to go: your spaces, the orgs, and where work lands. Builders and agents have their own tabs. */
const GROUPS: { key: string; title: string; note: string; keep: (space: Entry, mine: Set<string>) => boolean }[] = [
  { key: "mine", title: "Your spaces", note: "Your own space and the orgs you belong to.", keep: (space, mine) => mine.has(space.name) },
  { key: "org", title: "Orgs", note: "Teams: their members push to every project they hold.", keep: (space, mine) => !mine.has(space.name) && kindOf(space.detail) === "org" },
];

type HomeProps = { tab: "home" | "agents" | "builders"; view: View<HubMeta> | undefined; me: string | null; mySpaces: string[]; seen: Record<string, string>; activityOpen: boolean; onActivity: () => void };

/** The hub's front page, in three tabs the dock switches between: Home, Agents and Builders. */
export function HomePage({ tab, view, me, mySpaces, seen, activityOpen, onActivity }: HomeProps) {
  const activity = <button className="button" type="button" aria-pressed={activityOpen} onClick={onActivity}><Activity size={15} />Activity</button>;
  const title = tab === "agents" ? "Agents" : tab === "builders" ? "Builders" : "spacehub";
  if (!view) return <div className="page"><PageHeader title={title} subtitle="Loading the hub…" actions={activity} /><SkeletonRows rows={6} /></div>;
  if (tab === "agents") return <div className="page">
    <PageHeader title="Agents" subtitle="Every agent on this hub. Each is a space of its own, owned by a builder or an org." actions={activity} />
    <AgentList space="" kind="hub" agents={view.meta.agentList} canManage={!!me} />
  </div>;
  if (tab === "builders") return <BuildersTab view={view} me={me} seen={seen} actions={activity} />;

  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  const mine = new Set(mySpaces);
  const bySpace = newestBy(view.meta.activity, item => item.path.split("/")[0]);
  const byProject = newestBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  const peopleBySpace = activeBy(view.meta.activity, item => item.path.split("/")[0]);
  const peopleByProject = activeBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  const groups = GROUPS.map(group => ({ key: group.key, title: group.title, note: group.note, cards: spaces.filter(space => group.keep(space, mine)).map(space => {
    const kind = kindOf(space.detail);
    return {
      key: space.name, name: space.name, search: `${kindLabel(kind)} ${space.detail ?? ""}`, people: peopleBySpace.get(space.name), href: placeUrl({ space: space.name, project: "" }), time: space.modifiedAt,
      icon: <Avatar name={space.name} size={34} kind={kind} />, title: space.name, labels: <span className="label quiet-label">{kindLabel(kind)}</span>,
      detail: space.detail?.replace(/^\w+ · /, ""), latest: latestOf(bySpace.get(space.name)), fresh: !!seen[space.name] && space.modifiedAt > seen[space.name],
    };
  }) }));
  const shownSpaces = groups.reduce((sum, group) => sum + group.cards.length, 0);
  return <div className="page">
    <PageHeader title="spacehub" subtitle={[count(view.meta.spaces, "space"), count(view.meta.projects, "project"), `${size(view.meta.bytes)} stored`]
      .map((stat, i) => <Fragment key={stat}>{i > 0 && " "}<span className="stat">{i > 0 && "· "}{stat}</span></Fragment>)}
      actions={<>{activity}{me ? <a className="button" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />}>
        <div className="popover-title">Push your first project</div>
        <CommandTabs tabs={[
          { label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] },
          { label: "xo", lines: ['pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"', "xo login", "spacehub project create notes --source . --push"] },
        ]} note={<>Both need the hub's CLI: <code>scripts/install-cli.sh</code> from quirq-ai/space-hub. xo is XO's command line; <code>xo login</code> signs you in to XO and this hub. <a href="/-/guide">Read the guide</a>.</>} />
      </Popover>}</>}>
      {view.meta.here.length > 0 && <div className="meta-strip"><span className="strip-here" title={view.meta.here.map(who => `${who.agent}${who.project ? ` · ${who.project}` : ""}`).join("\n")}><i className="online-dot" />{new Set(view.meta.here.map(who => who.agent)).size} connected now</span><AvatarStack names={[...new Set(view.meta.here.map(who => who.agent))]} max={8} size={20} /></div>}
    </PageHeader>
    <Browser head={<>{count(shownSpaces, "space")} and the {count(recent.length, "newest project")}</>} groups={[...groups, { key: "recent", title: "Recently pushed", note: "The newest pushes across the hub, wherever they landed.", cards: recent.map(project => {
      const [space, name] = project.fullName.split("/");
      return { key: project.fullName, name: project.fullName, search: project.description, people: peopleByProject.get(project.fullName), href: placeUrl({ space, project: name }), time: project.pushedAt, icon: <Glyph><FolderGit2 size={17} /></Glyph>,
        title: project.fullName, detail: project.description || undefined, latest: latestOf(byProject.get(project.fullName)), fresh: !!seen[project.fullName] && project.pushedAt > seen[project.fullName] };
    }) }]} />
    {!recent.length && <p className="quiet">No projects yet. <a href="/-/guide">Read the guide</a> to push the first one.</p>}
    {!view.meta.spaces && <p className="quiet"><Building2 size={14} /> Sign up and push a project to start the first space.</p>}
  </div>;
}

/** Every builder on the hub: who is connected now first, each with their projects, agents and latest change. */
function BuildersTab({ view, me, seen, actions }: { view: View<HubMeta>; me: string | null; seen: Record<string, string>; actions: ReactNode }) {
  const builders = view.snapshot.directory.entries.filter(space => kindOf(space.detail) === "personal");
  const here = new Set(view.meta.here.map(who => who.agent));
  const agents = new Map<string, number>();
  for (const agent of view.meta.agentList) agents.set(agent.parent, (agents.get(agent.parent) ?? 0) + 1);
  const bySpace = newestBy(view.meta.activity, item => item.path.split("/")[0]);
  const peopleBySpace = activeBy(view.meta.activity, item => item.path.split("/")[0]);
  const card = (space: Entry) => {
    const owned = agents.get(space.name) ?? 0;
    return {
      key: space.name, name: space.name, search: space.detail, people: peopleBySpace.get(space.name), href: placeUrl({ space: space.name, project: "" }), time: space.modifiedAt,
      icon: <Avatar name={space.name} size={34} kind="personal" />, title: space.name,
      labels: here.has(space.name) ? <span className="label done"><i className="online-dot" />here now</span> : space.name === me ? <span className="label quiet-label">You</span> : undefined,
      detail: [space.detail?.replace(/^\w+ · /, ""), owned ? count(owned, "agent") : ""].filter(Boolean).join(" · "),
      latest: latestOf(bySpace.get(space.name)), fresh: !!seen[space.name] && space.modifiedAt > seen[space.name],
    };
  };
  const connected = builders.filter(space => here.has(space.name)).length;
  return <div className="page">
    <PageHeader title="Builders" subtitle="People on this hub. Each has a space named after them for their projects and agents." actions={actions} />
    {builders.length ? <Browser head={<>{count(builders.length, "builder")}{connected ? <> · <span className="strip-here"><i className="online-dot" />{connected} connected now</span></> : null}</>} groups={[
      { key: "here", title: "Connected now", note: "Working from a clone, autosync or the app right now.", cards: builders.filter(space => here.has(space.name)).map(card) },
      { key: "builders", title: connected ? "Everyone else" : "Builders", note: "Newest change first; filter to find someone.", cards: builders.filter(space => !here.has(space.name)).map(card) },
    ]} /> : <Empty icon={<Users size={20} />} title="No builders yet"><p>Sign up with <code>spacehub auth login</code> to be the first.</p></Empty>}
    <p className="quiet browser-none">GitHub accounts credited for imported code are listed on <a href="/-/builders">the builders page</a>.</p>
  </div>;
}

/** The hub's activity in the right panel: on open the entries come in one after another, then each new one slides in at the top. */
export function ActivityFeed({ view }: { view: View<HubMeta> | undefined }) {
  return <div className="feed">{view ? <ActivityList items={view.meta.activity} compact /> : <SkeletonRows rows={6} />}</div>;
}
