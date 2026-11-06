import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Activity, Check, ChevronRight, ChevronsUpDown, Home, LogIn, LogOut, PanelLeft, Plus, Search, User, X } from "lucide-react";
import { ThemeChoices } from "@/components/theme-picker";
import { HomeGlyph, type DockTone } from "@/shell/dock-glyphs";
import { useLoading } from "@/hooks/use-live";
import { onLink } from "@/router";
import { Avatar, QuirqMark } from "@/ui/primitives";

/** A thin bar across the top while the reader waits for something to load. */
export function Progress() {
  const loading = useLoading();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!loading) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, [loading]);
  return <div className={`progress${shown ? " on" : ""}`} role="progressbar" aria-hidden={!shown} aria-label="Loading" />;
}

/** Close a menu on Escape or a click outside it. */
function useDismiss(open: boolean, setOpen: (open: boolean) => void, box: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open]);
}

export type NavItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; badge?: string; fresh?: boolean; dim?: boolean };
export type SideSection = { key: string; title: string; icon: ReactNode; items: NavItem[]; limit: number; more?: { label: string; href: string } };
export type SpaceOption = { name: string; kind: string; href: string };
export type Viewer = { checked: boolean; name: string | null };

const SIDE = "spacehub:side:v1";
function readSide(): { collapsed: Record<string, boolean> } { try { return { collapsed: {}, ...JSON.parse(localStorage.getItem(SIDE) || "{}") }; } catch { return { collapsed: {} }; } }

const kindLabel = (kind: string) => kind === "org" ? "Org" : kind === "agent" ? "Agent" : "Builder";

type SwitcherInfo = { current: SpaceOption | null; options: SpaceOption[]; signedIn: boolean; onSearch: () => void };

/** The switcher's menu: the hub's Home and Search, then a jump to any of your spaces. */
export function SpaceMenu({ current, options, signedIn, onSearch, onClose }: SwitcherInfo & { onClose: () => void }) {
  const go = (event: ReactMouseEvent<HTMLAnchorElement>) => { onClose(); onLink(event); };
  return <div className="menu dock-menu" role="menu">
    <a role="menuitem" href="/" onClick={go}><Home size={15} />Home</a>
    <button type="button" role="menuitem" onClick={() => { onClose(); onSearch(); }}><Search size={15} />Search<kbd className="nav-kbd">⌘K</kbd></button>
    <div className="menu-sep" />
    <div className="menu-title">Spaces</div>
    <a role="menuitem" href="/" onClick={go} className={!current ? "on" : undefined}><span className="menu-tile"><Home size={13} /></span>All spaces{!current && <Check size={14} className="menu-check" />}</a>
    {options.map(option => <a role="menuitem" key={option.name} href={option.href} onClick={go} className={current?.name === option.name ? "on" : undefined}>
      <span className="menu-tile"><Avatar name={option.name} size={18} kind={option.kind} /></span>{option.name}<span className="menu-note">{kindLabel(option.kind)}</span>{current?.name === option.name && <Check size={14} className="menu-check" />}
    </a>)}
    {signedIn && <><div className="menu-sep" /><a role="menuitem" href="/-/new" className="menu-quiet"><span className="menu-tile dashed"><Plus size={13} /></span>New project</a></>}
  </div>;
}

/** The dock's switcher: which space you are in, and a menu (opening upward) with Home, Search and your spaces. */
function SpaceSwitcher(info: SwitcherInfo) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, box);
  const { current } = info;
  const label = current ? current.name : "All spaces";
  return <div className="dock-switch" ref={box}>
    <button type="button" className="dock-item dock-switcher" aria-haspopup="menu" aria-expanded={open} aria-label={`Space: ${label}. Switch space`} title="Switch space" onClick={() => setOpen(value => !value)}>
      <span className={`dock-icon${current ? "" : " tone tone-home"}`}>{current ? <Avatar name={current.name} size={40} kind={current.kind} /> : <HomeGlyph />}<span className="dock-switch-badge"><ChevronsUpDown size={11} /></span></span>
      <span className="dock-label">{label}</span>
    </button>
    {open && <SpaceMenu {...info} onClose={() => setOpen(false)} />}
  </div>;
}

type AccountInfo = { me: Viewer; signIn: string; recoveryOnly?: boolean; links?: NavItem[] };

const accountName = (me: Viewer, recoveryOnly: boolean) => recoveryOnly ? "Local recovery" : me.name ?? "Guest";
const accountNote = (me: Viewer, recoveryOnly: boolean) => recoveryOnly ? "This instance" : me.name ? "Signed in" : "Not signed in";

/** The account's menu: who you are, your account or Sign in, the hub's own pages, appearance and sign-out. */
export function AccountMenu({ me, signIn, recoveryOnly = false, links = [], onClose }: AccountInfo & { onClose: () => void }) {
  const tile = recoveryOnly ? <span className="side-tile brand"><QuirqMark size={20} /></span> : me.name ? <span className="side-tile"><Avatar name={me.name} size={32} /></span> : <span className="side-tile anon"><User size={16} /></span>;
  const go = (event: ReactMouseEvent<HTMLAnchorElement>) => { onClose(); onLink(event); };
  return <div className="menu dock-menu end" role="menu">
    <div className="menu-head">{tile}<div><strong>{accountName(me, recoveryOnly)}</strong><span>{accountNote(me, recoveryOnly)}</span></div></div>
    {!recoveryOnly && me.name && <>
      <a role="menuitem" href={"/" + encodeURIComponent(me.name)} onClick={go}><User size={15} />Your profile</a>
      <a role="menuitem" href="/-/new"><Plus size={15} />New project</a>
      <div className="menu-sep" />
    </>}
    {!recoveryOnly && !me.name && <><a role="menuitem" href={signIn}><LogIn size={15} />Sign in</a><div className="menu-sep" /></>}
    {!recoveryOnly && links.length > 0 && <>
      {links.map(link => <a role="menuitem" key={link.key} href={link.href} onClick={go} className={link.active ? "on" : undefined} aria-current={link.active ? "page" : undefined}>{link.icon}{link.label}</a>)}
      <div className="menu-sep" />
    </>}
    <ThemeChoices />
    {!recoveryOnly && me.name && <><div className="menu-sep" /><form method="post" action="/-/logout"><button role="menuitem" type="submit"><LogOut size={15} />Sign out</button></form></>}
  </div>;
}

/** The dock's last entry: who you are, drawn like the space switcher, with a menu opening upward. */
function DockAccount({ me, signIn, recoveryOnly = false, links }: AccountInfo) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, box);
  if (!recoveryOnly && !me.checked) return <div className="dock-switch" aria-hidden="true"><span className="dock-item"><span className="dock-icon skeleton" /><span className="dock-label">&nbsp;</span></span></div>;
  const picture = recoveryOnly ? <span className="side-tile brand"><QuirqMark size={20} /></span> : me.name ? <Avatar name={me.name} size={40} /> : <User size={22} strokeWidth={1.7} />;
  return <div className="dock-switch" ref={box}>
    <button type="button" className="dock-item dock-switcher" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${accountName(me, recoveryOnly)}`} title={accountNote(me, recoveryOnly)} onClick={() => setOpen(value => !value)}>
      <span className="dock-icon">{picture}<span className="dock-switch-badge"><ChevronsUpDown size={11} /></span></span>
      <span className="dock-label">{recoveryOnly ? "Recovery" : me.name ? "You" : "Sign in"}</span>
    </button>
    {open && <AccountMenu me={me} signIn={signIn} recoveryOnly={recoveryOnly} links={links} onClose={() => setOpen(false)} />}
  </div>;
}

function Item({ item, rail, onClose, sub = false }: { item: NavItem; rail: boolean; onClose: () => void; sub?: boolean }) {
  return <a className={`${sub ? "nav-sub-item" : "nav-item"}${item.active ? " active" : ""}${item.dim ? " dim" : ""}`} href={item.href} onClick={event => { onClose(); onLink(event); }} aria-current={item.active ? "page" : undefined} title={rail ? item.label : undefined}>
    <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.badge && <span className="nav-badge">{item.badge}</span>}{item.fresh && <i className="unread-dot" title="New since you last looked" />}
  </a>;
}

/**
 * The sidebar, after shadcn's sidebar-07: the hub in the header, then where
 * you are as collapsible lists. Search, your account and the hub's own pages
 * are in the dock's menus. It folds into icons. Standalone recovery has no
 * dock menus for its one page, so Settings stays here.
 */
export function Sidebar({ sectionsTitle, sections, settings, open, onClose, rail, onRail, recoveryOnly = false }: {
  sectionsTitle?: string; sections: SideSection[]; settings?: NavItem;
  open: boolean; onClose: () => void; rail: boolean; onRail: () => void;
  recoveryOnly?: boolean;
}) {
  const [state, setState] = useState(readSide);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const setCollapsed = (key: string, collapsed: boolean) => setState(current => {
    const next = { ...current, collapsed: { ...current.collapsed, [key]: collapsed } };
    try { localStorage.setItem(SIDE, JSON.stringify(next)); } catch { /* Storage may be blocked. */ }
    return next;
  });
  const shownSections = recoveryOnly ? [] : sections.filter(section => section.items.length);
  return <>
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Navigation">
      <div className="side-head">
        <a className="side-button large" href={recoveryOnly ? "/#/settings" : "/"} onClick={event => { onClose(); onLink(event); }} aria-label={recoveryOnly ? "Settings home" : "spacehub home"} title={rail ? "spacehub" : undefined}>
          <span className="side-tile brand"><QuirqMark size={20} /></span><span className="side-text"><strong>spacehub</strong><span>{recoveryOnly ? "Recovery" : "This hub"}</span></span>
        </a>
      </div>
      <div className="side-content">
        {shownSections.length > 0 && <div className="side-group">
          <div className="side-label">{sectionsTitle ?? "Places"}</div>
          {shownSections.map(section => {
            const collapsed = !!state.collapsed[section.key];
            const all = expanded[section.key];
            const active = section.items.find(item => item.active);
            let shown = all ? section.items : section.items.slice(0, section.limit);
            // The place you are in stays visible even when it is further down the list.
            if (!all && active && !shown.includes(active)) shown = [...shown.slice(0, section.limit - 1), active];
            const fresh = section.items.some(item => item.fresh);
            return <div className="nav-section" key={section.key}>
              <button type="button" className={`nav-item${active && (collapsed || rail) ? " active" : ""}`} aria-expanded={!collapsed} title={rail ? section.title : undefined}
                onClick={() => { if (rail) { setCollapsed(section.key, false); onRail(); } else setCollapsed(section.key, !collapsed); }}>
                <span className="nav-icon">{section.icon}</span><span className="nav-label">{section.title}</span>
                {fresh && collapsed && <i className="unread-dot" title="New since you last looked" />}
                <span className="nav-count">{section.items.length}</span><ChevronRight size={14} className={`nav-caret${collapsed ? "" : " open"}`} />
              </button>
              {!collapsed && <div className="nav-sub">
                {shown.map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} sub />)}
                {section.items.length > section.limit && <button type="button" className="nav-sub-item more" onClick={() => setExpanded(current => ({ ...current, [section.key]: !all }))}><span className="nav-label">{all ? "Show fewer" : `Show all ${section.items.length}`}</span></button>}
                {section.more && <a className="nav-sub-item more" href={section.more.href} onClick={event => { onClose(); onLink(event); }}><span className="nav-label">{section.more.label}</span></a>}
              </div>}
            </div>;
          })}
        </div>}
        {recoveryOnly && settings && <div className="side-group side-secondary"><Item item={settings} rail={rail} onClose={onClose} /></div>}
      </div>
      <button type="button" className="side-rail only-wide" tabIndex={-1} aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"} title={rail ? "Expand the sidebar" : "Collapse the sidebar"} onClick={onRail} />
    </nav>
    {open && <button className="scrim only-narrow" type="button" aria-label="Close navigation" onClick={onClose} />}
  </>;
}

/**
 * The page's header inside the inset, as in sidebar-07: the sidebar trigger,
 * where you are, and the place's live state and Activity on the right.
 */
/** The total activity where you are; it ticks as each new one comes in. */
function ActivityCount({ total }: { total: number }) {
  const last = useRef(total);
  const grew = total > last.current;
  useEffect(() => { last.current = total; }, [total]);
  const shown = total.toLocaleString("en-US");
  const word = total === 1 ? "activity" : "activities";
  return <span className="live-count" title={`${shown} ${word} here so far`}><b key={total} className={grew ? "tick" : undefined}>{shown}</b> <span>{word}</span></span>;
}

export function InsetHeader({ crumbs, live, activityTotal, onToggleSidebar, rail, activity, recoveryOnly = false }: {
  crumbs: ReactNode; live: "live" | "offline" | "loading"; activityTotal?: number; onToggleSidebar: () => void; rail: boolean;
  /** The right-hand Activity panel, where the page has one. */
  activity?: { open: boolean; onToggle: () => void };
  recoveryOnly?: boolean;
}) {
  return <header className="inset-header">
    <button className="icon-button side-trigger" type="button" aria-label="Toggle the sidebar" title={`${rail ? "Expand" : "Collapse"} the sidebar (⌘B)`} onClick={onToggleSidebar}><PanelLeft size={16} /></button>
    <span className="inset-sep" aria-hidden="true" />
    <div className="inset-crumbs">{crumbs}</div>
    <span className={`live-pill ${live}`} title={live === "offline" ? recoveryOnly ? "Reconnecting to recovery" : "Reconnecting to the hub" : recoveryOnly ? "Full-instance recovery connection" : "Changes appear as they happen"}><i />{live === "offline" ? "Reconnecting" : "Live"}</span>
    {activityTotal !== undefined && <ActivityCount total={activityTotal} />}
    {activity && <button className={`icon-button${activity.open ? " active" : ""}`} type="button" aria-pressed={activity.open} aria-label="Activity" title={activity.open ? "Hide activity" : "Show activity"} onClick={activity.onToggle}><Activity size={16} /></button>}
  </header>;
}

/** Crumbs for the hub's own pages, in the same look as the path bar. */
export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return <nav className="path-bar" aria-label="Where you are">
    {items.map((item, i) => <span key={item.label} className="path-item">
      {i > 0 && <ChevronRight size={14} className="crumb-sep" />}
      {item.href && i < items.length - 1 ? <span className="path-seg"><a href={item.href} onClick={onLink}>{item.label}</a></span> : <span className="path-seg"><a aria-current="page" className="current">{item.label}</a></span>}
    </span>)}
  </nav>;
}

export type DockItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; fresh?: boolean; /** Draws the icon on its coloured tile (shell.css .tone-<name>). */ tone?: DockTone };

/** The dock: the space you are in (its switcher), the places inside where you are (a project's sections, a space's projects, the hub's parts), and last you (your account). */
export function Dock({ places, switcher, account }: {
  places: DockItem[];
  switcher?: SwitcherInfo;
  account?: AccountInfo;
}) {
  if (!places.length && !switcher && !account) return null;
  const item = (entry: DockItem) => <a key={entry.key} className={`dock-item${entry.active ? " active" : ""}`} href={entry.href} onClick={onLink} aria-label={entry.label} aria-current={entry.active ? "page" : undefined}>
    <span className={`dock-icon${entry.tone ? ` tone tone-${entry.tone}` : ""}`}>{entry.icon}</span><span className="dock-label">{entry.label}</span>{entry.fresh && <span className="dock-fresh" title="Changed since you last looked" />}
  </a>;
  const sep = <span className="dock-sep" aria-hidden="true" />;
  return <div className="dock">
    {switcher && <SpaceSwitcher {...switcher} />}
    {switcher && places.length > 0 && sep}
    {places.length > 0 && <nav className="dock-places" aria-label="Dock">{places.map(item)}</nav>}
    {account && (switcher || places.length > 0) && sep}
    {account && <DockAccount {...account} />}
  </div>;
}

/** The right-hand panel: beside the page on wide windows, over it with a scrim on narrower ones. `note` says whose it is. */
export function Inspector({ title, note, onClose, children }: { title: string; note?: string; onClose: () => void; children: ReactNode }) {
  return <>
    <aside className="inspector" aria-label={note ? `${title} in ${note}` : title}>
      <div className="inspector-head"><h2>{title}{note && <span className="inspector-note" title={note}>{note}</span>}</h2><button className="icon-button" type="button" aria-label={`Close ${title}`} title="Close" onClick={onClose}><X size={16} /></button></div>
      {children}
    </aside>
    <button className="scrim only-medium" type="button" aria-label={`Close ${title}`} onClick={onClose} />
  </>;
}
