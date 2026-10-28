import { Bot, Building2, Download, FolderGit2, Github, Plus, User } from "lucide-react";
import { kindLabel, placeUrl, size, type SpaceMeta, type View } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, HereNow, PageHeader, People, Tabs } from "./common";

const KIND_ICON = { personal: <User size={13} />, org: <Building2 size={13} />, agent: <Bot size={13} /> } as Record<string, React.ReactNode>;

/** A builder's profile, an org, or an agent: who they are, what they work on, what they did. */
export function SpacePage({ name, tab, view, error, me }: { name: string; tab: "projects" | "activity" | "people"; view: View<SpaceMeta> | undefined; error: string; me: string | null }) {
  if (!view) return <div className="page">{error ? <Empty icon={<User size={20} />} title={`No space named ${name}`}><p>{error}</p></Empty> : <><div className="profile-skeleton"><span className="skeleton round" style={{ width: 72, height: 72 }} /><SkeletonRows rows={2} avatar={false} /></div><SkeletonRows rows={5} /></>}</div>;
  const meta = view.meta;
  const projects = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const base = placeUrl({ space: name, project: "" });
  const peopleCount = new Set([...meta.owners, ...meta.members]).size;
  return <div className="page">
    <PageHeader
      leading={<Avatar name={name} size={72} kind={meta.kind} />}
      title={<>{meta.displayName}<span className="kind-badge">{KIND_ICON[meta.kind]}{kindLabel(meta.kind)}</span></>}
      subtitle={meta.description || (meta.kind === "agent" ? `An agent of ${meta.parent}` : meta.kind === "org" ? "An org on this hub" : `@${name}`)}
      actions={<>
        <Popover label="Clone" icon={<Download size={15} />}><div className="popover-title">Clone every project of {name}</div><CommandTabs tabs={[{ label: "spacehub", lines: [`spacehub space clone ${name}`] }]} note={<>Then keep them all in step: <code>spacehub space sync --watch --auto</code></>} /></Popover>
        {me && (meta.owners.includes(me) || meta.members.includes(me)) && <a className="button" href="/-/new"><Plus size={15} />New project</a>}
      </>}>
      <div className="profile-facts">
        <span><FolderGit2 size={14} />{meta.projects} {meta.projects === 1 ? "project" : "projects"}</span>
        <span>{size(meta.bytes)} stored</span>
        <span>Joined <Ago iso={meta.createdAt} /></span>
        {meta.githubLogin && <a href={meta.github || `https://github.com/${meta.githubLogin}`} target="_blank" rel="noreferrer"><Github size={14} />{meta.githubLogin}</a>}
        {meta.here.length > 0 && <a className="strip-here" href={base + "#" + hashOf("people")} onClick={onLink} title={meta.here.map(who => who.agent).join(", ")}><i className="online-dot" />{new Set(meta.here.map(who => who.agent)).size} here now</a>}
      </div>
      {(meta.memberOf.length > 0 || meta.agents.length > 0) && <div className="profile-links">
        {meta.memberOf.map(role => <a key={role.space} className="chip-link" href={placeUrl({ space: role.space, project: "" })} onClick={onLink}><Avatar name={role.space} size={18} kind={role.kind} />{role.space}{role.role === "owner" && <span className="quiet">owner</span>}</a>)}
        {meta.agents.map(agent => <a key={agent} className="chip-link" href={placeUrl({ space: agent, project: "" })} onClick={onLink}><Avatar name={agent} size={18} kind="agent" />{agent}<span className="quiet">agent</span></a>)}
      </div>}
    </PageHeader>
    <Tabs active={tab} tabs={[
      { key: "projects", label: "Projects", href: base, count: meta.projects },
      { key: "activity", label: "Activity", href: base + "#" + hashOf("activity") },
      { key: "people", label: meta.kind === "org" ? "Members" : "People", href: base + "#" + hashOf("people"), count: peopleCount || undefined },
    ]} />
    {tab === "projects" && <>
      {projects.length ? <ul className="rows">{projects.map(project => <li key={project.name}><a className="row" href={placeUrl({ space: name, project: project.name })} onClick={onLink}>
        <FolderGit2 size={18} className="row-icon" /><span className="row-main"><strong>{project.name}</strong><span>{project.detail}</span></span><span className="row-meta">Updated <Ago iso={project.modifiedAt} /></span>
      </a></li>)}</ul> : <Empty icon={<FolderGit2 size={20} />} title="No projects yet"><p>Create one with <code>spacehub project create {name}/&lt;name&gt; --source . --push</code>.</p></Empty>}
      {meta.collaborates.length > 0 && <><h2 className="section-title">Collaborates on</h2><ul className="rows">{meta.collaborates.map(fullName => {
        const [space, project] = fullName.split("/");
        return <li key={fullName}><a className="row" href={placeUrl({ space, project })} onClick={onLink}><FolderGit2 size={18} className="row-icon" /><span className="row-main"><strong>{fullName}</strong></span></a></li>;
      })}</ul></>}
    </>}
    {tab === "activity" && <ActivityList items={meta.activity} />}
    {tab === "people" && <>
      <h2 className="section-title">Here now</h2><HereNow here={meta.here} />
      <People groups={[{ title: "Owners", names: meta.owners }, { title: "Members", names: meta.members }]} />
    </>}
  </div>;
}
