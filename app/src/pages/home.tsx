import { Building2, FolderGit2, Plus } from "lucide-react";
import { placeUrl, size, type HubMeta, type View } from "@/api";
import { onLink } from "@/router";
import { Ago, Avatar, SkeletonRows } from "@/ui/primitives";
import { ActivityList, PageHeader } from "./common";

export function HomePage({ view, me }: { view: View<HubMeta> | undefined; me: string | null }) {
  if (!view) return <div className="page"><PageHeader title="spacehub" subtitle="Loading the hub…" /><SkeletonRows rows={6} /></div>;
  const spaces = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const recent = view.meta.allProjects.slice(0, 8);
  return <div className="page">
    <PageHeader title="spacehub" subtitle={`${view.meta.spaces} spaces · ${view.meta.projects} projects · ${size(view.meta.bytes)} stored`}
      actions={me ? <a className="button" href="/-/new"><Plus size={15} />New project</a> : <a className="button" href="/-/guide">How it works</a>} />
    <div className="home-grid">
      <section>
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
      </section>
      <section>
        <h2 className="section-title">Activity</h2>
        <ActivityList items={view.meta.activity} compact />
      </section>
    </div>
    {!view.meta.spaces && <p className="quiet"><Building2 size={14} /> Sign up and push a project to start the first space.</p>}
  </div>;
}
