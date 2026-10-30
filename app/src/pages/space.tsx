import { Bot, Building2, Download, FolderGit2, Github, Plus, User, Users } from "lucide-react";
import { activeBy, kindLabel, latestOf, newestBy, placeUrl, size, type AgentInfo, type SpaceMeta, type View } from "@/api";
import { Browser, Glyph } from "@/ui/cards";
import { PathBar } from "@/shell/path-bar";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityList, HereNow, PageHeader, People, Tabs } from "./common";

const KIND_ICON = { personal: <User size={13} />, org: <Building2 size={13} />, agent: <Bot size={13} /> } as Record<string, React.ReactNode>;

/** A builder's profile, an org, or an agent: who they are, what they work on, what they did. */
export function SpacePage({ name, tab, view, error, me, seen }: { name: string; tab: "projects" | "agents" | "activity" | "people"; view: View<SpaceMeta> | undefined; error: string; me: string | null; seen: Record<string, string> }) {
  if (!view) return <div className="page">{error ? <Empty icon={<User size={20} />} title={`No space named ${name}`}><p>{error}</p></Empty> : <><div className="profile-skeleton"><span className="skeleton round" style={{ width: 72, height: 72 }} /><SkeletonRows rows={2} avatar={false} /></div><SkeletonRows rows={5} /></>}</div>;
  const meta = view.meta;
  const projects = [...view.snapshot.directory.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const base = placeUrl({ space: name, project: "" });
  const peopleCount = new Set([...meta.owners, ...meta.members]).size;
  // Agents belong to builders and orgs; an agent's own page has none.
  const hasAgents = meta.kind !== "agent";
  const agentCount = meta.agentList.length;
  const canManage = !!me && meta.owners.includes(me);
  const byProject = newestBy(meta.activity, item => item.path);
  const peopleByProject = activeBy(meta.activity, item => item.path);
  return <div className="page">
    <PathBar place={{ space: name, project: "" }} path="" />
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
      {projects.length || meta.collaborates.length ? <Browser head={<>{projects.length} {projects.length === 1 ? "project" : "projects"} in {name}</>} groups={[
        { key: "projects", title: "Projects", note: `Each one is a git repository on the hub that ${meta.kind === "org" ? "the org's members" : name} push to.`, cards: projects.map(project => {
          const fullName = `${name}/${project.name}`;
          return { key: project.name, name: project.name, search: project.detail, people: peopleByProject.get(fullName), href: placeUrl({ space: name, project: project.name }), icon: <Glyph><FolderGit2 size={17} /></Glyph>, title: project.name,
            detail: project.detail || undefined, latest: latestOf(byProject.get(fullName)), time: project.modifiedAt, fresh: !!seen[fullName] && project.modifiedAt > seen[fullName] };
        }) },
        { key: "collaborates", title: "Collaborates on", note: "Projects of other spaces they may push to.", compact: true, cards: meta.collaborates.map(fullName => {
          const [space, project] = fullName.split("/");
          return { key: fullName, name: fullName, href: placeUrl({ space, project }), icon: <Glyph><FolderGit2 size={16} /></Glyph>, title: fullName };
        }) },
      ]} /> : <Empty icon={<FolderGit2 size={20} />} title="No projects yet"><p>Create one with <code>spacehub project create {name}/&lt;name&gt; --source . --push</code>.</p></Empty>}
    </>}
    {tab === "agents" && hasAgents && <AgentList space={name} kind={meta.kind} agents={meta.agentList} canManage={canManage} />}
    {tab === "activity" && <ActivityList items={meta.activity} />}
    {tab === "people" && <>
      {meta.here.length > 0 && <><h2 className="section-title">Here now</h2><HereNow here={meta.here} /></>}
      <People here={meta.here} groups={[{ title: "Owners", names: meta.owners, note: `They manage ${name}.` }, { title: "Members", names: meta.members, note: `They push to every project of ${name}.` }]} />
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
    <Browser head={<>{agents.length} {agents.length === 1 ? "agent" : "agents"}{running ? <> · <span className="strip-here"><i className="online-dot" />{running} running</span></> : null}</>}
      actions={canManage && <Popover label="Add an agent" icon={<Plus size={15} />}><div className="popover-title">Add an agent to {space}</div>{commands}</Popover>}
      groups={[{ key: "running", title: "Running", note: "Connected now, on the machine named.", keep: (agent: AgentInfo) => agent.running.length > 0 },
      { key: "idle", title: "Not running", note: "Start one with spacehub agent run, or from Agenthub.", keep: (agent: AgentInfo) => !agent.running.length }].map(group =>
      ({ key: group.key, title: group.title, note: group.note, cards: agents.filter(group.keep).map(agent => ({
        key: agent.name, name: agent.name, search: `${agent.description} ${agent.parent} ${agent.spaces.join(" ")}`, href: placeUrl({ space: agent.name, project: "" }), icon: <Avatar name={agent.name} size={34} kind="agent" />, title: agent.name,
        labels: agent.running.length ? <span className="label done"><i className="online-dot" />{agent.running.map(r => r.host || "a machine").join(", ")}</span> : undefined,
        detail: agent.description || undefined, latest: { text: roleNote(agent) }, time: agent.running[0]?.since,
      })) }))} />
  </>;
}
