import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowUpRight, BookOpen, Bot, Building2, ChevronRight, CircleHelp, Cloud, Code2, File, FileCode2,
  FileImage, FileText, Folder, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, History, House, Lightbulb,
  LogIn, Menu, MessageCircle, PanelsTopLeft, RefreshCw, Search, Shapes, SquareCheck, User, Users, X,
  type LucideIcon,
} from "lucide-react";
import type { Entry } from "@/lib/types";
import { isConversation } from "@/lib/conversation";
import { chatLogPath } from "@/lib/chat-log";
import { activityLine, ago, placeOf, placeUrl, rawUrl, size, type ActivityItem, type Here, type Meta, type Place } from "@/api";
import { useView } from "@/hooks/use-view";
import { useChat } from "@/hooks/use-chat";
import { FileContent } from "./components/content-view";
import { FileOverlay } from "./components/file-overlay";
import { ChatComposer } from "./components/chat-composer";
import { ThemePicker } from "./components/theme-picker";
import { QuirqyAvatar } from "./components/quirqy-avatar";

const icons = new Map<string, LucideIcon>([
  ["chat", MessageCircle], ["activity", PanelsTopLeft], ["insights", Lightbulb],
  ["vision", SquareCheck], ["library", BookOpen], ["ideas", Lightbulb],
  ["goals", SquareCheck], ["files", FolderOpen], ["apps", Shapes],
]);
const order = ["chat", "activity", "insights", "vision", "library", "ideas", "goals", "files", "apps"];
const DOCK_MAX = 8;
const nameOf = (path: string) => path.split("/").filter(Boolean).at(-1) || "";
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
function hashPath() { try { return decodeURIComponent(location.hash.replace(/^#\/?/, "")); } catch { return ""; } }
function prettySize(bytes: number) { return size(bytes); }

type Level = "hub" | "space" | "project";

/** Spaces and projects get icons for what they are; folders and files as in open-chat. */
function entryIcon(entry: Entry, level: Level): LucideIcon {
  if (level === "hub") return entry.detail?.startsWith("org") ? Building2 : entry.detail?.startsWith("agent") ? Bot : User;
  if (level === "space") return FolderGit2;
  if (entry.kind === "directory") return icons.get(entry.name.toLowerCase()) || Folder;
  if (/json|js|ts|py|css|html|csv|yaml|toml/.test(entry.extension)) return FileCode2;
  if (/png|jpg|jpeg|gif|webp|avif/.test(entry.extension)) return FileImage;
  return /md|txt|pdf/.test(entry.extension) ? FileText : File;
}

function EntryRows({ entries, level, open, selected }: { entries: Entry[]; level: Level; open: (entry: Entry) => void; selected?: string }) {
  return <div className="entry-list">{entries.map((entry, index) => {
    const Icon = entryIcon(entry, level);
    const label = entry.detail ?? (entry.kind === "directory" ? "Folder" : `${(entry.extension || "file").toUpperCase()} · ${prettySize(entry.size)}`);
    return <button className={`entry-row ${selected === entry.path ? "selected" : ""}`} key={entry.path} onClick={() => open(entry)}>
      <span className={`icon-box tint-${index % 5}`}><Icon size={20} strokeWidth={1.8} /></span>
      <span className="entry-copy"><strong>{entry.name}</strong><span>{label}</span></span>
      <ChevronRight size={16} className="muted" />
    </button>;
  })}</div>;
}

function ActivityFeed({ items, title = "Activity" }: { items: ActivityItem[]; title?: string }) {
  if (!items.length) return null;
  return <section className="jsonl-feed hub-activity" aria-label={title}>
    <div className="feed-heading"><div><h2>{title}</h2><p>Newest first, live</p></div><History size={16} className="muted" /></div>
    <div className="feed-posts">{items.map((item, index) => {
      const line = activityLine(item);
      return <article className="feed-post" key={index}>
        <header><span className="feed-avatar" aria-hidden="true">{(item.agent || "?").slice(0, 1).toUpperCase()}</span><div className="feed-byline"><strong>{line.title}</strong><span>{ago(item.at)}</span></div></header>
        {line.body && <p className="feed-text">{line.body}</p>}
      </article>;
    })}</div>
  </section>;
}

function HereNow({ here }: { here: Here[] }) {
  if (!here.length) return null;
  return <div className="here-now"><span className="eyebrow">HERE NOW</span><div>{here.map((who, index) => <span className="chip" key={index}><i className="here-dot" />{who.agent} · {who.mode}{who.project ? ` · ${who.project}` : ""}</span>)}</div></div>;
}

function useMe() {
  const [me, setMe] = useState<{ name: string | null }>();
  useEffect(() => {
    void fetch("/-/api/me", { cache: "no-store" }).then(response => response.ok ? response.json() : { name: null }).then(setMe).catch(() => setMe({ name: null }));
  }, []);
  return me;
}

function codeLinks(place: Place, meta: Extract<Meta, { level: "project" }>, folder: string) {
  const base = placeUrl(place);
  const branch = encodeURIComponent(meta.defaultBranch);
  const inner = folder ? "/" + folder.split("/").map(encodeURIComponent).join("/") : "";
  return [
    { label: "Code", href: inner ? `${base}/tree/${branch}${inner}` : `${base}?view=code`, icon: Code2 },
    { label: "Commits", href: `${base}/commits/${branch}${inner}`, icon: GitCommitHorizontal },
    { label: "Branches", href: `${base}/refs`, icon: GitBranch },
    { label: "Activity", href: `${base}/activity`, icon: History },
  ];
}

export function HubApp() {
  const place = useMemo(() => placeOf(location.pathname), []);
  const level: Level = !place.space ? "hub" : !place.project ? "space" : "project";
  const [path, setPath] = useState("");
  const [ready, setReady] = useState(false);
  const [previewPaths, setPreviewPaths] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"files" | "about" | null>(null);
  const pendingChatSection = useRef<string | undefined>(undefined);
  const initialNavigation = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLElement>(null);
  const me = useMe();
  const { view, error, missing, refresh } = useView(place, ready ? (level === "project" ? path : "") : undefined);
  const snapshot = view?.snapshot;
  const meta = view?.meta;
  const project = meta?.level === "project" ? meta : undefined;
  const conversation = snapshot?.file?.format === "json" && isConversation(snapshot.file.data) ? snapshot.file.data : undefined;
  const repliesPath = typeof conversation?.demoReplies === "string" ? conversation.demoReplies : undefined;
  const blocked = !me ? "Checking who you are…" : !me.name ? "Sign in to chat here." : project && !project.canWrite ? `Only members of ${place.space} can save messages in this project.` : undefined;
  const logPath = conversation && snapshot?.file ? chatLogPath(snapshot.file.path) : undefined;
  const chat = useChat(place, conversation ? snapshot?.file?.path : undefined, repliesPath, blocked, !!logPath && !!snapshot?.directory.entries.some(entry => entry.path === logPath), refresh);
  const chatOpen = !!conversation && !blocked;
  const fileSrc = useCallback((file: string) => rawUrl(place, project?.defaultBranch ?? "main", file), [place, project?.defaultBranch]);
  const closePreview = useCallback(() => setPreviewPaths([]), []);
  const openFile = useCallback((next: string) => { setPanel(null); setPreviewPaths(current => current.at(-1) === next ? current : [...current, next]); }, []);

  const navigate = useCallback((next: string) => {
    setPreviewPaths([]);
    setQuery("");
    setPanel(null);
    if (level !== "project") { location.href = placeUrl(level === "hub" ? { space: next, project: "" } : { space: place.space, project: next }); return; }
    if (next === path) refresh();
    location.hash = `/${encodeURIComponent(next)}`;
    setPath(next);
    content.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [level, path, place.space, refresh]);
  const openEntry = useCallback((entry: Entry) => (entry.kind === "directory" || level !== "project" ? navigate(entry.path) : openFile(entry.path)), [level, navigate, openFile]);

  useEffect(() => {
    const update = () => { setPath(level === "project" ? hashPath() : ""); setQuery(""); setPreviewPaths([]); };
    update(); setReady(true);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, [level]);

  useEffect(() => {
    const element = dialog.current;
    if (panel && element && !element.open) element.showModal();
    else if (!panel && element?.open) element.close();
  }, [panel]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); search.current?.focus(); }
      if (event.key === "Escape") setQuery("");
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, []);

  const entries = snapshot?.directory.entries || [];
  const index = level === "project" ? entries.find(entry => entry.kind === "file" && entry.name === "index.json") : undefined;
  const folderPath = snapshot?.directory.path ?? (snapshot?.file ? parentOf(path) : path);
  const selectedRoot = path.split("/")[0];
  const filtered = entries.filter(entry => entry.name.toLowerCase().includes(query.toLowerCase()));
  const title = level === "hub" ? "spacehub" : level === "space" ? place.space : folderPath ? nameOf(folderPath) : place.project;

  useEffect(() => {
    if (!snapshot || !initialNavigation.current) return;
    initialNavigation.current = false;
    // A saved home view is optional; explicit deep links always win.
    if (level === "project" && !location.hash && !path && index) navigate(index.path);
  }, [snapshot, path, index, navigate, level]);

  useEffect(() => {
    if (snapshot && !snapshot.file && pendingChatSection.current === path) {
      pendingChatSection.current = undefined;
      if (index) navigate(index.path);
    }
  }, [snapshot, path, index, navigate]);

  useEffect(() => {
    if (conversation && content.current) content.current.scrollTo({ top: content.current.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [conversation, chat.messages.length, chat.pending]);

  // The dock: a project's top folders (as in open-chat), else the most recently active spaces or projects.
  const dock = level === "project"
    ? [...(snapshot?.roots || [])].sort((a, b) => {
      const left = order.indexOf(a.name.toLowerCase());
      const right = order.indexOf(b.name.toLowerCase());
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.name.localeCompare(b.name);
    })
    : [...entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, DOCK_MAX);
  function openSection(section: Entry) {
    pendingChatSection.current = level === "project" && section.name.toLowerCase() === "chat" ? section.path : undefined;
    navigate(section.path);
  }

  const crumbs: { label: string; go: () => void }[] = [];
  if (place.space) crumbs.push({ label: place.space, go: () => { location.href = placeUrl({ space: place.space, project: "" }); } });
  if (place.project) crumbs.push({ label: place.project, go: () => (path ? navigate("") : (location.hash = "")) });
  folderPath.split("/").filter(Boolean).forEach((part, i, all) => crumbs.push({ label: part, go: () => navigate(all.slice(0, i + 1).join("/")) }));
  const host = location.host;
  const live = error ? "Connection needs attention" : `Live on ${host}`;
  const signIn = `/-/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
  const chatLog = snapshot?.file ? nameOf(chatLogPath(snapshot.file.path) ?? "") : "";

  return <div className="app-shell">
    <header className="app-header">
      <button className="round-button header-left" aria-label="Browse" onClick={() => setPanel("files")}><Menu size={20} strokeWidth={1.8} /></button>
      <div className="brand"><QuirqyAvatar pending={chat.pending} drafting={!!chat.draft.trim()} replied={chat.messages.at(-1)?.role === "assistant"} /><a className="brand-name" href="/" title="All spaces on this hub">{level === "project" ? `${place.space}/${place.project}` : level === "space" ? place.space : "spacehub"}</a></div>
      <span className={`connection ${error ? "offline" : ""}`}><i />{live}</span>
      <div className="header-actions header-right">
        <ThemePicker />
        {me?.name ? <a className="round-button" href={placeUrl({ space: me.name, project: "" })} aria-label={`Your space, ${me.name}`} title={me.name}><User size={19} strokeWidth={1.8} /></a>
          : <a className="round-button" href={signIn} aria-label="Sign in" title="Sign in"><LogIn size={19} strokeWidth={1.8} /></a>}
        <button className="round-button" aria-label="About this place" onClick={() => setPanel("about")}><CircleHelp size={20} strokeWidth={1.8} /></button>
      </div>
    </header>

    <main className="main-content" ref={content} id="main-content">
      {level !== "hub" && <nav className="breadcrumbs" aria-label="Breadcrumb"><a href="/" aria-label="All spaces"><House size={13} /></a>{crumbs.map((crumb, i) => <span key={i}><ChevronRight size={12} /><button onClick={crumb.go}>{crumb.label}</button></span>)}</nav>}
      {error && <div className="notice warning" role="alert"><strong>{missing ? "Nothing here." : snapshot ? "Showing the last loaded view." : "This place is unavailable."}</strong><p>{error}</p>{missing ? <a href="/"><House size={13} /> All spaces</a> : <button onClick={refresh}><RefreshCw size={13} /> Try again</button>}{level === "project" && path && <button onClick={() => navigate(parentOf(path))}><ArrowLeft size={13} /> Back to folder</button>}</div>}
      {!snapshot && !error && <div className="loading-state"><RefreshCw className="spin" size={21} /><p>Opening {level === "hub" ? "the hub" : place.project ? `${place.space}/${place.project}` : place.space}…</p></div>}
      {snapshot && meta && (query ? <section><div className="section-heading"><h1>Find</h1><p>{filtered.length} {filtered.length === 1 ? "match" : "matches"} in {title}</p></div><EntryRows entries={filtered} level={level} open={openEntry} />{!filtered.length && <div className="empty-state"><Search /><p>Nothing matches “{query}”.</p></div>}</section>
        : snapshot.file ? <>
          <FileContent key={snapshot.file.path} file={snapshot.file} revision={snapshot.revision} navigate={openFile} demo={!!conversation} src={fileSrc(snapshot.file.path)} extraMessages={conversation ? chat.messages : undefined} endNote={conversation ? `Saved on the hub · new messages go to ${chatLog}` : undefined} />
          {conversation && chat.pending && <div className="typing-message" aria-hidden="true"><span>quirqy</span><div><i /><i /><i /></div></div>}
        </>
        : <section>
          <div className="section-heading">
            <div className="between"><h1>{title}</h1><span className="chip"><Cloud size={11} /> {level === "hub" ? `${meta.level === "hub" ? meta.projects : 0} projects · ${prettySize(meta.bytes)}` : level === "space" && meta.level === "space" ? `${meta.kind === "personal" ? "builder" : meta.kind} · ${prettySize(meta.bytes)}` : "On the hub"}</span></div>
            <p>{meta.level === "hub" ? "Every space on this hub: builders, orgs and agents. Open one to see its projects." : meta.level === "space" ? (meta.description || `The projects of ${place.space}.`) : folderPath ? "Everything here comes straight from this folder." : (meta.description || "A little room for everything you’re working on.")}</p>
          </div>
          {project ? <nav className="code-links" aria-label="Code views">{codeLinks(place, project, folderPath).map(link => <a key={link.label} href={link.href}><link.icon size={14} />{link.label}</a>)}</nav>
            : <nav className="code-links" aria-label="Code view"><a href={`${placeUrl(place)}?view=code`}><Code2 size={14} />{level === "hub" ? "Projects, builders and activity" : "Members and projects"}</a></nav>}
          {index && <button className="folder-intro" onClick={() => navigate(index.path)}><span className="icon-box tint-0"><MessageCircle size={21} /></span><span><strong>Open {folderPath ? title.toLowerCase() : "your daily view"}</strong><small>Read the saved view in index.json</small></span><ArrowUpRight size={18} /></button>}
          <div className="list-caption"><span>{entries.length} {entries.length === 1 ? "item" : "items"}</span><span>{level === "project" ? `${place.space}/${place.project}${folderPath ? ` / ${folderPath}` : ""}` : place.space || host}</span></div>
          <EntryRows entries={entries} level={level} open={openEntry} />
          {!entries.length && (project && !project.head
            ? <div className="empty-state"><FolderGit2 size={30} /><h2>An empty project</h2><p>Push to it and its files appear here:</p><code className="clone-line">spacehub project clone {place.space}/{place.project}</code></div>
            : <div className="empty-state"><FolderOpen size={30} /><h2>{level === "hub" ? "No spaces yet" : level === "space" ? "No projects yet" : "A little space to begin"}</h2><p>{level === "project" ? "Push a file to this folder. It will appear here automatically." : "Projects pushed here appear automatically."}</p></div>)}
          {!folderPath && <HereNow here={meta.here} />}
          {!folderPath && <ActivityFeed items={meta.activity} />}
        </section>)}
      {snapshot?.file && !query && <button className="back-to-folder" onClick={() => navigate(snapshot.directory.path)}><FolderOpen size={15} />Browse {snapshot.directory.name || place.project}<span>{entries.length} items</span><ChevronRight size={14} /></button>}
      <div className="content-bottom-space" />
    </main>

    <footer className="workspace-footer">
      {chatOpen ? <ChatComposer chat={chat} /> : <>
        {conversation && blocked && <div className="chat-config-error" role="status">{blocked}{!me?.name && me && <a href={signIn}>Sign in</a>}</div>}
        <div className="search-composer"><Search size={18} strokeWidth={1.7} /><input ref={search} aria-label="Find in this folder" placeholder={level === "hub" ? "Find a space…" : level === "space" ? "Find a project…" : "Find a file in this folder…"} value={query} onChange={event => setQuery(event.target.value)} />{query ? <button className="search-action" aria-label="Clear search" onClick={() => setQuery("")}><X size={16} /></button> : <button className="search-action" aria-label="Refresh" onClick={refresh}><RefreshCw size={16} /></button>}</div>
        <div className="mirror-caption"><Cloud size={10} />{level === "project" ? `Live from ${place.space}/${place.project}` : `Live from ${host}`}<span>·</span>Changes appear automatically</div>
      </>}
      <nav className="dock" aria-label="Places">{dock.length ? dock.map(root => {
        const Icon = level === "project" ? icons.get(root.name.toLowerCase()) || Folder : entryIcon(root, level);
        const active = level === "project" && selectedRoot === root.path;
        return <button key={root.path} className={active ? "dock-item active" : "dock-item"} onClick={() => openSection(root)} aria-label={`Open ${root.name}`} aria-current={active ? "page" : undefined} title={root.name}><Icon size={23} strokeWidth={1.8} /><span>{root.name}</span></button>;
      }) : <a className="dock-item active" href="/" aria-label="All spaces"><House size={23} /><span>Hub</span></a>}</nav>
    </footer>

    <dialog ref={dialog} className="sheet" onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }} aria-labelledby="sheet-title">
      <div className="sheet-inner"><div className="sheet-header"><div><h2 id="sheet-title">{panel === "files" ? title : level === "project" ? `${place.space}/${place.project}` : level === "space" ? place.space : "spacehub"}</h2><p>{panel === "files" ? "Folders and files, live from the hub." : "Git hosting where every project is also a place to read and chat."}</p></div><button className="round-button" aria-label="Close panel" onClick={() => setPanel(null)}><X size={20} /></button></div>
      <div className="sheet-body">{panel === "files" ? <>
        <a className="root-link" href="/"><House size={17} />All spaces<ArrowUpRight size={16} /></a>
        {level === "project" && <><button className="root-link" onClick={() => navigate("")}><FolderGit2 size={17} />{place.space}/{place.project}<ArrowUpRight size={16} /></button><EntryRows entries={snapshot?.roots || []} level={level} open={openEntry} selected={selectedRoot} /></>}
        {!!entries.length && <><div className="divider" /><span className="eyebrow">IN THIS {level === "hub" ? "HUB" : level === "space" ? "SPACE" : "FOLDER"}</span><EntryRows entries={entries} level={level} open={openEntry} selected={path} /></>}
      </> : <About level={level} place={place} meta={meta} me={me?.name ?? null} signIn={signIn} folder={folderPath} />}</div></div>
    </dialog>
    {!!previewPaths.length && level === "project" && <FileOverlay place={place} path={previewPaths[previewPaths.length - 1]} fileSrc={fileSrc} canGoBack={previewPaths.length > 1} onBack={() => setPreviewPaths(current => current.slice(0, -1))} onClose={closePreview} onOpen={openFile} onNavigate={navigate} />}
  </div>;
}

function About({ level, place, meta, me, signIn, folder }: { level: Level; place: Place; meta: Meta | undefined; me: string | null; signIn: string; folder: string }) {
  const host = location.host;
  const rows: [string, ReactNode][] = [];
  if (meta?.level === "hub") rows.push(["Hub", host], ["Spaces", String(meta.spaces)], ["Projects", String(meta.projects)], ["Stored", size(meta.bytes)]);
  if (meta?.level === "space") {
    rows.push(["Kind", meta.kind === "personal" ? "A builder's space" : meta.kind === "org" ? "An org" : `An agent${meta.parent ? ` of ${meta.parent}` : ""}`], ["Owners", meta.owners.join(", ") || "none"], ["Members", meta.members.join(", ") || "none"], ["Projects", String(meta.projects)], ["Stored", size(meta.bytes)]);
    if (meta.github) rows.push(["Mirrors", <a href={meta.github} target="_blank" rel="noreferrer">{meta.github.replace(/^https:\/\//, "")}</a>]);
  }
  if (meta?.level === "project") {
    rows.push(["Branch", meta.defaultBranch], ["Last change", meta.head ? `${meta.head.subject} · ${meta.head.author} · ${ago(meta.head.time)}` : "nothing pushed yet"], ["Stored", size(meta.bytes)], ["You", me ? (meta.canWrite ? `${me}, can save chats` : `${me}, read only here`) : "signed out, read only"]);
  }
  const clone = level === "project" ? [`spacehub project clone ${place.space}/${place.project}`, `git clone -o quirq quirq://${host}/${place.space}/${place.project}`] : level === "space" ? [`spacehub space clone ${place.space}`] : [];
  return <>
    <div className="about-steps">
      <div><span className="icon-box tint-0"><Users size={20} /></span><p><strong>Spaces become places.</strong>Builders, orgs and agents each have a space; open one to see its projects.</p></div>
      <div><span className="icon-box tint-1"><FileCode2 size={20} /></span><p><strong>Projects are git repositories.</strong>Their files show as documents, data, feeds and chats. Code, commits and branches are one tab away.</p></div>
      <div><span className="icon-box tint-2"><MessageCircle size={20} /></span><p><strong>Chats save to the project.</strong>Signed-in members add messages to a conversation’s .log.jsonl, as a commit; agents reply by pushing.</p></div>
    </div>
    {!!rows.length && <div className="workspace-details">{rows.map(([label, value]) => <Fragment key={label}><span>{label}</span><strong>{value}</strong></Fragment>)}</div>}
    {meta?.level === "project" && <nav className="code-links">{codeLinks(place, meta, folder).map(link => <a key={link.label} href={link.href}><link.icon size={14} />{link.label}</a>)}</nav>}
    {!!clone.length && <div className="clone-box"><span className="eyebrow">WORK ON IT</span>{clone.map(line => <code className="clone-line" key={line}>{line}</code>)}</div>}
    <div className="account-box">{me ? <form method="post" action="/-/logout"><span>Signed in as <strong>{me}</strong></span><button type="submit">Sign out</button></form> : <span><a href={signIn}>Sign in</a> or <a href="/-/signup">sign up</a> to chat and create projects.</span>}{me && <a href="/-/new">New project</a>}<a href="/-/guide">Guide</a></div>
    <p className="about-footnote">Visual design adapted from OpenMuse via open-chat. Every page reads the hub live; nothing here needs an account to view.</p>
  </>;
}
