import { Fragment, type ReactNode } from "react";
import { Building2, FolderGit2, Plus, Rocket, Users } from "lucide-react";
import { activeBy, count, kindLabel, latestOf, newestBy, placeUrl, size, type HubMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { hashOf, onLink } from "@/router";
import { Browser, Glyph } from "@/ui/cards";
import { Avatar, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { LiveNow, PageHeader } from "./common";
import { AgentList } from "./space";

const kindOf = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

/** Home keeps the places to go: your spaces, the orgs, and where work lands. Orgs, agents and builders each have a page of their own too. */
const GROUPS: { key: string; title: string; note: string; keep: (space: Entry, mine: Set<string>) => boolean }[] = [
  { key: "mine", title: "Your spaces", note: "Your own space and the orgs you belong to.", keep: (space, mine) => mine.has(space.name) },
  { key: "org", title: "Orgs", note: "Teams: their members push to every project they hold.", keep: (space, mine) => !mine.has(space.name) && kindOf(space.detail) === "org" },
];

type HomeProps = { tab: "home" | "orgs" | "agents" | "builders"; view: View<HubMeta> | undefined; me: string | null; mySpaces: string[]; seen: Record<string, string> };

/** The hub's front page, and the three lists the dock switches between: Orgs, Agents and Builders. */
export function HomePage({ tab, view, me, mySpaces, seen }: HomeProps) {
  const title = tab === "orgs" ? "Orgs" : tab === "agents" ? "Agents" : tab === "builders" ? "Builders" : "spacehub";
  if (!view) return <div className="page"><PageHeader title={title} subtitle="Loading the hub…" /><SkeletonRows rows={6} /></div>;
  if (tab === "agents") return <div className="page">
    <PageHeader title="Agents" subtitle="Every agent on this hub. Each is a space of its own, owned by a builder or an org." />
    <AgentList space="" kind="hub" agents={view.meta.agentList} canManage={!!me} />
  </div>;
  if (tab === "builders") return <BuildersTab view={view} me={me} seen={seen} />;
  if (tab === "orgs") return <OrgsTab view={view} mySpaces={mySpaces} seen={seen} />;

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
  // Who builds here, by kind (agents and builders are spaces too, so "7 spaces" said little), then what they made.
  const orgs = view.meta.spaces - view.meta.humans - view.meta.agents;
  const stats: { text: string; href?: string }[] = [
    { text: count(view.meta.humans, "builder"), href: "/#" + hashOf("builders") },
    ...(orgs > 0 ? [{ text: count(orgs, "org"), href: "/#" + hashOf("orgs") }] : []),
    ...(view.meta.agents > 0 ? [{ text: count(view.meta.agents, "agent"), href: "/#" + hashOf("agents") }] : []),
    { text: count(view.meta.projects, "project") },
    { text: `${size(view.meta.bytes)} stored` },
  ];
  return <div className="page">
    <PageHeader title="spacehub" subtitle={stats.map((stat, i) => <Fragment key={stat.text}>{i > 0 && " "}<span className="stat">{i > 0 && "· "}{stat.href ? <a className="stat-link" href={stat.href} onClick={onLink}>{stat.text}</a> : stat.text}</span></Fragment>)}
      actions={<>{me ? <a className="button" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />}>
        <div className="popover-title">Push your first project</div>
        <CommandTabs tabs={[
          { label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] },
          { label: "xo", lines: ['pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"', "xo login", "spacehub project create notes --source . --push"] },
        ]} note={<>Both need the hub's CLI: <code>scripts/install-cli.sh</code> (or <code>install-cli.ps1</code> on Windows) from quirq-ai/space-hub. xo is XO's command line; <code>xo login</code> signs you in to XO and this hub. <a href="/-/guide">Read the guide</a>.</>} />
      </Popover>}</>}>
      <LiveNow variant="strip" here={view.meta.here} agents={view.meta.agentList} />
    </PageHeader>
    <Browser head={<>{count(shownSpaces, "space")} · {recent.length} newest {recent.length === 1 ? "project" : "projects"}</>} groups={[...groups, { key: "recent", title: "Recently pushed", note: "The newest pushes across the hub, wherever they landed.", cards: recent.map(project => {
      const [space, name] = project.fullName.split("/");
      return { key: project.fullName, name: project.fullName, search: project.description, people: peopleByProject.get(project.fullName), href: placeUrl({ space, project: name }), time: project.pushedAt, icon: <Glyph><FolderGit2 size={17} /></Glyph>,
        title: project.fullName, detail: project.description || undefined, latest: latestOf(byProject.get(project.fullName)), fresh: !!seen[project.fullName] && project.pushedAt > seen[project.fullName] };
    }) }]} />
    {!recent.length && <p className="quiet">No projects yet. <a href="/-/guide">Read the guide</a> to push the first one.</p>}
    {!view.meta.spaces && <p className="quiet"><Building2 size={14} /> Sign up and push a project to start the first space.</p>}
  </div>;
}

/** Cards for the hub's lists of builders and orgs: each with its projects, agents and latest change. */
function spaceCards(view: View<HubMeta>, seen: Record<string, string>) {
  const agents = new Map<string, number>();
  for (const agent of view.meta.agentList) agents.set(agent.parent, (agents.get(agent.parent) ?? 0) + 1);
  const bySpace = newestBy(view.meta.activity, item => item.path.split("/")[0]);
  const peopleBySpace = activeBy(view.meta.activity, item => item.path.split("/")[0]);
  return (space: Entry, kind: string, labels?: ReactNode) => {
    const owned = agents.get(space.name) ?? 0;
    return {
      key: space.name, name: space.name, search: space.detail, people: peopleBySpace.get(space.name), href: placeUrl({ space: space.name, project: "" }), time: space.modifiedAt,
      icon: <Avatar name={space.name} size={34} kind={kind} />, title: space.name, labels,
      detail: [space.detail?.replace(/^\w+ · /, ""), owned ? count(owned, "agent") : ""].filter(Boolean).join(" · "),
      latest: latestOf(bySpace.get(space.name)), fresh: !!seen[space.name] && space.modifiedAt > seen[space.name],
    };
  };
}

/** Every org on the hub: the ones you belong to first. */
function OrgsTab({ view, mySpaces, seen }: { view: View<HubMeta>; mySpaces: string[]; seen: Record<string, string> }) {
  const orgs = view.snapshot.directory.entries.filter(space => kindOf(space.detail) === "org");
  const mine = new Set(mySpaces);
  const card = spaceCards(view, seen);
  const yours = orgs.filter(space => mine.has(space.name));
  return <div className="page">
    <PageHeader title="Orgs" subtitle="Teams on this hub. Their members push to every project they hold." />
    {orgs.length ? <Browser head={count(orgs.length, "org")} groups={[
      { key: "mine", title: "Your orgs", note: "The orgs you belong to.", cards: yours.map(space => card(space, "org", <span className="label quiet-label">Member</span>)) },
      { key: "orgs", title: yours.length ? "Other orgs" : "Orgs", note: "Newest change first; filter to find one.", cards: orgs.filter(space => !mine.has(space.name)).map(space => card(space, "org")) },
    ]} /> : <Empty icon={<Building2 size={20} />} title="No orgs yet"><p>Create one with <code>spacehub space create &lt;name&gt;</code>.</p></Empty>}
  </div>;
}

/** Every builder on the hub: who is connected now first. */
function BuildersTab({ view, me, seen }: { view: View<HubMeta>; me: string | null; seen: Record<string, string> }) {
  const builders = view.snapshot.directory.entries.filter(space => kindOf(space.detail) === "personal");
  const here = new Set(view.meta.here.map(who => who.agent));
  const cards = spaceCards(view, seen);
  const card = (space: Entry) => cards(space, "personal", here.has(space.name) ? <span className="label done"><i className="online-dot" />here now</span> : space.name === me ? <span className="label quiet-label">You</span> : undefined);
  const connected = builders.filter(space => here.has(space.name)).length;
  return <div className="page">
    <PageHeader title="Builders" subtitle="People on this hub. Each has a space named after them for their projects and agents." />
    {builders.length ? <Browser head={<>{count(builders.length, "builder")}{connected ? <> · <span className="strip-here"><i className="online-dot" />{connected} connected now</span></> : null}</>} groups={[
      { key: "here", title: "Connected now", note: "Working from a clone, autosync or the app right now.", cards: builders.filter(space => here.has(space.name)).map(card) },
      { key: "builders", title: connected ? "Everyone else" : "Builders", note: "Newest change first; filter to find someone.", cards: builders.filter(space => !here.has(space.name)).map(card) },
    ]} /> : <Empty icon={<Users size={20} />} title="No builders yet"><p>Sign up with <code>spacehub auth login</code> to be the first.</p></Empty>}
    <p className="quiet browser-none">GitHub accounts credited for imported code are listed on <a href="/-/builders">the builders page</a>.</p>
  </div>;
}
