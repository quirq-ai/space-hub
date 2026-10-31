import { Fragment } from "react";
import { Activity, Building2, FolderGit2, Plus, Rocket } from "lucide-react";
import { activeBy, count, kindLabel, latestOf, newestBy, placeUrl, size, type HubMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { Browser, Glyph } from "@/ui/cards";
import { Avatar, AvatarStack, CommandTabs, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, PageHeader } from "./common";
import { SubhubPresence } from "@/components/subhub-presence";

const kindOf = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

/** The hub's spaces, yours first, then by kind. */
const GROUPS: { key: string; title: string; note: string; keep: (space: Entry, mine: Set<string>) => boolean }[] = [
  { key: "mine", title: "Your spaces", note: "Your own space and the orgs you belong to.", keep: (space, mine) => mine.has(space.name) },
  { key: "org", title: "Orgs", note: "Teams: their members push to every project they hold.", keep: (space, mine) => !mine.has(space.name) && kindOf(space.detail) === "org" },
  { key: "personal", title: "Builders", note: "People, each with a space named after them.", keep: (space, mine) => !mine.has(space.name) && kindOf(space.detail) === "personal" },
  { key: "agent", title: "Agents", note: "AI agents: a home project holds each one's instructions and memory.", keep: (space, mine) => !mine.has(space.name) && kindOf(space.detail) === "agent" },
];

export function HomePage({ view, me, mySpaces, seen, activityOpen, onActivity }: { view: View<HubMeta> | undefined; me: string | null; mySpaces: string[]; seen: Record<string, string>; activityOpen: boolean; onActivity: () => void }) {
  const activity = <button className="button" type="button" aria-pressed={activityOpen} onClick={onActivity}><Activity size={15} />Activity</button>;
  if (!view) return <div className="page"><PageHeader title="spacehub" subtitle="Loading the hub…" actions={activity} /><SkeletonRows rows={6} /></div>;
  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  const mine = new Set(mySpaces);
  const bySpace = newestBy(view.meta.activity, item => item.path.split("/")[0]);
  const byProject = newestBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  const peopleBySpace = activeBy(view.meta.activity, item => item.path.split("/")[0]);
  const peopleByProject = activeBy(view.meta.activity, item => item.path.includes("/") ? item.path : "");
  return <div className="page">
    <PageHeader title="spacehub" subtitle={[count(view.meta.spaces, "space"), count(view.meta.projects, "project"), `${size(view.meta.bytes)} stored`,
      count(view.meta.events, "activity event"), count(view.meta.humans, "human"), count(view.meta.agents, "agent")]
      .map((stat, i) => <Fragment key={stat}>{i > 0 && " "}<span className="stat">{i > 0 && "· "}{stat}</span></Fragment>)}
      actions={<>{activity}{me ? <a className="button" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />}>
        <div className="popover-title">Push your first project</div>
        <CommandTabs tabs={[
          { label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] },
          { label: "xo", lines: ['pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"', "xo login", "spacehub project create notes --source . --push"] },
        ]} note={<>Both need the hub's CLI: <code>scripts/install-cli.sh</code> from quirq-ai/space-hub. xo is XO's command line; <code>xo login</code> signs you in to XO and this hub. <a href="/-/guide">Read the guide</a>.</>} />
      </Popover>}</>}>
      {view.meta.here.length > 0 && <div className="meta-strip"><span className="strip-here" title={view.meta.here.map(who => `${who.agent}${who.project ? ` · ${who.project}` : ""}`).join("\n")}><i className="online-dot" />{new Set(view.meta.here.map(who => who.agent)).size} connected now</span><AvatarStack names={[...new Set(view.meta.here.map(who => who.agent))]} max={8} size={20} /></div>}
      <div className="meta-strip"><SubhubPresence compact /></div>
    </PageHeader>
    <Browser head={<>{count(spaces.length, "space")} and the {count(recent.length, "newest project")}</>} groups={[...GROUPS.map(group => ({ key: group.key, title: group.title, note: group.note, cards: spaces.filter(space => group.keep(space, mine)).map(space => {
      const kind = kindOf(space.detail);
      return {
        key: space.name, name: space.name, search: `${kindLabel(kind)} ${space.detail ?? ""}`, people: peopleBySpace.get(space.name), href: placeUrl({ space: space.name, project: "" }), time: space.modifiedAt,
        icon: <Avatar name={space.name} size={34} kind={kind} />, title: space.name, labels: <span className="label quiet-label">{kindLabel(kind)}</span>,
        detail: space.detail?.replace(/^\w+ · /, ""), latest: latestOf(bySpace.get(space.name)), fresh: !!seen[space.name] && space.modifiedAt > seen[space.name],
      };
    }) })), { key: "recent", title: "Recently pushed", note: "The newest pushes across the hub, wherever they landed.", cards: recent.map(project => {
      const [space, name] = project.fullName.split("/");
      return { key: project.fullName, name: project.fullName, search: project.description, people: peopleByProject.get(project.fullName), href: placeUrl({ space, project: name }), time: project.pushedAt, icon: <Glyph><FolderGit2 size={17} /></Glyph>,
        title: project.fullName, detail: project.description || undefined, latest: latestOf(byProject.get(project.fullName)), fresh: !!seen[project.fullName] && project.pushedAt > seen[project.fullName] };
    }) }]} />
    {!recent.length && <p className="quiet">No projects yet. <a href="/-/guide">Read the guide</a> to push the first one.</p>}
    {!view.meta.spaces && <p className="quiet"><Building2 size={14} /> Sign up and push a project to start the first space.</p>}
  </div>;
}

/** The hub's activity in the right panel: on open the entries come in one after another, then each new one slides in at the top. */
export function ActivityFeed({ view }: { view: View<HubMeta> | undefined }) {
  return <div className="feed">{view ? <ActivityList items={view.meta.activity} compact /> : <SkeletonRows rows={6} />}</div>;
}
