import { useEffect, useRef } from "react";
import { BookOpen, Bot, Boxes, Download, GitBranch, GitCommitHorizontal, HardDrive, Users } from "lucide-react";
import { placeUrl, rawUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, navigate, onLink, type Route } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, Empty, ErrorNote, Popover, Skeleton } from "@/ui/primitives";
import { ActivityStream, HereNow, People, PlaceBar, RecentActivity } from "./common";
import { ChatSection } from "./chat-section";
import { BranchesTab, CodeTab, CommitTab, CommitsTab } from "./code";
import { DepsTab } from "./deps";
import { entryIcon, FilesTab, isChannel, SECTION_ICONS, SECTION_ORDER } from "./files";
import { GoalPanel } from "./goal";
import { Markdown, RawFiles } from "@/components/content-view";
import { CardGroup, Glyph } from "@/ui/cards";
import { Overview, Panel, ProjectMark, Stat, Stats } from "@/ui/overview";

type ProjectRoute = Extract<Route, { page: "project" }>;

const filesHref = (place: Place, path: string) => placeUrl(place, hashOf("files", { path }));

/** A project: its bar (what it is, its sections), then the section open: its overview, or the files, code, chat, activity or contributors in a panel. */
export function ProjectPage({ route, view, error, me, signIn, refresh }: { route: ProjectRoute; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void }) {
  const { place } = route;
  const meta = view?.meta;
  const base = placeUrl(place);
  const raw = meta ? (file: string) => rawUrl(place, meta.defaultBranch, file) : undefined;
  // The Chat folder's channels are the project's chat, when it has them; otherwise its one chat (Chat/chat.json).
  const chatRoot = view?.snapshot.roots.find(root => root.name.toLowerCase() === "chat")?.path;
  const path = route.tab === "files" ? route.path : "";
  const inChat = !!chatRoot && (path === chatRoot || path.startsWith(chatRoot + "/"));
  const overview = route.tab === "files" && !path && route.as !== "folder";
  const tab = overview ? "overview" : route.tab === "files" ? (inChat ? "chat" : "files") : route.tab === "commit" || route.tab === "commits" || route.tab === "branches" ? "code" : route.tab;
  const people = meta ? new Set([...meta.owners, ...meta.members, ...meta.collaborators, ...meta.agents]).size : undefined;
  const chatty = route.tab === "files" && view && (view.snapshot.file?.format === "json" || (!view.snapshot.file && route.as !== "folder" && isChannel(view.snapshot)));
  return <RawFiles.Provider value={raw}><div className={`place${chatty || route.tab === "chat" ? " place-chat" : ""}`}>
    <PlaceBar icon={<ProjectMark name={place.project} size={40} />} title={place.project}
      subtitle={meta ? meta.description || `A project of ${place.space}` : error ? undefined : <Skeleton width={220} />}
      actions={meta ? <Popover label="Clone" icon={<Download size={15} />}><CloneProject place={place} /></Popover> : undefined}
      active={tab} tabs={[
        { key: "overview", label: "Overview", href: base },
        { key: "files", label: "Files", href: placeUrl(place, hashOf("files", { as: "folder" })) },
        { key: "code", label: "Code", href: placeUrl(place, hashOf("code")) },
        { key: "chat", label: "Chat", href: chatRoot ? filesHref(place, chatRoot) : placeUrl(place, hashOf("chat")) },
        { key: "activity", label: "Activity", href: placeUrl(place, hashOf("activity")), count: meta?.activity.length || undefined },
        { key: "people", label: "Contributors", href: placeUrl(place, hashOf("people")), count: people },
        ...(meta?.deps || route.tab === "deps" ? [{ key: "deps", label: "Dependencies", href: placeUrl(place, hashOf("deps")), count: meta?.deps || undefined }] : []),
      ]}>
      {meta && <ProjectStrip place={place} meta={meta} />}
    </PlaceBar>
    {!meta && error && <div className="window"><ErrorNote message={error} retry={refresh} /></div>}
    {overview ? <ProjectOverview place={place} view={view} chatRoot={chatRoot} /> : <div className="window">
      {route.tab === "files" && <FilesTab place={place} path={route.path} as={route.as} view={view} error={error} me={me} signIn={signIn} refresh={refresh} />}
      {meta && route.tab === "code" && <CodeTab place={place} ref={route.ref} path={route.path} defaultBranch={meta.defaultBranch} />}
      {meta && route.tab === "commits" && <CommitsTab place={place} ref={route.ref} path={route.path} num={route.num} defaultBranch={meta.defaultBranch} />}
      {route.tab === "commit" && <CommitTab place={place} oid={route.oid} />}
      {route.tab === "deps" && <DepsTab place={place} />}
      {route.tab === "branches" && <BranchesTab place={place} />}
      {meta && route.tab === "chat" && <ChatSection place={place} me={me} signIn={signIn} canStart={!!me && meta.canWrite} />}
      {meta && route.tab === "activity" && <ActivityStream items={meta.activity} agents={meta.agents} />}
      {meta && route.tab === "people" && <>
        {meta.here.length > 0 && <><h2 className="section-title">Here now</h2><HereNow here={meta.here} /></>}
        <Contributors place={place} meta={meta} />
      </>}
    </div>}
  </div></RawFiles.Provider>;
}

/** A project's overview: one row of stats, its goal, its folders (Chat has its own tab) and its README, and beside them what happened lately. */
function ProjectOverview({ place, view, chatRoot }: { place: Place; view: View<ProjectMeta> | undefined; chatRoot?: string }) {
  const first = useRef(true);
  const index = view?.snapshot.directory.entries.find(entry => entry.kind === "file" && entry.name === "index.json");
  // A saved home view opens by itself the first time, unless a link says otherwise.
  useEffect(() => {
    if (!view || !first.current) return;
    first.current = false;
    if (!location.hash && index) navigate(filesHref(place, index.path));
  }, [view, index, place]);
  const meta = view?.meta;
  if (!view || !meta) return <Overview label={place.project}><Stats>{["Code", "Here now", "Latest change", "Contributors"].map(title => <Stat key={title} title={title}><Skeleton width={120} /></Stat>)}</Stats></Overview>;
  const dirs = view.snapshot.directory.entries.filter(entry => entry.kind === "directory" && entry.path !== chatRoot);
  const isSection = (name: string) => SECTION_ICONS.has(name.toLowerCase());
  const sections = dirs.filter(entry => isSection(entry.name)).sort((a, b) => SECTION_ORDER.indexOf(a.name.toLowerCase()) - SECTION_ORDER.indexOf(b.name.toLowerCase()));
  const folders = dirs.filter(entry => !isSection(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const card = (entry: typeof dirs[number]) => {
    const Icon = entryIcon(entry);
    return { key: entry.path, name: entry.name, href: filesHref(place, entry.path), icon: <Glyph tone={isSection(entry.name) ? "accent" : undefined}><Icon size={16} /></Glyph>, title: entry.name, detail: entry.detail || undefined, time: entry.modifiedAt };
  };
  const readme = view.snapshot.directory.docs?.find(doc => /^readme/i.test(doc.name));
  const people = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])];
  const here = [...new Set(meta.here.map(who => who.agent))];
  return <Overview label={place.project} side={<RecentActivity items={meta.activity} href={placeUrl(place, hashOf("activity"))} />}>
    <Stats>
      <Stat title="Code" icon={<HardDrive size={14} />} href={placeUrl(place, hashOf("code"))}>
        <span className="stat-value">{size(meta.bytes)}</span><span className="stat-note">on {meta.defaultBranch}{meta.deps ? ` · ${meta.deps} pinned ${meta.deps === 1 ? "repo" : "repos"}` : ""}</span>
      </Stat>
      <Stat title="Here now" icon={<Users size={14} />} href={placeUrl(place, hashOf("people"))}>
        <span className="stat-value">{here.length ? <><AvatarStack names={here} max={4} size={20} /><span>{here.length}</span></> : "Nobody"}</span>
        <span className="stat-note">{here.length ? "connected now" : "is connected right now"}</span>
      </Stat>
      {meta.head ? <Stat title="Latest change" icon={<GitCommitHorizontal size={14} />} aside={<Ago iso={meta.head.time} />} href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))}>
        <span className="stat-value"><Avatar name={meta.head.author} size={20} /><span className="stat-clip">{meta.head.author}</span></span>
        <span className="stat-note">{meta.head.subject}</span>
      </Stat> : <Stat title="Latest change" icon={<GitCommitHorizontal size={14} />}><span className="stat-value">Nothing yet</span><span className="stat-note">Push the first files</span></Stat>}
      <Stat title="Contributors" icon={<Bot size={14} />} href={placeUrl(place, hashOf("people"))}>
        <span className="stat-value">{people.length ? <><AvatarStack names={people} max={4} size={20} /><span>{people.length}</span></> : "None yet"}</span>
        <span className="stat-note">{meta.agents.length} {meta.agents.length === 1 ? "agent" : "agents"} connected</span>
      </Stat>
    </Stats>
    {meta.goal && <Panel className="goal-block"><GoalPanel place={place} goal={meta.goal} canWrite={meta.canWrite} /></Panel>}
    {index && <a className="callout" href={filesHref(place, index.path)} onClick={onLink}><BookOpen size={18} /><span><strong>Open the saved view</strong><span>index.json</span></span></a>}
    <CardGroup title="Sections" list cards={sections.map(card)} />
    <CardGroup title="Folders" list cards={folders.map(card)} />
    {readme && <Panel className="readme-block" title={readme.name} icon={<BookOpen size={14} />} aside={<a href={filesHref(place, readme.path)} onClick={onLink}>Open</a>}>
      <Markdown content={readme.content} filePath={readme.path} navigate={next => navigate(filesHref(place, next))} />
    </Panel>}
    {!meta.head && <Panel><Empty icon={<Boxes size={20} />} title="Nothing pushed yet"><p>Clone it and push the first files:</p><code>spacehub project clone {place.space}/{place.project}</code></Empty></Panel>}
  </Overview>;
}

/** Everyone who may push here, humans and agents, each saying why. */
function Contributors({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const isAgent = new Set(meta.agents);
  const humans = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])].filter(name => !isAgent.has(name));
  const why = (name: string) => name === meta.founder ? `Founder of ${place.space}` : meta.owners.includes(name) ? `Owner of ${place.space}` : meta.members.includes(name) ? `Member of ${place.space}` : "Collaborator on this project";
  return <People here={meta.here} agents={meta.agents} counted={n => `${n} ${n === 1 ? "contributor" : "contributors"}`} groups={[
    { title: "Humans", names: humans, note: `${place.space}'s ${meta.founder ? "founder, owners" : "owners"} and members, and this project's collaborators.`, detail: why },
    { title: "Agents", names: meta.agents, note: `Agents connected to ${place.space}, or collaborating on this project.`, detail: name => meta.collaborators.includes(name) ? "Collaborator on this project" : `Connected to ${place.space}` },
  ]} />;
}

const MODES: Record<string, string> = { watch: "watching", sync: "syncing", autosync: "editing", agent: "running", app: "in the app" };

/** The project's facts in one line under its name: branch, size, last change, people, who is here. */
function ProjectStrip({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const people = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])];
  const here = [...new Set(meta.here.map(who => who.agent))];
  return <div className="meta-strip">
    <a href={placeUrl(place, hashOf("code"))} onClick={onLink} title="Default branch"><GitBranch size={14} />{meta.defaultBranch}</a>
    <span title="Stored on the hub"><HardDrive size={14} />{size(meta.bytes)}</span>
    {meta.deps > 0 && <a href={placeUrl(place, hashOf("deps"))} onClick={onLink} title="Repositories pinned by DEPS"><Boxes size={14} />{meta.deps} pinned {meta.deps === 1 ? "repo" : "repos"}</a>}
    {meta.head ? <a href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))} onClick={onLink} title={meta.head.subject}><Avatar name={meta.head.author} size={18} /><span>Updated <Ago iso={meta.head.time} /> by {meta.head.author}</span></a> : <span>Nothing pushed yet</span>}
    {people.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={people.join(", ")}><AvatarStack names={people} max={5} size={20} /><span>{people.length} {people.length === 1 ? "person" : "people"}</span></a>}
    {meta.agents.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={meta.agents.join(", ")}><Bot size={14} />{meta.agents.length} {meta.agents.length === 1 ? "agent" : "agents"}</a>}
    {here.length > 0 && <span className="strip-here" title={meta.here.map(who => `${who.agent} · ${MODES[who.mode] ?? who.mode}`).join("\n")}><i className="online-dot" />{here.length} here now</span>}
  </div>;
}

/** How to get the project onto a machine: spacehub or plain git. */
function CloneProject({ place }: { place: Place }) {
  const name = `${place.space}/${place.project}`;
  return <>
    <div className="popover-title">Clone {name}</div>
    <CommandTabs tabs={[
      { label: "spacehub", lines: [`spacehub project clone ${name}`] },
      { label: "git", lines: [`git clone -o quirq quirq://${location.host}/${name}`] },
    ]} note={<>Then keep it in step as you and others edit: <code>spacehub project sync --watch --auto</code></>} />
  </>;
}
