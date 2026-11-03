import { BookOpen, Bot, Building2, FolderGit2, GitCommitHorizontal, Plus, Radio, Rocket, Users } from "lucide-react";
import { activeBy, activityLine, avatarUrl, count, latestOf, newestBy, placeUrl, size, type HubMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { hashOf, onLink } from "@/router";
import { Browser } from "@/ui/cards";
import { Ago, Avatar, AvatarStack, CommandTabs, Empty, Popover, QuirqMark, SkeletonRows } from "@/ui/primitives";
import { AppIcon } from "@/ui/app-icon";
import { AppGrid, HomeScreen, Widget, Widgets } from "@/ui/home-screen";
import { APP_ICONS, projectIcon, spaceIcon } from "@/shell/dock-icons";
import { PageHeader } from "./common";
import { AgentList } from "./space";

const kindOf = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

type HomeProps = { tab: "home" | "agents" | "builders"; view: View<HubMeta> | undefined; me: string | null; mySpaces: string[]; seen: Record<string, string> };

const HOME = { label: "Home", href: "/" };

/** The hub's front page: its home screen, and Agents and Builders as apps the dock opens. */
export function HomePage({ tab, view, me, mySpaces, seen }: HomeProps) {
  if (tab === "agents") return <div className="page">
    <PageHeader back={HOME} leading={<span className="window-icon"><AppIcon icon={APP_ICONS.agents} size={44} /></span>} title="Agents" subtitle="Every agent on this hub. Each is a space of its own, owned by a builder or an org." />
    {view ? <AgentList space="" kind="hub" agents={view.meta.agentList} canManage={!!me} /> : <SkeletonRows rows={6} />}
  </div>;
  if (tab === "builders") return view ? <BuildersTab view={view} me={me} seen={seen} /> : <div className="page"><PageHeader back={HOME} title="Builders" /><SkeletonRows rows={6} /></div>;
  if (!view) return <HomeScreen label="spacehub"><Widgets><Widget size="wide" className="profile-widget"><span className="profile-top"><QuirqMark size={64} /><span className="profile-name"><h1>spacehub</h1><p>Loading the hub…</p></span></span></Widget></Widgets></HomeScreen>;

  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  const mine = new Set(mySpaces);
  // Who builds here, by kind (agents and builders are spaces too, so "7 spaces" said little), then what they made.
  const orgs = view.meta.spaces - view.meta.humans - view.meta.agents;
  const running = view.meta.agentList.filter(agent => agent.running.length);
  const push = view.meta.activity.find(item => item.kind.startsWith("ref_"));
  const pushed = push && activityLine(push);
  const spaceApp = (space: Entry) => ({
    key: space.name, label: space.name, href: placeUrl({ space: space.name, project: "" }), icon: spaceIcon(avatarUrl(space.name)),
    title: [space.name, space.detail?.replace(/^\w+ · /, "")].filter(Boolean).join(": "), badge: !!seen[space.name] && space.modifiedAt > seen[space.name],
  });
  return <HomeScreen label="spacehub">
    <Widgets>
      <Widget size="large" className="profile-widget hub-widget">
        <span className="profile-top">
          <QuirqMark size={64} />
          <span className="profile-name"><h1>spacehub</h1><p>Git hosting for builders and their agents, live as it changes.</p></span>
        </span>
        <span className="profile-facts">
          <a href={"/#" + hashOf("builders")} onClick={onLink}><Users size={14} />{count(view.meta.humans, "builder")}</a>
          {orgs > 0 && <span><Building2 size={14} />{count(orgs, "org")}</span>}
          {view.meta.agents > 0 && <a href={"/#" + hashOf("agents")} onClick={onLink}><Bot size={14} />{count(view.meta.agents, "agent")}</a>}
          <span><FolderGit2 size={14} />{count(view.meta.projects, "project")}</span>
          <span>{size(view.meta.bytes)} stored</span>
        </span>
        <span className="widget-actions">{me ? <a className="button primary" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />} primary>
          <div className="popover-title">Push your first project</div>
          <CommandTabs tabs={[
            { label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] },
            { label: "xo", lines: ['pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"', "xo login", "spacehub project create notes --source . --push"] },
          ]} note={<>Both need the hub's CLI: <code>scripts/install-cli.sh</code> from quirq-ai/space-hub. xo is XO's command line; <code>xo login</code> signs you in to XO and this hub. <a href="/-/guide">Read the guide</a>.</>} />
        </Popover>}<a className="button" href="/-/guide"><BookOpen size={15} />Guide</a></span>
      </Widget>
      <Widget title="Live now" icon={<Radio size={13} />}>
        <span className="widget-value">{view.meta.here.length ? <><AvatarStack names={[...new Set(view.meta.here.map(who => who.agent))]} max={4} size={22} /><span>{new Set(view.meta.here.map(who => who.agent)).size}</span></> : "Nobody"}</span>
        <span className="widget-note">{view.meta.here.length ? "connected to the hub" : "is connected right now"}</span>
      </Widget>
      <Widget title="Agents" icon={<Bot size={13} />} href={"/#" + hashOf("agents")}>
        <span className="widget-value">{running.length ? <><i className="online-dot" />{running.length} running</> : "None running"}</span>
        <span className="widget-note">{running.length ? running.map(agent => agent.name).join(", ") : `${view.meta.agents} on the hub`}</span>
      </Widget>
      {push && pushed && <Widget title="Latest push" icon={<GitCommitHorizontal size={13} />} aside={<Ago iso={push.at} />} href={pushed.commit || pushed.href || undefined}>
        <span className="widget-value"><Avatar name={push.agent || "hub"} size={20} /><span className="widget-clip">{push.agent || "someone"}</span></span>
        <span className="widget-note">{push.path}{push.text ? `: ${push.text}` : ""}</span>
      </Widget>}
      <Widget title="Builders" icon={<Users size={13} />} href={"/#" + hashOf("builders")}>
        <span className="widget-value">{view.meta.humans}</span>
        <span className="widget-note">people with a space here</span>
      </Widget>
    </Widgets>
    <AppGrid title="Your spaces" apps={spaces.filter(space => mine.has(space.name)).map(spaceApp)} />
    <AppGrid title="Orgs" apps={spaces.filter(space => !mine.has(space.name) && kindOf(space.detail) === "org").map(spaceApp)} />
    <AppGrid title="Recently pushed" apps={recent.map(project => {
      const [space, name] = project.fullName.split("/");
      return { key: project.fullName, label: name, title: [project.fullName, project.description].filter(Boolean).join(": "), href: placeUrl({ space, project: name }), icon: projectIcon(name), badge: !!seen[project.fullName] && project.pushedAt > seen[project.fullName] };
    })} />
    {!view.meta.spaces && <Widget size="full" className="empty-widget"><Empty icon={<Building2 size={20} />} title="No spaces yet"><p>Sign up and push a project to start the first space. <a href="/-/guide">Read the guide</a>.</p></Empty></Widget>}
  </HomeScreen>;
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
  return <div className="page">
    <PageHeader back={HOME} leading={<span className="window-icon"><AppIcon icon={APP_ICONS.people} size={44} /></span>} title="Builders" subtitle="People on this hub. Each has a space named after them for their projects and agents." />
    {builders.length ? <Browser head={<>{count(builders.length, "builder")}{connected ? <> · <span className="strip-here"><i className="online-dot" />{connected} connected now</span></> : null}</>} groups={[
      { key: "here", title: "Connected now", note: "Working from a clone, autosync or the app right now.", cards: builders.filter(space => here.has(space.name)).map(card) },
      { key: "builders", title: connected ? "Everyone else" : "Builders", note: "Newest change first; filter to find someone.", cards: builders.filter(space => !here.has(space.name)).map(card) },
    ]} /> : <Empty icon={<Users size={20} />} title="No builders yet"><p>Sign up with <code>spacehub auth login</code> to be the first.</p></Empty>}
    <p className="quiet browser-none">GitHub accounts credited for imported code are listed on <a href="/-/builders">the builders page</a>.</p>
  </div>;
}
