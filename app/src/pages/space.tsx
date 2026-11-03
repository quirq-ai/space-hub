import { useState } from "react";
import { Bot, Building2, Download, FolderGit2, GitCommitHorizontal, Github, Image as ImageIcon, Plus, Target, User, Users } from "lucide-react";
import { Meter } from "./goal";
import { activityLine, kindLabel, placeUrl, setSpacePicture, size, type AgentInfo, type SpaceMeta, type View } from "@/api";
import type { Entry } from "@/lib/types";
import { Browser } from "@/ui/cards";
import { hashOf, onLink } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, Empty, Popover, SkeletonRows } from "@/ui/primitives";
import { ActivityStream, HereNow, People, PlaceBar, RecentActivity } from "./common";
import { ChatSection } from "./chat-section";
import { AppGrid, HomeScreen, Widget, Widgets } from "@/ui/home-screen";
import { projectIcon, projectIcons } from "@/shell/dock-icons";

const KIND_ICON = { personal: <User size={13} />, org: <Building2 size={13} />, agent: <Bot size={13} /> } as Record<string, React.ReactNode>;

/** A builder's profile, an org, or an agent: its bar (who they are, its sections), then the section open: its overview (the space at a glance, its projects as apps, what happened lately), or a list in a panel. */
export function SpacePage({ name, tab, view, error, me, signIn, seen }: { name: string; tab: "projects" | "agents" | "chat" | "activity" | "people"; view: View<SpaceMeta> | undefined; error: string; me: string | null; signIn: string; seen: Record<string, string> }) {
  if (!view) return <div className="place">{error ? <div className="window"><Empty icon={<User size={20} />} title={`No space named ${name}`}><p>{error}</p></Empty></div>
    : <header className="place-bar"><div className="profile-skeleton"><span className="skeleton round" style={{ width: 52, height: 52 }} /><SkeletonRows rows={1} avatar={false} /></div></header>}</div>;
  const meta = view.meta;
  const base = placeUrl({ space: name, project: "" });
  const canManage = !!me && meta.owners.includes(me);
  const peopleCount = new Set([...meta.owners, ...meta.members]).size;
  const agentCount = meta.agentList.length;
  // Agents belong to builders and orgs; an agent's own page has none. Orgs and agents have one chat each.
  const hasAgents = meta.kind !== "agent";
  const hasChat = meta.kind === "org" || meta.kind === "agent";
  return <div className={`place${tab === "chat" ? " place-chat" : ""}`}>
    <PlaceBar icon={<Avatar name={name} size={52} kind={meta.kind} />} title={meta.displayName} badge={<span className="kind-badge">{KIND_ICON[meta.kind]}{kindLabel(meta.kind)}</span>}
      subtitle={meta.description || (meta.kind === "agent" ? `An agent of ${meta.parent}` : meta.kind === "org" ? "An org on this hub" : `@${name}`)}
      actions={<>
        <Popover label="Clone" icon={<Download size={15} />}><div className="popover-title">Clone every project of {name}</div><CommandTabs tabs={[{ label: "spacehub", lines: [`spacehub space clone ${name}`] }]} note={<>Then keep them all in step: <code>spacehub space sync --watch --auto</code></>} /></Popover>
        {meta.kind === "org" && canManage && <Popover label="Picture" icon={<ImageIcon size={15} />} width={380}><OrgPicture name={name} login={meta.githubLogin} /></Popover>}
        {me && (meta.owners.includes(me) || meta.members.includes(me)) && <a className="button primary" href="/-/new"><Plus size={15} />New project</a>}
      </>}
      active={tab} tabs={[
        { key: "projects", label: "Projects", href: base, count: meta.projects },
        ...(hasAgents ? [{ key: "agents", label: "Agents", href: base + "#" + hashOf("agents"), count: agentCount }] : []),
        { key: "people", label: meta.kind === "org" ? "Members" : "People", href: base + "#" + hashOf("people"), count: peopleCount || undefined },
        ...(hasChat ? [{ key: "chat", label: "Chat", href: base + "#" + hashOf("chat") }] : []),
        { key: "activity", label: "Activity", href: base + "#" + hashOf("activity"), count: meta.activity.length || undefined },
      ]}>
      <div className="profile-facts">
        <span><FolderGit2 size={14} />{meta.projects} {meta.projects === 1 ? "project" : "projects"}</span>
        <span>{size(meta.bytes)} stored</span>
        <span><span>Joined <Ago iso={meta.createdAt} /></span></span>
        {meta.kind === "org" && <a href={base + "#" + hashOf("people")} onClick={onLink} title="Members and agents of this org"><Users size={14} />{peopleCount} {peopleCount === 1 ? "member" : "members"}, {agentCount} {agentCount === 1 ? "agent" : "agents"}</a>}
        {meta.githubLogin && <a href={meta.github || `https://github.com/${meta.githubLogin}`} target="_blank" rel="noreferrer"><Github size={14} />{meta.githubLogin}</a>}
        {!!meta.aliases?.length && <span title={`These addresses show ${name} too`}>Also {meta.aliases.map(alias => "/" + alias).join(", ")}</span>}
        {meta.memberOf.map(role => <a key={role.space} className="chip-link" href={placeUrl({ space: role.space, project: "" })} onClick={onLink}><Avatar name={role.space} size={18} kind={role.kind} />{role.space}{role.founder ? <span className="quiet">founder</span> : role.role === "owner" && <span className="quiet">owner</span>}</a>)}
      </div>
    </PlaceBar>
    {tab === "projects" ? <SpaceOverview name={name} meta={meta} projects={view.snapshot.directory.entries} seen={seen} /> : <div className="window">
      {tab === "agents" && hasAgents && <AgentList space={name} kind={meta.kind} agents={meta.agentList} canManage={canManage} />}
      {/* An agent's owners are its parent's, which this view does not list: the hub decides. */}
      {tab === "chat" && hasChat && <ChatSection place={{ space: name, project: "" }} kind={meta.kind} me={me} signIn={signIn} canStart={!!me && (meta.kind === "org" ? meta.owners.includes(me) || meta.members.includes(me) : true)} />}
      {tab === "activity" && <ActivityStream items={meta.activity} agents={[...new Set([...meta.agentList.map(agent => agent.name), ...meta.agents])]} />}
      {tab === "people" && <>
        {meta.here.length > 0 && <><h2 className="section-title">Here now</h2><HereNow here={meta.here} /></>}
        <People here={meta.here} groups={[
          // The builder who started an org is its founder; owners added later manage it with them.
          { title: "Founder", names: meta.founder ? [meta.founder] : [], note: `They started ${name}.` },
          { title: "Owners", names: meta.owners.filter(owner => owner !== meta.founder), note: `They manage ${name}.` },
          { title: "Members", names: meta.members, note: `They push to every project of ${name}.` },
        ]} />
      </>}
    </div>}
  </div>;
}

/** A space's overview: a row of stats, its projects as apps right below, then what happened lately. */
function SpaceOverview({ name, meta, projects: entries, seen }: { name: string; meta: SpaceMeta; projects: Entry[]; seen: Record<string, string> }) {
  const projects = [...entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  // The same colors as anywhere else this space's projects show.
  const icons = projectIcons(projects.map(project => project.name));
  return <HomeScreen label={name}>
    <Widgets>{overviewOf(name, meta, projects)}</Widgets>
    <AppGrid title="Projects" apps={projects.map(project => {
      const fullName = `${name}/${project.name}`;
      return { key: project.name, label: project.name, href: placeUrl({ space: name, project: project.name }), icon: icons.get(project.name)!, title: [project.name, project.goal || project.detail].filter(Boolean).join(": "), badge: !!seen[fullName] && project.modifiedAt > seen[fullName] };
    })} />
    <AppGrid title="Collaborates on" apps={meta.collaborates.map(fullName => {
      const [space, project] = fullName.split("/");
      return { key: fullName, label: project, title: fullName, href: placeUrl({ space, project }), icon: projectIcon(project) };
    })} />
    {!projects.length && !meta.collaborates.length && <Widget size="full" className="empty-widget"><Empty icon={<FolderGit2 size={20} />} title="No projects yet"><p>Create one with <code>spacehub project create {name}/&lt;name&gt; --source . --push</code>.</p></Empty></Widget>}
    <RecentActivity items={meta.activity} href={placeUrl({ space: name, project: "" }, hashOf("activity"))} />
  </HomeScreen>;
}

const PUSHED = new Set(["ref_created", "ref_updated", "ref_forced"]);

/** A builder's or an org's space at a glance, as one row of small widgets: goals in progress, agents running, who is here, the newest push. */
function overviewOf(name: string, meta: SpaceMeta, projects: Entry[]) {
  const base = placeUrl({ space: name, project: "" });
  const goals = projects.filter(project => project.progress && !project.template);
  const done = goals.reduce((sum, project) => sum + project.progress!.done, 0);
  const total = goals.reduce((sum, project) => sum + project.progress!.total, 0);
  const running = meta.agentList.filter(agent => agent.running.length);
  const here = [...new Set(meta.here.map(who => who.agent))];
  const members = new Set([...meta.owners, ...meta.members]).size;
  const push = meta.activity.find(item => PUSHED.has(item.kind));
  const pushed = push && activityLine(push);
  const widgets = [];
  if (goals.length) widgets.push(<Widget key="goals" href={goals.length === 1 ? placeUrl({ space: name, project: goals[0].name }) : undefined} title="Goals" icon={<Target size={13} />} aside={<Meter done={done} total={total} size="small" />}>
    <span className="widget-value">{done} of {total}</span><span className="widget-note">outcomes done{goals.length === 1 ? ` in ${goals[0].name}` : ` across ${goals.length} projects`}</span>
  </Widget>);
  if (meta.kind !== "agent") widgets.push(<Widget key="agents" href={base + "#" + hashOf("agents")} title="Agents" icon={<Bot size={13} />}>
    <span className="widget-value">{running.length ? <><i className="online-dot" />{running.length} running</> : meta.agentList.length ? "None running" : "No agents"}</span>
    <span className="widget-note">{running.length ? running.map(agent => `${agent.name} on ${agent.running.map(run => run.host || "a machine").join(", ")}`).join(", ") : meta.agentList.length ? `${meta.agentList.length} in all` : "Create one with spacehub agent create"}</span>
  </Widget>);
  widgets.push(<Widget key="here" href={base + "#" + hashOf("people")} title="Here now" icon={<Users size={13} />}>
    <span className="widget-value">{here.length ? <><AvatarStack names={here} max={4} size={22} /><span>{here.length}</span></> : "Nobody"}</span>
    <span className="widget-note">{here.length ? "connected now" : "is connected right now"}{meta.kind === "org" ? ` · ${members} ${members === 1 ? "member" : "members"}` : ""}</span>
  </Widget>);
  if (push && pushed) widgets.push(<Widget key="push" href={pushed.commit || pushed.href || undefined} title="Latest push" icon={<GitCommitHorizontal size={13} />} aside={<Ago iso={push.at} />}>
    <span className="widget-value"><Avatar name={push.agent || "hub"} size={20} /><span className="widget-clip">{push.agent || "someone"}</span></span>
    <span className="widget-note">{push.path}{push.text ? `: ${push.text}` : ""}</span>
  </Widget>);
  return widgets;
}

/** Who owns the agent and where it may push. */
const roleNote = (agent: AgentInfo) =>
  `Owned by ${agent.parent} · ${agent.spaces.length ? `pushes to ${agent.spaces.join(", ")}` : "not connected to a space yet"}`;

/**
 * The agents of a space (the ones it owns and the ones allowed to push
 * there), or of the whole hub when `space` is empty, with where they run.
 */
export function AgentList({ space, kind, agents, canManage }: { space: string; kind: string; agents: AgentInfo[]; canManage: boolean }) {
  const running = agents.filter(agent => agent.running.length).length;
  const commands = <CommandTabs tabs={[
    { label: "Create", lines: [`spacehub agent create <name>${kind === "org" ? ` --in ${space}` : ""} -d "what it does"`] },
    { label: "Connect", lines: [`spacehub agent connect <agent> ${space || "<space>"}`] },
    { label: "Run", lines: ["spacehub agent run <agent>"] },
  ]} note="An agent is a space with its own identity: its home project holds its instructions and memory, and it pushes to the spaces it is connected to." />;
  if (!agents.length) return <Empty icon={<Bot size={20} />} title="No agents yet"><p>{space ? <>Create one{kind === "org" ? " for this org" : ""}, or connect an agent you own so it can push here.</> : "Create the first one: it gets a space of its own, owned by you."}</p><div className="empty-commands">{commands}</div></Empty>;
  return <>
    <Browser head={<>{agents.length} {agents.length === 1 ? "agent" : "agents"}{running ? <> · <span className="strip-here"><i className="online-dot" />{running} running</span></> : null}</>}
      actions={canManage && <Popover label="Add an agent" icon={<Plus size={15} />}><div className="popover-title">{space ? `Add an agent to ${space}` : "Add an agent"}</div>{commands}</Popover>}
      groups={[{ key: "running", title: "Running", note: "Connected now, on the machine named.", keep: (agent: AgentInfo) => agent.running.length > 0 },
      { key: "idle", title: "Not running", note: "Start one with spacehub agent run, or from Agenthub.", keep: (agent: AgentInfo) => !agent.running.length }].map(group =>
      ({ key: group.key, title: group.title, note: group.note, cards: agents.filter(group.keep).map(agent => ({
        key: agent.name, name: agent.name, search: `${agent.description} ${agent.parent} ${agent.spaces.join(" ")}`, href: placeUrl({ space: agent.name, project: "" }), icon: <Avatar name={agent.name} size={34} kind="agent" />, title: agent.name,
        labels: agent.running.length ? <span className="label done"><i className="online-dot" />{agent.running.map(r => r.host || "a machine").join(", ")}</span> : undefined,
        detail: agent.description || undefined, latest: { text: roleNote(agent) }, time: agent.running[0]?.since,
      })) }))} />
  </>;
}

/** For an org's owners: show a GitHub organization's picture for the org, or go back to the default. */
function OrgPicture({ name, login }: { name: string; login: string }) {
  const [value, setValue] = useState(login);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(login);
  const save = async (next: string) => {
    setBusy(true);
    setError("");
    try {
      await setSpacePicture(name, next);
      setValue(next);
      setSaved(next);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };
  return <form className="org-picture" onSubmit={event => { event.preventDefault(); void save(value.trim()); }}>
    <div className="popover-title">Picture from GitHub</div>
    <p className="quiet">{name} shows this GitHub organization's picture across the hub. Nothing else is copied from GitHub.</p>
    <div className="org-picture-row">
      <label className="launch-github"><Github size={14} /><input value={value} placeholder="GitHub organization, like quirq-ai" aria-label="GitHub organization" spellCheck={false} autoCapitalize="off" onChange={event => setValue(event.target.value)} disabled={busy} /></label>
      <button className="button" type="submit" disabled={busy || !value.trim() || value.trim() === saved}>Save</button>
    </div>
    {saved && <button type="button" className="button ghost small" onClick={() => void save("")} disabled={busy}>Use the default picture</button>}
    {error && <p className="org-picture-error" role="alert">{error}</p>}
  </form>;
}
