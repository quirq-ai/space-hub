import { useEffect, useRef, useState } from "react";
import { Archive, BookOpen, Hash, Folder, FolderGit2, History, Home, Server, Users, User } from "lucide-react";
import { placeUrl, viewUrl, type HubMeta, type Place, type ProjectMeta, type SpaceMeta, type View } from "@/api";
import { useLive } from "@/hooks/use-live";
import { channelSeenKey, ChannelsContext, useChannels } from "@/hooks/use-channels";
import { channelCards, channelOf } from "@/lib/channels";
import { recentProjects, rememberProject, useMe } from "@/hooks/use-me";
import { hashOf, navigate, useRoute } from "@/router";
import { Dock, Inspector, Progress, Sidebar, TopBar, type DockItem, type SideSection } from "@/shell/shell";
import { SearchPalette } from "@/shell/search";
import { Avatar } from "@/ui/primitives";
import { ActivityFeed, HomePage } from "@/pages/home";
import { SpacePage } from "@/pages/space";
import { ProjectPage } from "@/pages/project";
import { SECTION_ICONS, SECTION_ORDER } from "@/pages/files";
import { InstanceRecoveryPage } from "@/pages/instance-recovery";

const HUB: Place = { space: "", project: "" };
const SEEN = "spacehub:seen:v1";
const RAIL = "spacehub:rail:v1";
const ACTIVITY = "spacehub:activity:v1";

function readSeen(): Record<string, string> { try { return JSON.parse(localStorage.getItem(SEEN) || "{}") ?? {}; } catch { return {}; } }
// The home page's activity panel starts open on wide windows unless the viewer closed it; narrower ones open it on demand.
function readActivity() { let stored = ""; try { stored = localStorage.getItem(ACTIVITY) ?? ""; } catch { /* Storage may be blocked. */ } return stored !== "closed" && matchMedia("(min-width: 1180px)").matches; }
function markSeen(key: string) { try { localStorage.setItem(SEEN, JSON.stringify({ ...readSeen(), [key]: new Date().toISOString() })); } catch { /* Storage may be blocked. */ } }

export function App() {
  const route = useRoute();
  const me = useMe();
  const recoveryOnly = me.recoveryOnly;
  const recovery = recoveryOnly || (route.page === "home" && route.tab === "subhubs");
  const place = recovery || route.page === "home" ? HUB : route.place;
  const filesPath = route.page === "project" && route.tab === "files" ? route.path : "";
  const live = useLive<View>(recovery ? undefined : viewUrl(place, filesPath));
  // A project's space, for the sidebar's list of its sibling projects.
  const space = useLive<View<SpaceMeta>>(!recovery && route.page === "project" ? viewUrl({ space: place.space, project: "" }) : undefined, 30_000);
  const [recoveryState, setRecoveryState] = useState<"live" | "offline" | "loading">("loading");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [rail, setRail] = useState(() => { try { return localStorage.getItem(RAIL) === "on"; } catch { return false; } });
  const toggleRail = () => setRail(on => { try { localStorage.setItem(RAIL, on ? "off" : "on"); } catch { /* Storage may be blocked. */ } return !on; });
  const [seen, setSeen] = useState(readSeen);
  const [activityOpen, setActivityOpen] = useState(readActivity);
  const toggleActivity = () => setActivityOpen(open => { try { localStorage.setItem(ACTIVITY, open ? "closed" : "open"); } catch { /* Storage may be blocked. */ } return !open; });

  // Keep the place's last view while another path of the same place loads, so nothing goes blank.
  const kept = useRef<{ key: string; view: View }>(undefined);
  const placeKey = `${place.space}/${place.project}`;
  if (live.data) kept.current = { key: placeKey, view: live.data };
  const view = live.data ?? (kept.current?.key === placeKey ? kept.current.view : undefined);
  const meta = view?.meta;

  // Inside a project's Chat folder, its channels: in the sidebar like a chat app's, and on the folder's own page.
  const chatRoot = !recovery && route.page === "project" ? view?.snapshot.roots.find(root => root.name.toLowerCase() === "chat")?.path : undefined;
  const inChat = !!chatRoot && route.page === "project" && route.tab === "files" && (filesPath === chatRoot || filesPath.startsWith(chatRoot + "/"));
  const channels = useChannels(place, inChat ? chatRoot : undefined);
  const activeChannel = channels ? channelOf(channels.root, filesPath) : undefined;
  const activeLast = activeChannel ? channels?.last[activeChannel]?.time ?? "" : "";
  useEffect(() => {
    if (!activeChannel) return;
    markSeen(channelSeenKey(place, activeChannel));
    setSeen(readSeen());
  }, [activeChannel, activeLast, place.space, place.project]);

  // The search box of the server-rendered pages links to /#search.
  useEffect(() => {
    if (recoveryOnly) { setSearching(false); return; }
    if (location.hash === "#search") { history.replaceState(null, "", location.pathname); setSearching(true); }
  }, [recoveryOnly]);
  useEffect(() => {
    if (recoveryOnly && (route.page !== "home" || route.tab !== "subhubs")) navigate("/#/subhubs");
  }, [recoveryOnly, route]);
  useEffect(() => {
    if (recoveryOnly) return;
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearching(true); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement)?.isContentEditable)) { event.preventDefault(); setSearching(true); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [recoveryOnly]);
  useEffect(() => {
    if (recoveryOnly) return;
    if (route.page === "project") rememberProject(placeKey);
    if (route.page !== "home") { markSeen(route.page === "project" ? placeKey : place.space); setSeen(readSeen()); }
  }, [route.page, placeKey, place.space, recoveryOnly]);
  useEffect(() => {
    document.title = recovery ? "Sub-hubs · spacehub" : route.page === "home" ? "spacehub" : `${route.page === "project" ? placeKey : place.space} · spacehub`;
  }, [route.page, placeKey, place.space, recovery]);

  const signIn = `/-/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
  const state = recovery ? recoveryState : live.error && view ? "offline" : !view ? "loading" : "live";

  // Sidebar: a space switcher, the main places, short lists of where you are and where you were, and a footer.
  const kindOf = (name: string) => me.spaces.find(s => s.space === name)?.kind ?? (meta?.level === "space" && meta.name === name ? meta.kind : space.data?.meta.name === name ? space.data.meta.kind : "personal");
  const switcher = {
    current: route.page === "home" ? null : { name: place.space, kind: kindOf(place.space), href: placeUrl({ space: place.space, project: "" }) },
    options: me.spaces.map(s => ({ name: s.space, kind: s.kind, href: placeUrl({ space: s.space, project: "" }) })),
  };
  const primary = [
    ...(!recoveryOnly ? [{ key: "home", label: "Home", href: "/", icon: <Home size={16} />, active: route.page === "home" && !recovery }] : []),
    { key: "instance-recovery", label: "Sub-hubs", href: "/#/subhubs", icon: <Archive size={16} />, active: recovery },
    ...(me.name && !recoveryOnly ? [{ key: "me", label: "Your profile", href: placeUrl({ space: me.name, project: "" }), icon: <User size={16} />, active: route.page === "space" && place.space === me.name }] : []),
    ...(place.space && !recoveryOnly ? [{ key: "nodes", label: "Nodes", href: placeUrl({ space: place.space, project: "" }, hashOf("nodes")), icon: <Server size={16} />, active: route.page === "space" && route.tab === "nodes" }] : []),
  ];
  const sideSections: SideSection[] = [];
  if (channels && meta?.level === "project") {
    const seenHere = Object.fromEntries(Object.entries(seen).filter(([key]) => key.startsWith(channelSeenKey(place, ""))).map(([key, at]) => [key.slice(channelSeenKey(place, "").length), at]));
    const cards = channelCards(channels.entries, { agents: meta.agents, people: [...meta.owners, ...meta.members, ...meta.collaborators], last: channels.last, seen: seenHere, me: me.name });
    const item = (card: typeof cards[number]) => ({
      key: "c:" + card.entry.path, label: card.entry.name, href: placeUrl(place, hashOf("files", { path: card.entry.path })), active: activeChannel === card.entry.path, fresh: card.unread, dim: card.done,
      icon: card.kind === "channel" ? <Hash size={16} /> : <Avatar name={card.entry.name} size={18} kind={card.kind === "agent" ? "agent" : undefined} />,
    });
    const all = { label: "All channels", href: placeUrl(place, hashOf("files", { path: channels.root })) };
    sideSections.push({ key: "channels", title: "Channels", limit: 8, items: cards.filter(card => card.kind !== "agent").map(item), more: all });
    const agents = cards.filter(card => card.kind === "agent");
    if (agents.length) sideSections.push({ key: "agents", title: "Agents", limit: 6, items: agents.map(item) });
  }
  const siblings = route.page === "project" ? space.data?.snapshot.directory.entries : route.page === "space" ? view?.snapshot.directory.entries : undefined;
  if (route.page !== "home" && siblings) sideSections.push({
    key: "projects", title: `Projects in ${place.space}`, limit: 6,
    items: [...siblings].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).map(entry => ({ key: "p:" + entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), icon: <FolderGit2 size={16} />, active: place.project === entry.name })),
  });
  if (route.page === "home" && me.spaces.length) sideSections.push({
    key: "spaces", title: "Your spaces", limit: 6,
    items: me.spaces.map(s => ({ key: "s:" + s.space, label: s.space, href: placeUrl({ space: s.space, project: "" }), icon: <Avatar name={s.space} size={18} kind={s.kind} /> })),
  });
  const recent = recoveryOnly ? [] : recentProjects().filter(name => name !== placeKey);
  if (recent.length) sideSections.push({ key: "recent", title: "Recent", limit: 4, items: recent.map(name => { const [s, p] = name.split("/"); return { key: "r:" + name, label: name, href: placeUrl({ space: s, project: p }), icon: <History size={16} /> }; }) });
  // The hub's own pages, rendered by the server in this same frame.
  const footer = [
    { key: "guide", label: "Guide", href: "/-/guide", icon: <BookOpen size={16} /> },
    { key: "builders", label: "Builders", href: "/-/builders", icon: <Users size={16} /> },
  ];

  // Navigation has one job per piece: the breadcrumb goes up, the dock goes
  // down (the places inside where you are), the tabs switch how you look at
  // the place, and the sidebar goes across (siblings, and where you were).
  let places: DockItem[] = [];
  if (!recovery && route.page === "project" && meta?.level === "project") {
    const roots = [...(view?.snapshot.roots ?? [])].sort((a, b) => {
      const left = SECTION_ORDER.indexOf(a.name.toLowerCase());
      const right = SECTION_ORDER.indexOf(b.name.toLowerCase());
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.name.localeCompare(b.name);
    });
    const top = route.tab === "files" ? route.path.split("/")[0] : "";
    places = roots.slice(0, 8).map(root => { const Icon = SECTION_ICONS.get(root.name.toLowerCase()) ?? Folder; return { key: root.path, label: root.name, href: placeUrl(place, hashOf("files", { path: root.path })), icon: <Icon size={22} strokeWidth={1.7} />, active: top === root.path }; });
  } else if (!recovery && route.page === "space" && meta?.level === "space") {
    places = [...(view?.snapshot.directory.entries ?? [])].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8)
      .map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), icon: <FolderGit2 size={22} strokeWidth={1.7} />, fresh: !!seen[`${place.space}/${entry.name}`] && entry.modifiedAt > seen[`${place.space}/${entry.name}`] }));
  } else if (route.page === "home" && !recovery && meta?.level === "hub") {
    const mine = new Set(me.spaces.map(s => s.space));
    places = [...(view?.snapshot.directory.entries ?? [])].sort((a, b) => Number(mine.has(b.name)) - Number(mine.has(a.name)) || b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8)
      .map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: entry.name, project: "" }), icon: <Avatar name={entry.name} size={30} kind={entry.detail?.startsWith("org") ? "org" : entry.detail?.startsWith("agent") ? "agent" : "personal"} />, fresh: !!seen[entry.name] && entry.modifiedAt > seen[entry.name] }));
  }

  const activity = route.page === "home" && !recovery && activityOpen;

  return <div className={`shell${activity ? " with-inspector" : ""}${rail ? " rail" : ""}`}>
    <Progress />
    <TopBar me={me} signIn={signIn} live={state} onSearch={() => setSearching(true)} onMenu={() => setSidebarOpen(true)} recoveryOnly={recoveryOnly} />
    <Sidebar switcher={switcher} primary={primary} sections={sideSections} footer={footer} open={sidebarOpen} onClose={() => setSidebarOpen(false)} rail={rail} onRail={toggleRail} onSearch={() => setSearching(true)} recoveryOnly={recoveryOnly} />
    <main className="main" id="main">
      <div className="main-scroll">
        {route.page === "home" && !recovery && <HomePage view={view as View<HubMeta> | undefined} me={me.name} mySpaces={me.spaces.map(s => s.space)} seen={seen} activityOpen={activityOpen} onActivity={toggleActivity} />}
        {recovery && <InstanceRecoveryPage onConnectionState={setRecoveryState} />}
        {!recovery && route.page === "space" && <SpacePage name={place.space} tab={route.tab} view={view as View<SpaceMeta> | undefined} error={live.error} me={me.name} seen={seen} />}
        {!recovery && route.page === "project" && <ChannelsContext.Provider value={channels}><ProjectPage route={route} view={view as View<ProjectMeta> | undefined} error={live.error} me={me.name} signIn={signIn} refresh={live.refresh} /></ChannelsContext.Provider>}
      </div>
      <Dock places={places} />
    </main>
    {activity && <Inspector title="Activity" onClose={toggleActivity}><ActivityFeed view={meta?.level === "hub" ? view as View<HubMeta> : undefined} /></Inspector>}
    {searching && !recoveryOnly && <SearchPalette place={place} onClose={() => setSearching(false)} />}
  </div>;
}
