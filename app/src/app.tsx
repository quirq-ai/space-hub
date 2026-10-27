import { useEffect, useRef, useState } from "react";
import { Activity, Code2, Folder, FolderGit2, GitBranch, GitCommitHorizontal, Home, Users, User } from "lucide-react";
import { placeUrl, viewUrl, type HubMeta, type Place, type ProjectMeta, type SpaceMeta, type View } from "@/api";
import { useLive } from "@/hooks/use-live";
import { recentProjects, rememberProject, useMe } from "@/hooks/use-me";
import { hashOf, useRoute } from "@/router";
import { Dock, Inspector, Progress, Sidebar, TopBar, type DockItem, type NavSection } from "@/shell/shell";
import { SearchPalette } from "@/shell/search";
import { Avatar } from "@/ui/primitives";
import { HomePage } from "@/pages/home";
import { SpacePage } from "@/pages/space";
import { HubInspector, ProjectInspector, ProjectPage, SpaceInspector } from "@/pages/project";
import { SECTION_ICONS, SECTION_ORDER } from "@/pages/files";

const HUB: Place = { space: "", project: "" };
const SEEN = "spacehub:seen:v1";
const INSPECTOR = "spacehub:inspector:v1";

function readSeen(): Record<string, string> { try { return JSON.parse(localStorage.getItem(SEEN) || "{}") ?? {}; } catch { return {}; } }
function markSeen(key: string) { try { localStorage.setItem(SEEN, JSON.stringify({ ...readSeen(), [key]: new Date().toISOString() })); } catch { /* Storage may be blocked. */ } }

export function App() {
  const route = useRoute();
  const me = useMe();
  const place = route.page === "home" ? HUB : route.place;
  const filesPath = route.page === "project" && route.tab === "files" ? route.path : "";
  const live = useLive<View>(viewUrl(place, filesPath));
  // A project's space, for the sidebar's list of its sibling projects.
  const space = useLive<View<SpaceMeta>>(route.page === "project" ? viewUrl({ space: place.space, project: "" }) : undefined, 30_000);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => { try { return localStorage.getItem(INSPECTOR) !== "closed" && matchMedia("(min-width: 1180px)").matches; } catch { return true; } });
  const [searching, setSearching] = useState(false);
  const [seen, setSeen] = useState(readSeen);

  // Keep the place's last view while another path of the same place loads, so nothing goes blank.
  const kept = useRef<{ key: string; view: View }>(undefined);
  const placeKey = `${place.space}/${place.project}`;
  if (live.data) kept.current = { key: placeKey, view: live.data };
  const view = live.data ?? (kept.current?.key === placeKey ? kept.current.view : undefined);
  const meta = view?.meta;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearching(true); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement)?.isContentEditable)) { event.preventDefault(); setSearching(true); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (route.page === "project") rememberProject(placeKey);
    if (route.page !== "home") { markSeen(route.page === "project" ? placeKey : place.space); setSeen(readSeen()); }
  }, [route.page, placeKey, place.space]);
  useEffect(() => {
    document.title = route.page === "home" ? "spacehub" : `${route.page === "project" ? placeKey : place.space} · spacehub`;
  }, [route.page, placeKey, place.space]);
  const toggleInspector = () => setInspectorOpen(open => { try { localStorage.setItem(INSPECTOR, open ? "closed" : "open"); } catch { /* Storage may be blocked. */ } return !open; });

  const signIn = `/-/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
  const state = live.error && view ? "offline" : !view ? "loading" : "live";

  // Sidebar: home and you, your spaces, recent projects, then where you are.
  const sections: NavSection[] = [{ items: [
    { key: "home", label: "Home", href: "/", icon: <Home size={16} />, active: route.page === "home" },
    ...(me.name ? [{ key: "me", label: "Your profile", href: placeUrl({ space: me.name, project: "" }), icon: <User size={16} />, active: route.page === "space" && place.space === me.name }] : []),
  ] }];
  if (me.spaces.length) sections.push({ title: "Your spaces", items: me.spaces.filter(s => s.space !== me.name).map(s => ({ key: "s:" + s.space, label: s.space, href: placeUrl({ space: s.space, project: "" }), icon: <Avatar name={s.space} size={18} kind={s.kind} />, active: route.page !== "home" && place.space === s.space && route.page === "space" })) });
  const recent = recentProjects().filter(name => name !== placeKey).slice(0, 5);
  if (recent.length) sections.push({ title: "Recent", items: recent.map(name => { const [s, p] = name.split("/"); return { key: "r:" + name, label: name, href: placeUrl({ space: s, project: p }), icon: <FolderGit2 size={16} /> }; }) });
  const siblings = route.page === "project" ? space.data?.snapshot.directory.entries : route.page === "space" ? view?.snapshot.directory.entries : undefined;
  if (route.page !== "home" && siblings) sections.push({ title: place.space, items: siblings.slice(0, 14).map(entry => ({ key: "p:" + entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), icon: <FolderGit2 size={16} />, active: place.project === entry.name })) });

  // Dock: the places of where you are, then tools.
  let places: DockItem[] = [];
  let tools: DockItem[] = [];
  if (route.page === "project" && meta?.level === "project") {
    const roots = [...(view?.snapshot.roots ?? [])].sort((a, b) => {
      const left = SECTION_ORDER.indexOf(a.name.toLowerCase());
      const right = SECTION_ORDER.indexOf(b.name.toLowerCase());
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.name.localeCompare(b.name);
    });
    const top = route.tab === "files" ? route.path.split("/")[0] : "";
    places = roots.slice(0, 8).map(root => { const Icon = SECTION_ICONS.get(root.name.toLowerCase()) ?? Folder; return { key: root.path, label: root.name, href: placeUrl(place, hashOf("files", { path: root.path })), icon: <Icon size={22} strokeWidth={1.7} />, active: top === root.path }; });
    tools = [
      { key: "code", label: "Code", href: placeUrl(place, hashOf("code")), icon: <Code2 size={22} strokeWidth={1.7} />, active: route.tab === "code" },
      { key: "commits", label: "Commits", href: placeUrl(place, hashOf("commits")), icon: <GitCommitHorizontal size={22} strokeWidth={1.7} />, active: route.tab === "commits" || route.tab === "commit" },
      { key: "branches", label: "Branches", href: placeUrl(place, hashOf("branches")), icon: <GitBranch size={22} strokeWidth={1.7} />, active: route.tab === "branches" },
      { key: "people", label: "People", href: placeUrl(place, hashOf("people")), icon: <Users size={22} strokeWidth={1.7} />, active: route.tab === "people" },
    ];
  } else if (route.page === "space" && meta?.level === "space") {
    places = [...(view?.snapshot.directory.entries ?? [])].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8)
      .map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), icon: <FolderGit2 size={22} strokeWidth={1.7} />, fresh: !!seen[`${place.space}/${entry.name}`] && entry.modifiedAt > seen[`${place.space}/${entry.name}`] }));
    tools = [
      { key: "activity", label: "Activity", href: placeUrl(place, hashOf("activity")), icon: <Activity size={22} strokeWidth={1.7} />, active: route.tab === "activity" },
      { key: "people", label: "People", href: placeUrl(place, hashOf("people")), icon: <Users size={22} strokeWidth={1.7} />, active: route.tab === "people" },
    ];
  } else if (route.page === "home" && meta?.level === "hub") {
    const mine = new Set(me.spaces.map(s => s.space));
    places = [...(view?.snapshot.directory.entries ?? [])].sort((a, b) => Number(mine.has(b.name)) - Number(mine.has(a.name)) || b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8)
      .map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: entry.name, project: "" }), icon: <Avatar name={entry.name} size={30} kind={entry.detail?.startsWith("org") ? "org" : entry.detail?.startsWith("agent") ? "agent" : "personal"} />, fresh: !!seen[entry.name] && entry.modifiedAt > seen[entry.name] }));
  }

  const inspector = meta?.level === "project" ? <ProjectInspector place={place} meta={meta} /> : meta?.level === "space" ? <SpaceInspector name={place.space} meta={meta} /> : meta?.level === "hub" ? <HubInspector meta={meta} /> : null;

  return <div className={`shell${inspectorOpen && inspector ? " with-inspector" : ""}`}>
    <Progress />
    <TopBar me={me} signIn={signIn} live={state} onSearch={() => setSearching(true)} onMenu={() => setSidebarOpen(true)} onInspector={inspector ? toggleInspector : undefined} inspectorOpen={inspectorOpen} />
    <Sidebar sections={sections} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    <main className="main" id="main">
      <div className="main-scroll">
        {route.page === "home" && <HomePage view={view as View<HubMeta> | undefined} me={me.name} />}
        {route.page === "space" && <SpacePage name={place.space} tab={route.tab} view={view as View<SpaceMeta> | undefined} error={live.error} me={me.name} />}
        {route.page === "project" && <ProjectPage route={route} view={view as View<ProjectMeta> | undefined} error={live.error} me={me.name} signIn={signIn} refresh={live.refresh} />}
      </div>
      <Dock places={places} tools={tools} />
    </main>
    {inspector && <Inspector open={inspectorOpen} onClose={toggleInspector}>{inspector}</Inspector>}
    {searching && <SearchPalette place={place} onClose={() => setSearching(false)} />}
  </div>;
}
