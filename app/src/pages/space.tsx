import { Bot, Building2, Download, FolderGit2, Github, Plus, User, Users } from "lucide-react";
import { kindLabel, placeUrl, size, type AgentInfo, type SpaceMeta, type View } from "@/api";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, HereNow, PageHeader, People, Tabs } from "./common";

const KIND_ICON = { personal: <User size={13} />, org: <Building2 size={13} />, agent: <Bot size={13} /> } as Record<string, React.ReactNode>;

/** A builder's profile, an org, or an agent: who they are, what they work on, what they did. */
export function SpacePage({ name, tab, view, error, me }: { name: string; tab: "projects" | "agents" | "activity" | "people"; view: View<SpaceMeta> | undefined; error: string; me: string | null }) {
  if (!view) return <div className="page">{error ? <Empty icon={<User size={20} />} title={`No space named ${name}`}><p>{error}</p></Empty> : <><div className="profile-skeleton"><span className="skeleton round" style={{ width: 72, height: 72 }} /><SkeletonRows rows={2} avatar={false} /></div><SkeletonRows rows={5} /></>}</div>;
  const meta = view.meta;
  const projects = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const base = placeUrl({ space: name, project: "" });
  const peopleCount = new Set([...meta.owners, ...meta.members]).size;
  // Agents belong to builders and orgs; an agent's own page has none.
  const hasAgents = meta.kind !== "agent";
  const agentCount = meta.agentList.length;
  const canManage = !!me && meta.owners.includes(me);
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
        {meta.kind === "org" && <a href={base + "#" + hashOf("people")} onClick={onLink} title="Members and agents of this org"><Users size={14} />{peopleCount + agentCount} in the team: {peopleCount} {peopleCount === 1 ? "member" : "members"} and {agentCount} {agentCount === 1 ? "agent" : "agents"}</a>}
        {meta.kind === "personal" && agentCount > 0 && <a href={base + "#" + hashOf("agents")} onClick={onLink}><Bot size={14} />{agentCount} {agentCount === 1 ? "agent" : "agents"}</a>}
        {meta.githubLogin && <a href={meta.github || `https://github.com/${meta.githubLogin}`} target="_blank" rel="noreferrer"><Github size={14} />{meta.githubLogin}</a>}
        {meta.here.length > 0 && <a className="strip-here" href={base + "#" + hashOf("people")} onClick={onLink} title={meta.here.map(who => who.agent).join(", ")}><i className="online-dot" />{new Set(meta.here.map(who => who.agent)).size} here now</a>}
      </div>
      {meta.memberOf.length > 0 && <div className="profile-links">
        {meta.memberOf.map(role => <a key={role.space} className="chip-link" href={placeUrl({ space: role.space, project: "" })} onClick={onLink}><Avatar name={role.space} size={18} kind={role.kind} />{role.space}{role.role === "owner" && <span className="quiet">owner</span>}</a>)}
      </div>}
    </PageHeader>
    <Tabs active={tab} tabs={[
      { key: "projects", label: "Projects", href: base, count: meta.projects },
      ...(hasAgents ? [{ key: "agents", label: "Agents", href: base + "#" + hashOf("agents"), count: agentCount }] : []),
      { key: "people", label: meta.kind === "org" ? "Members" : "People", href: base + "#" + hashOf("people"), count: peopleCount || undefined },
      { key: "activity", label: "Activity", href: base + "#" + hashOf("activity") },
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
    {tab === "agents" && hasAgents && <AgentList space={name} kind={meta.kind} agents={meta.agentList} canManage={canManage} />}
    {tab === "activity" && <ActivityList items={meta.activity} />}
    {tab === "people" && <>
      <h2 className="section-title">Here now</h2><HereNow here={meta.here} />
      <People groups={[{ title: "Owners", names: meta.owners }, { title: "Members", names: meta.members }]} />
    </>}
  </div>;
}

/** Who owns the agent and where it may push. */
const roleNote = (agent: AgentInfo) =>
  `Owned by ${agent.parent} · ${agent.spaces.length ? `pushes to ${agent.spaces.join(", ")}` : "not connected to a space yet"}`;

/** The agents of a space: the ones it owns and the ones allowed to push here, with where they run. */
function AgentList({ space, kind, agents, canManage }: { space: string; kind: string; agents: AgentInfo[]; canManage: boolean }) {
  const running = agents.filter(agent => agent.running.length).length;
  const commands = <CommandTabs tabs={[
    { label: "Create", lines: [`spacehub agent create <name>${kind === "org" ? ` --in ${space}` : ""} -d "what it does"`] },
    { label: "Connect", lines: [`spacehub agent connect <agent> ${space}`] },
    { label: "Run", lines: ["spacehub agent run <agent>"] },
  ]} note="An agent is a space with its own identity: its home project holds its instructions and memory, and it pushes to the spaces it is connected to." />;
  if (!agents.length) return <Empty icon={<Bot size={20} />} title="No agents yet"><p>Create one{kind === "org" ? " for this org" : ""}, or connect an agent you own so it can push here.</p><div className="empty-commands">{commands}</div></Empty>;
  return <>
    <div className="list-head"><span>{agents.length} {agents.length === 1 ? "agent" : "agents"}{running ? <> · <span className="strip-here"><i className="online-dot" />{running} running</span></> : null}</span>
      {canManage && <Popover label="Add an agent" icon={<Plus size={15} />}><div className="popover-title">Add an agent to {space}</div>{commands}</Popover>}</div>
    <ul className="agent-list">{agents.map(agent => <li key={agent.name}>
      <a className="agent-card" href={placeUrl({ space: agent.name, project: "" })} onClick={onLink}>
        <Avatar name={agent.name} size={40} kind="agent" />
        <span className="agent-main">
          <span className="agent-name"><strong>{agent.name}</strong><span className="kind-badge"><Bot size={12} />Agent</span>{agent.running.length > 0 ? <span className="strip-here"><i className="online-dot" />Running on {agent.running.map(r => r.host || "a machine").join(", ")}</span> : <span className="quiet">Not running</span>}</span>
          {agent.description && <span className="agent-desc">{agent.description}</span>}
          <span className="agent-meta">{roleNote(agent)}{agent.running[0] && <> · running since <Ago iso={agent.running[0].since} /></>}</span>
        </span>
      </a>
    </li>)}</ul>
  </>;
}
