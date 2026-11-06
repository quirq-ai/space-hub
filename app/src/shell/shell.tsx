import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Activity, Check, ChevronRight, ChevronsUpDown, Home, LogIn, LogOut, PanelLeft, Plus, Search, User, X } from "lucide-react";
import { ThemeChoices } from "@/components/theme-picker";
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

/** The sidebar's header: which space you are in, and a menu to jump to any of yours. */
function SpaceSwitcher({ current, options, rail, signedIn }: { current: SpaceOption | null; options: SpaceOption[]; rail: boolean; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, box);
  const label = current ? current.name : "spacehub";
  const go = (event: ReactMouseEvent<HTMLAnchorElement>) => { setOpen(false); onLink(event); };
  return <div className="switcher" ref={box}>
    <button type="button" className="side-button large" aria-haspopup="menu" aria-expanded={open} title={rail ? label : undefined} onClick={() => setOpen(value => !value)}>
      {current ? <span className="side-tile"><Avatar name={current.name} size={32} kind={current.kind} /></span> : <span className="side-tile brand"><QuirqMark size={20} /></span>}
      <span className="side-text"><strong>{label}</strong><span>{current ? kindLabel(current.kind) : "All spaces"}</span></span>
      <ChevronsUpDown size={16} className="side-chevron" />
    </button>
    {open && <div className="menu side-menu" role="menu">
      <div className="menu-title">Spaces</div>
      <a role="menuitem" href="/" onClick={go} className={!current ? "on" : undefined}><span className="menu-tile"><Home size={13} /></span>All spaces{!current && <Check size={14} className="menu-check" />}</a>
      {options.map(option => <a role="menuitem" key={option.name} href={option.href} onClick={go} className={current?.name === option.name ? "on" : undefined}>
        <span className="menu-tile"><Avatar name={option.name} size={18} kind={option.kind} /></span>{option.name}{current?.name === option.name && <Check size={14} className="menu-check" />}
      </a>)}
      {signedIn && <><div className="menu-sep" /><a role="menuitem" href="/-/new" className="menu-quiet"><span className="menu-tile dashed"><Plus size={13} /></span>New project</a></>}
    </div>}
  </div>;
}

/** The sidebar's footer: who you are, with your account, appearance and sign-out in one menu. */
function NavUser({ me, signIn, rail, recoveryOnly }: { me: Viewer; signIn: string; rail: boolean; recoveryOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, box);
  if (!recoveryOnly && !me.checked) return <div className="nav-user"><span className="side-button large" aria-hidden="true"><span className="side-tile skeleton" /></span></div>;
  const name = recoveryOnly ? "Local recovery" : me.name ?? "Guest";
  const note = recoveryOnly ? "This instance" : me.name ? "Signed in" : "Not signed in";
  const tile = recoveryOnly ? <span className="side-tile brand"><QuirqMark size={20} /></span> : me.name ? <span className="side-tile"><Avatar name={me.name} size={32} /></span> : <span className="side-tile anon"><User size={16} /></span>;
  const head = <div className="menu-head">{tile}<div><strong>{name}</strong><span>{note}</span></div></div>;
  const go = (event: ReactMouseEvent<HTMLAnchorElement>) => { setOpen(false); onLink(event); };
  return <div className="nav-user" ref={box}>
    <button type="button" className="side-button large" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${name}`} title={rail ? name : undefined} onClick={() => setOpen(value => !value)}>
      {tile}<span className="side-text"><strong>{name}</strong><span>{note}</span></span><ChevronsUpDown size={16} className="side-chevron" />
    </button>
    {open && <div className="menu side-menu up" role="menu">
      {head}
      {!recoveryOnly && me.name && <>
        <a role="menuitem" href={"/" + encodeURIComponent(me.name)} onClick={go}><User size={15} />Your profile</a>
        <a role="menuitem" href="/-/new"><Plus size={15} />New project</a>
        <div className="menu-sep" />
      </>}
      {!recoveryOnly && !me.name && <><a role="menuitem" href={signIn}><LogIn size={15} />Sign in</a><div className="menu-sep" /></>}
      <ThemeChoices />
      {!recoveryOnly && me.name && <><div className="menu-sep" /><form method="post" action="/-/logout"><button role="menuitem" type="submit"><LogOut size={15} />Sign out</button></form></>}
    </div>}
  </div>;
}

function Item({ item, rail, onClose, sub = false }: { item: NavItem; rail: boolean; onClose: () => void; sub?: boolean }) {
  return <a className={`${sub ? "nav-sub-item" : "nav-item"}${item.active ? " active" : ""}${item.dim ? " dim" : ""}`} href={item.href} onClick={event => { onClose(); onLink(event); }} aria-current={item.active ? "page" : undefined} title={rail ? item.label : undefined}>
    <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.badge && <span className="nav-badge">{item.badge}</span>}{item.fresh && <i className="unread-dot" title="New since you last looked" />}
  </a>;
}

/**
 * The sidebar, after shadcn's sidebar-07: a space switcher in the header,
 * groups of places (the main ones, then where you are as collapsible lists),
 * the hub's own pages, and your account in the footer. It folds into icons.
 */
export function Sidebar({ switcher, primary, sectionsTitle, sections, footer, me, signIn, open, onClose, rail, onRail, onSearch, recoveryOnly = false }: {
  switcher: { current: SpaceOption | null; options: SpaceOption[] }; primary: NavItem[]; sectionsTitle?: string; sections: SideSection[]; footer: NavItem[];
  me: Viewer; signIn: string;
  open: boolean; onClose: () => void; rail: boolean; onRail: () => void; onSearch: () => void;
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
        {recoveryOnly ? <a className="side-button large" href="/#/settings" onClick={onLink} aria-label="Settings home"><span className="side-tile brand"><QuirqMark size={20} /></span><span className="side-text"><strong>spacehub</strong><span>Recovery</span></span></a>
          : <SpaceSwitcher current={switcher.current} options={switcher.options} rail={rail} signedIn={!!me.name} />}
      </div>
      <div className="side-content">
        {!recoveryOnly && <div className="side-group">
          <div className="side-label">Platform</div>
          {primary.slice(0, 1).map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
          <button type="button" className="nav-item" onClick={() => { onClose(); onSearch(); }} title={rail ? "Search" : undefined}><span className="nav-icon"><Search size={16} /></span><span className="nav-label">Search</span><kbd className="nav-kbd">⌘K</kbd></button>
          {primary.slice(1).map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
        </div>}
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
        <div className="side-group side-secondary">
          {footer.filter(item => !recoveryOnly || item.key === "settings").map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
        </div>
      </div>
      <div className="side-foot"><NavUser me={me} signIn={signIn} rail={rail} recoveryOnly={recoveryOnly} /></div>
      <button type="button" className="side-rail only-wide" tabIndex={-1} aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"} title={rail ? "Expand the sidebar" : "Collapse the sidebar"} onClick={onRail} />
    </nav>
    {open && <button className="scrim only-narrow" type="button" aria-label="Close navigation" onClick={onClose} />}
  </>;
}

/**
 * The page's header inside the inset, as in sidebar-07: the sidebar trigger,
 * where you are, and the place's live state and Activity on the right.
 */
export function InsetHeader({ crumbs, live, onToggleSidebar, rail, activity, recoveryOnly = false }: {
  crumbs: ReactNode; live: "live" | "offline" | "loading"; onToggleSidebar: () => void; rail: boolean;
  /** The right-hand Activity panel, where the page has one. */
  activity?: { open: boolean; onToggle: () => void };
  recoveryOnly?: boolean;
}) {
  return <header className="inset-header">
    <button className="icon-button side-trigger" type="button" aria-label="Toggle the sidebar" title={`${rail ? "Expand" : "Collapse"} the sidebar (⌘B)`} onClick={onToggleSidebar}><PanelLeft size={16} /></button>
    <span className="inset-sep" aria-hidden="true" />
    <div className="inset-crumbs">{crumbs}</div>
    <span className={`live-pill ${live}`} title={live === "offline" ? recoveryOnly ? "Reconnecting to recovery" : "Reconnecting to the hub" : recoveryOnly ? "Full-instance recovery connection" : "Changes appear as they happen"}><i />{live === "offline" ? "Reconnecting" : "Live"}</span>
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

export type DockItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; fresh?: boolean };

/** The dock: the places inside where you are (a project's sections, a space's projects, the hub's spaces). */
export function Dock({ places }: { places: DockItem[] }) {
  if (!places.length) return null;
  const item = (entry: DockItem) => <a key={entry.key} className={`dock-item${entry.active ? " active" : ""}`} href={entry.href} onClick={onLink} aria-label={entry.label} aria-current={entry.active ? "page" : undefined}>
    <span className="dock-icon">{entry.icon}</span><span className="dock-label">{entry.label}</span>{entry.fresh && <span className="dock-fresh" title="Changed since you last looked" />}
  </a>;
  return <nav className="dock" aria-label="Dock">{places.map(item)}</nav>;
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
