import { useEffect, useRef } from "react";
import { BookOpen, Bot, Boxes, Download, FolderOpen, GitBranch, GitCommitHorizontal, HardDrive, Target, Users } from "lucide-react";
import { placeUrl, rawUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, navigate, onLink, type Route } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, Empty, ErrorNote, Popover, Skeleton } from "@/ui/primitives";
import { ActivityStream, HereNow, PageHeader, People } from "./common";
import { ChatSection } from "./chat-section";
import { BranchesTab, CodeTab, CommitTab, CommitsTab } from "./code";
import { DepsTab } from "./deps";
import { FilesTab, isChannel, SECTION_ICONS, SECTION_ORDER } from "./files";
import { GoalPanel, Meter } from "./goal";
import { Markdown, RawFiles } from "@/components/content-view";
import { AppIcon } from "@/ui/app-icon";
import { AppGrid, HomeScreen, Widget, Widgets } from "@/ui/home-screen";
import { APP_ICONS, folderIcon, projectIcon, type DockIcon } from "@/shell/dock-icons";

type ProjectRoute = Extract<Route, { page: "project" }>;

/** An app window's title, its icon, and where its back button goes. */
function windowOf(route: ProjectRoute): { title: string; icon: DockIcon; back: { label: string; href: string } } {
  const { place } = route;
  const home = { label: place.project, href: placeUrl(place) };
  const code = { label: "Code", href: placeUrl(place, hashOf("code")) };
  switch (route.tab) {
    case "files": {
      const parts = route.path.split("/").filter(Boolean);
      if (!parts.length) return { title: "Files", icon: APP_ICONS.files, back: home };
      const parent = parts.slice(0, -1).join("/");
      return { title: parts[parts.length - 1], icon: folderIcon(parts[0]), back: parent ? { label: parts[parts.length - 2], href: placeUrl(place, hashOf("files", { path: parent })) } : home };
    }
    case "code": return { title: "Code", icon: APP_ICONS.code, back: home };
    case "commits": return { title: "History", icon: APP_ICONS.code, back: code };
    case "commit": return { title: "Commit", icon: APP_ICONS.code, back: { label: "History", href: placeUrl(place, hashOf("commits")) } };
    case "branches": return { title: "Branches", icon: APP_ICONS.code, back: code };
    case "deps": return { title: "Dependencies", icon: APP_ICONS.deps, back: home };
    case "chat": return { title: "Chat", icon: APP_ICONS.chat, back: home };
    case "activity": return { title: "Activity", icon: APP_ICONS.activity, back: home };
    case "people": return { title: "Contributors", icon: APP_ICONS.people, back: home };
  }
}

/** A project: its home screen (the project at a glance, its goal, its folders as apps, its README), and its apps in windows. */
export function ProjectPage({ route, view, error, me, signIn, refresh }: { route: ProjectRoute; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void }) {
  const { place } = route;
  const meta = view?.meta;
  const raw = meta ? (file: string) => rawUrl(place, meta.defaultBranch, file) : undefined;
  if (route.tab === "files" && !route.path && route.as !== "folder") return <RawFiles.Provider value={raw}><ProjectHome place={place} view={view} error={error} refresh={refresh} /></RawFiles.Provider>;
  const win = windowOf(route);
  const chatty = route.tab === "files" && view && (view.snapshot.file?.format === "json" || (!view.snapshot.file && route.as !== "folder" && isChannel(view.snapshot)));
  return <RawFiles.Provider value={raw}><div className={`page${chatty || route.tab === "chat" ? " page-chat" : ""}`}>
    {chatty ? <PageHeader back={win.back} /> : <PageHeader back={win.back} leading={<span className="window-icon"><AppIcon icon={win.icon} size={44} /></span>} title={win.title} subtitle={`${place.space}/${place.project}`}
      actions={meta && route.tab !== "files" ? <Popover label="Clone" icon={<Download size={15} />}><CloneProject place={place} /></Popover> : undefined} />}
    {!meta && error && <ErrorNote message={error} retry={refresh} />}
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
  </div></RawFiles.Provider>;
}

const filesHref = (place: Place, path: string) => placeUrl(place, hashOf("files", { path }));

/** A project's home screen: the project and who is at work in widgets, its goal, its top folders as apps, and its README. */
function ProjectHome({ place, view, error, refresh }: { place: Place; view: View<ProjectMeta> | undefined; error: string; refresh: () => void }) {
  const first = useRef(true);
  const index = view?.snapshot.directory.entries.find(entry => entry.kind === "file" && entry.name === "index.json");
  // A saved home view opens by itself the first time, unless a link says otherwise.
  useEffect(() => {
    if (!view || !first.current) return;
    first.current = false;
    if (!location.hash && index) navigate(filesHref(place, index.path));
  }, [view, index, place]);
  const meta = view?.meta;
  const icon = projectIcon(place.project);
  if (!view || !meta) return <HomeScreen label={place.project}>
    <Widgets><Widget size="wide" className="profile-widget"><span className="profile-top"><AppIcon icon={icon} size={64} /><span className="profile-name"><h1>{place.project}</h1>{error ? <ErrorNote message={error} retry={refresh} /> : <Skeleton width={220} />}</span></span></Widget></Widgets>
  </HomeScreen>;
  const dirs = view.snapshot.directory.entries.filter(entry => entry.kind === "directory");
  const isSection = (name: string) => SECTION_ICONS.has(name.toLowerCase());
  const sections = dirs.filter(entry => isSection(entry.name)).sort((a, b) => SECTION_ORDER.indexOf(a.name.toLowerCase()) - SECTION_ORDER.indexOf(b.name.toLowerCase()));
  const folders = dirs.filter(entry => !isSection(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const app = (entry: typeof dirs[number]) => ({ key: entry.path, label: entry.name, href: filesHref(place, entry.path), icon: folderIcon(entry.name), title: [entry.name, entry.detail].filter(Boolean).join(": ") });
  const readme = view.snapshot.directory.docs?.find(doc => /^readme/i.test(doc.name));
  const people = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])];
  const here = [...new Set(meta.here.map(who => who.agent))];
  const goal = meta.goal && meta.goal.template === null ? meta.goal : undefined;
  const done = goal ? goal.outcomes.filter(outcome => outcome.done).length : 0;
  return <HomeScreen label={place.project}>
    <Widgets>
      <Widget size="large" className="profile-widget">
        <span className="profile-top">
          <AppIcon icon={icon} size={64} />
          <span className="profile-name"><h1>{place.project}</h1><p>{meta.description || `A project of ${place.space}`}</p></span>
        </span>
        <ProjectStrip place={place} meta={meta} />
        <span className="widget-actions">
          <Popover label="Clone" icon={<Download size={15} />}><CloneProject place={place} /></Popover>
          <a className="button" href={placeUrl(place, hashOf("files", { as: "folder" }))} onClick={onLink}><FolderOpen size={15} />Browse files</a>
        </span>
      </Widget>
      {goal ? <Widget title="Goal" icon={<Target size={13} />} aside={<Meter done={done} total={goal.outcomes.length} size="small" />} href={placeUrl(place, hashOf("files", { path: "SPACE.md" }))}>
        <span className="widget-value">{done} of {goal.outcomes.length}</span><span className="widget-note">outcomes done</span>
      </Widget> : <Widget title="Stored" icon={<HardDrive size={13} />} href={placeUrl(place, hashOf("code"))}>
        <span className="widget-value">{size(meta.bytes)}</span><span className="widget-note">on {meta.defaultBranch}</span>
      </Widget>}
      <Widget title="Here now" icon={<Users size={13} />} href={placeUrl(place, hashOf("people"))}>
        <span className="widget-value">{here.length ? <><AvatarStack names={here} max={4} size={22} /><span>{here.length}</span></> : "Nobody"}</span>
        <span className="widget-note">{here.length ? "connected now" : "is connected right now"}</span>
      </Widget>
      {meta.head ? <Widget title="Latest change" icon={<GitCommitHorizontal size={13} />} aside={<Ago iso={meta.head.time} />} href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))}>
        <span className="widget-value"><Avatar name={meta.head.author} size={20} /><span className="widget-clip">{meta.head.author}</span></span>
        <span className="widget-note">{meta.head.subject}</span>
      </Widget> : <Widget title="Latest change" icon={<GitCommitHorizontal size={13} />}><span className="widget-value">Nothing yet</span><span className="widget-note">Push the first files</span></Widget>}
      <Widget title="Contributors" icon={<Bot size={13} />} href={placeUrl(place, hashOf("people"))}>
        <span className="widget-value">{people.length ? <><AvatarStack names={people} max={4} size={22} /><span>{people.length}</span></> : "None yet"}</span>
        <span className="widget-note">{meta.agents.length} {meta.agents.length === 1 ? "agent" : "agents"} connected</span>
      </Widget>
    </Widgets>
    {meta.goal && <Widget size="full" className="goal-widget"><GoalPanel place={place} goal={meta.goal} canWrite={meta.canWrite} /></Widget>}
    <AppGrid title="Sections" apps={sections.map(app)} />
    <AppGrid title="Folders" apps={folders.map(app)} />
    {index && <a className="callout glass-callout" href={filesHref(place, index.path)} onClick={onLink}><BookOpen size={18} /><span><strong>Open the saved view</strong><span>index.json</span></span></a>}
    {readme && <Widget size="full" className="readme-widget" title={readme.name} icon={<BookOpen size={13} />} aside={<a href={filesHref(place, readme.path)} onClick={onLink}>Open</a>}>
      <Markdown content={readme.content} filePath={readme.path} navigate={next => navigate(filesHref(place, next))} />
    </Widget>}
    {!meta.head && <Widget size="full" className="empty-widget"><Empty icon={<Boxes size={20} />} title="Nothing pushed yet"><p>Clone it and push the first files:</p><code>spacehub project clone {place.space}/{place.project}</code></Empty></Widget>}
  </HomeScreen>;
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
