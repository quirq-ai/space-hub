import { Activity, Building2, FolderGit2, Plus, Rocket } from "lucide-react";
import { placeUrl, size, type HubMeta, type View } from "@/api";
import { onLink } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, PageHeader } from "./common";

export function HomePage({ view, me, activityOpen, onActivity }: { view: View<HubMeta> | undefined; me: string | null; activityOpen: boolean; onActivity: () => void }) {
  const activity = <button className="button" type="button" aria-pressed={activityOpen} onClick={onActivity}><Activity size={15} />Activity</button>;
  if (!view) return <div className="page"><PageHeader title="spacehub" subtitle="Loading the hub…" actions={activity} /><SkeletonRows rows={6} /></div>;
  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  return <div className="page">
    <PageHeader title="spacehub" subtitle={`${view.meta.spaces} spaces · ${view.meta.projects} projects · ${size(view.meta.bytes)} stored`}
      actions={<>{activity}{me ? <a className="button" href="/-/new"><Plus size={15} />New project</a> : <Popover label="Get started" icon={<Rocket size={15} />}>
        <div className="popover-title">Push your first project</div>
        <CommandTabs tabs={[{ label: "spacehub", lines: ["spacehub auth login", "spacehub project create notes --source . --push"] }]} note={<>Install the CLI with <code>scripts/install-cli.sh</code> from quirq-ai/space-hub. <a href="/-/guide">Read the guide</a>.</>} />
      </Popover>}</>}>
      {view.meta.here.length > 0 && <div className="meta-strip"><span className="strip-here" title={view.meta.here.map(who => `${who.agent}${who.project ? ` · ${who.project}` : ""}`).join("\n")}><i className="online-dot" />{new Set(view.meta.here.map(who => who.agent)).size} connected now</span><AvatarStack names={[...new Set(view.meta.here.map(who => who.agent))]} max={8} size={20} /></div>}
    </PageHeader>
    <h2 className="section-title">Spaces</h2>
    <ul className="card-grid">{spaces.map(space => <li key={space.name}><a className="space-card" href={placeUrl({ space: space.name, project: "" })} onClick={onLink}>
      <Avatar name={space.name} size={40} kind={space.detail?.startsWith("org") ? "org" : space.detail?.startsWith("agent") ? "agent" : "personal"} />
      <span className="space-card-text"><strong>{space.name}</strong><span>{space.detail}</span></span>
    </a></li>)}</ul>
    <h2 className="section-title">Recently pushed</h2>
    {recent.length ? <ul className="rows">{recent.map(project => {
      const [space, name] = project.fullName.split("/");
      return <li key={project.fullName}><a className="row" href={placeUrl({ space, project: name })} onClick={onLink}>
        <FolderGit2 size={18} className="row-icon" /><span className="row-main"><strong>{project.fullName}</strong>{project.description && <span>{project.description}</span>}</span><span className="row-meta"><Ago iso={project.pushedAt} /></span>
      </a></li>;
    })}</ul> : <p className="quiet">No projects yet. <a href="/-/guide">Read the guide</a> to push the first one.</p>}
    {!view.meta.spaces && <p className="quiet"><Building2 size={14} /> Sign up and push a project to start the first space.</p>}
  </div>;
}

/** The hub's activity in the right panel: on open the entries come in one after another, then each new one slides in at the top. */
export function ActivityFeed({ view }: { view: View<HubMeta> | undefined }) {
  return <div className="feed">{view ? <ActivityList items={view.meta.activity} compact /> : <SkeletonRows rows={6} />}</div>;
}
