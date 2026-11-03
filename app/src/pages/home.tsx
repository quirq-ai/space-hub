import { Bot, Building2, FolderGit2, GitCommitHorizontal, Plus, Radio, Rocket, Users } from "lucide-react";
import { activeBy, activityLine, count, kindLabel, latestOf, newestBy, placeUrl, size, type HubMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { hashOf } from "@/router";
import { Browser } from "@/ui/cards";
import { Ago, Avatar, AvatarStack, CommandTabs, Empty, Popover, QuirqMark, SkeletonRows } from "@/ui/primitives";
import { Overview, Panel, ProjectMark, Stat, Stats } from "@/ui/overview";
import { PlaceBar, RecentActivity } from "./common";
import { AgentList } from "./space";

const kindOf = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

type HomeProps = { tab: "home" | "agents" | "builders"; view: View<HubMeta> | undefined; me: string | null; mySpaces: string[]; seen: Record<string, string> };

/** The hub's front page: its bar (the hub at a glance), then Home (its spaces and newest projects as apps, what happened lately), Agents or Builders, picked in the dock. */
export function HomePage({ tab, view, me, mySpaces, seen }: HomeProps) {
  const meta = view?.meta;
  const orgs = meta ? meta.spaces - meta.humans - meta.agents : 0;
  // Who builds here, by kind (agents and builders are spaces too, so "7 spaces" said little), then what they made.
  const stats = meta ? [count(meta.humans, "builder"), ...(orgs > 0 ? [count(orgs, "org")] : []), ...(meta.agents ? [count(meta.agents, "agent")] : []), count(meta.projects, "project"), `${size(meta.bytes)} stored`].join(" · ") : "Loading the hub…";
  return <div className="place">
    <PlaceBar icon={<QuirqMark size={40} />} title="spacehub" subtitle={stats}
      actions={me ? <a className="button primary" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />} primary>
        <div className="popover-title">Push your first project</div>
        <CommandTabs tabs={[
          { label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] },
          { label: "xo", lines: ['pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"', "xo login", "spacehub project create notes --source . --push"] },
        ]} note={<>Both need the hub's CLI: <code>scripts/install-cli.sh</code> from quirq-ai/space-hub. xo is XO's command line; <code>xo login</code> signs you in to XO and this hub. <a href="/-/guide">Read the guide</a>.</>} />
      </Popover>} />
    {!view ? (tab === "home" ? <Overview label="spacehub"><Stats><Stat title="Live now"><SkeletonRows rows={1} avatar={false} /></Stat></Stats></Overview> : <div className="window"><SkeletonRows rows={6} /></div>)
      : tab === "agents" ? <div className="window"><p className="window-note">Every agent on this hub. Each is a space of its own, owned by a builder or an org.</p><AgentList space="" kind="hub" agents={view.meta.agentList} canManage={!!me} /></div>
      : tab === "builders" ? <BuildersTab view={view} me={me} seen={seen} />
      : <HubOverview view={view} mySpaces={mySpaces} seen={seen} />}
  </div>;
}

/** The hub at a glance in one row of stats, then its spaces and newest projects (who changed what, who is at work), and beside them what happened lately. */
function HubOverview({ view, mySpaces, seen }: { view: View<HubMeta>; mySpaces: string[]; seen: Record<string, string> }) {
  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  const mine = new Set(mySpaces);
  const running = view.meta.agentList.filter(agent => agent.running.length);
  const here = [...new Set(view.meta.here.map(who => who.agent))];
  const push = view.meta.activity.find(item => item.kind.startsWith("ref_"));
  const pushed = push && activityLine(push);
  const bySpace = newestBy(view.meta.activity, item => item.path.split("/")[0]);
  const byProject = newestBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  const peopleBySpace = activeBy(view.meta.activity, item => item.path.split("/")[0]);
  const peopleByProject = activeBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  const spaceCard = (space: Entry) => {
    const kind = kindOf(space.detail);
    return {
      key: space.name, name: space.name, search: `${kindLabel(kind)} ${space.detail ?? ""}`, people: peopleBySpace.get(space.name), href: placeUrl({ space: space.name, project: "" }), time: space.modifiedAt,
      icon: <Avatar name={space.name} size={32} kind={kind} />, title: space.name, labels: <span className="label quiet-label">{kindLabel(kind)}</span>,
      detail: space.detail?.replace(/^\w+ · /, ""), latest: latestOf(bySpace.get(space.name)), fresh: !!seen[space.name] && space.modifiedAt > seen[space.name],
    };
  };
  return <Overview label="spacehub" side={<RecentActivity items={view.meta.activity} />}>
    <Stats>
      <Stat title="Live now" icon={<Radio size={14} />}>
        <span className="stat-value">{here.length ? <><AvatarStack names={here} max={4} size={20} /><span>{here.length}</span></> : "Nobody"}</span>
        <span className="stat-note">{here.length ? "connected to the hub" : "is connected right now"}</span>
      </Stat>
      <Stat title="Agents" icon={<Bot size={14} />} href={"/#" + hashOf("agents")}>
        <span className="stat-value">{running.length ? <><i className="online-dot" />{running.length} running</> : "None running"}</span>
        <span className="stat-note">{running.length ? running.map(agent => agent.name).join(", ") : `${view.meta.agents} on the hub`}</span>
      </Stat>
      {push && pushed ? <Stat title="Latest push" icon={<GitCommitHorizontal size={14} />} aside={<Ago iso={push.at} />} href={pushed.commit || pushed.href || undefined}>
        <span className="stat-value"><Avatar name={push.agent || "hub"} size={20} /><span className="stat-clip">{push.agent || "someone"}</span></span>
        <span className="stat-note">{push.path}{push.text ? `: ${push.text}` : ""}</span>
      </Stat> : <Stat title="Latest push" icon={<GitCommitHorizontal size={14} />}><span className="stat-value">Nothing yet</span><span className="stat-note">Push the first project</span></Stat>}
      <Stat title="Projects" icon={<FolderGit2 size={14} />}>
        <span className="stat-value">{view.meta.projects}</span>
        <span className="stat-note">in {count(view.meta.spaces, "space")}</span>
      </Stat>
    </Stats>
    {view.meta.spaces ? <Browser head={<>{count(spaces.length, "space")} · {recent.length} newest {recent.length === 1 ? "project" : "projects"}</>} groups={[
      { key: "mine", title: "Your spaces", note: "Spaces you own or belong to.", cards: spaces.filter(space => mine.has(space.name)).map(spaceCard) },
      { key: "orgs", title: "Orgs", note: "Teams on this hub.", cards: spaces.filter(space => !mine.has(space.name) && kindOf(space.detail) === "org").map(spaceCard) },
      { key: "recent", title: "Recently pushed", note: "The newest pushes across the hub, wherever they landed.", cards: recent.map(project => {
        const [space, name] = project.fullName.split("/");
        return { key: project.fullName, name: project.fullName, search: project.description, people: peopleByProject.get(project.fullName), href: placeUrl({ space, project: name }), time: project.pushedAt,
          icon: <ProjectMark name={name} />, title: project.fullName, detail: project.description || undefined, latest: latestOf(byProject.get(project.fullName)), fresh: !!seen[project.fullName] && project.pushedAt > seen[project.fullName] };
      }) },
    ]} /> : <Panel><Empty icon={<Building2 size={20} />} title="No spaces yet"><p>Sign up and push a project to start the first space. <a href="/-/guide">Read the guide</a>.</p></Empty></Panel>}
  </Overview>;
}

/** Every builder on the hub: who is connected now first, each with their projects, agents and latest change. */
function BuildersTab({ view, me, seen }: { view: View<HubMeta>; me: string | null; seen: Record<string, string> }) {
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
  return <div className="window">
    <p className="window-note">People on this hub. Each has a space named after them for their projects and agents.</p>
    {builders.length ? <Browser head={<>{count(builders.length, "builder")}{connected ? <> · <span className="strip-here"><i className="online-dot" />{connected} connected now</span></> : null}</>} groups={[
      { key: "here", title: "Connected now", note: "Working from a clone, autosync or the app right now.", cards: builders.filter(space => here.has(space.name)).map(card) },
      { key: "builders", title: connected ? "Everyone else" : "Builders", note: "Newest change first; filter to find someone.", cards: builders.filter(space => !here.has(space.name)).map(card) },
    ]} /> : <Empty icon={<Users size={20} />} title="No builders yet"><p>Sign up with <code>spacehub auth login</code> to be the first.</p></Empty>}
    <p className="quiet browser-none">GitHub accounts credited for imported code are listed on <a href="/-/builders">the builders page</a>.</p>
  </div>;
}
