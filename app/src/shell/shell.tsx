import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Activity, BookOpen, Check, ChevronDown, ChevronRight, ChevronsUpDown, Home, LogIn, LogOut, PanelLeft, Plus, Search, User, Wifi, WifiOff, X } from "lucide-react";
import { ThemePicker } from "@/components/theme-picker";
import { useLoading } from "@/hooks/use-live";
import type { DockIcon } from "./dock-icons";
import { AppIcon } from "@/ui/app-icon";
import { Glass } from "@/ui/home-screen";
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

function UserMenu({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open]);
  return <div className="menu-anchor" ref={box}>
    <button className="user-button" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Avatar name={name} size={26} /><ChevronDown size={14} /></button>
    {open && <div className="menu" role="menu">
      <div className="menu-head"><Avatar name={name} size={32} /><div><strong>{name}</strong><span>Signed in</span></div></div>
      <a role="menuitem" href={"/" + encodeURIComponent(name)} onClick={event => { setOpen(false); onLink(event); }}><User size={15} />Your profile</a>
      <a role="menuitem" href="/-/new"><Plus size={15} />New project</a>
      <a role="menuitem" href="/-/guide"><BookOpen size={15} />Guide</a>
      <form method="post" action="/-/logout"><button role="menuitem" type="submit"><LogOut size={15} />Sign out</button></form>
    </div>}
  </div>;
}

/** The time, as a phone's status bar shows it. */
function Clock() {
  const read = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const [time, setTime] = useState(read);
  useEffect(() => { const timer = setInterval(() => setTime(read()), 15_000); return () => clearInterval(timer); }, []);
  return <time className="clock" suppressHydrationWarning>{time}</time>;
}

/**
 * The glass bar across the top: your places, where you are (the
 * breadcrumb, each step a menu of the places beside it), search, the
 * activity panel, the connection and the time, and you.
 */
export function TopBar({ me, signIn, live, onSearch, onMenu, activity, crumbs, recoveryOnly = false }: {
  me: { checked: boolean; name: string | null }; signIn: string; live: "live" | "offline" | "loading"; onSearch: () => void; onMenu: () => void;
  /** The right-hand Activity panel, where the page has one. */
  activity?: { open: boolean; onToggle: () => void };
  /** Where you are, after the hub's name. */
  crumbs?: ReactNode;
  recoveryOnly?: boolean;
}) {
  // On a narrow window the breadcrumb scrolls; where you are now stays in view.
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (bar.current) bar.current.scrollLeft = bar.current.scrollWidth; });
  return <header className="topbar">
    <Glass distort />
    <button className="bar-button" type="button" aria-label="Open your places" title="Your places" onClick={onMenu}><PanelLeft size={17} /></button>
    <nav className="crumbs-bar" aria-label="Where you are" ref={bar}>
      <a className="logo" href={recoveryOnly ? "/#/settings" : "/"} onClick={onLink} aria-label={recoveryOnly ? "Settings home" : "spacehub home"}><QuirqMark size={20} /><span>spacehub</span></a>
      {crumbs}
    </nav>
    <span className="topbar-spacer" />
    {!recoveryOnly && <button className="search-trigger" type="button" onClick={onSearch} aria-label="Search spaces, projects and files" title="Search (⌘K)"><Search size={15} /><span>Search</span><kbd>⌘K</kbd></button>}
    {activity && <button className={`bar-button${activity.open ? " active" : ""}`} type="button" aria-pressed={activity.open} aria-label="Activity" title={activity.open ? "Hide activity" : "Show activity"} onClick={activity.onToggle}><Activity size={17} /></button>}
    <span className={`conn ${live}`} title={live === "offline" ? recoveryOnly ? "Reconnecting to recovery" : "Reconnecting to the hub" : recoveryOnly ? "Full-instance recovery connection" : "Live: changes appear as they happen"}>
      {live === "offline" ? <WifiOff size={15} /> : <Wifi size={15} />}<span className="conn-text">{live === "offline" ? "Reconnecting" : "Live"}</span><Clock />
    </span>
    {recoveryOnly ? <span className="label">Local recovery</span> : !me.checked ? <span className="user-placeholder" aria-hidden="true" /> : me.name ? <UserMenu name={me.name} /> : <a className="button primary" href={signIn}><LogIn size={15} />Sign in</a>}
  </header>;
}

export type NavItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; badge?: string; fresh?: boolean; dim?: boolean };
export type SideSection = { key: string; title: string; items: NavItem[]; limit: number; more?: { label: string; href: string } };
export type SpaceOption = { name: string; kind: string; href: string };

const SIDE = "spacehub:side:v1";
function readSide(): { collapsed: Record<string, boolean> } { try { return { collapsed: {}, ...JSON.parse(localStorage.getItem(SIDE) || "{}") }; } catch { return { collapsed: {} }; } }

/** Which space you are in, and a menu to jump to any of yours. */
function SpaceSwitcher({ current, options }: { current: SpaceOption | null; options: SpaceOption[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open]);
  const label = current ? current.name : "All spaces";
  return <div className="switcher" ref={box}>
    <button type="button" className="switcher-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {current ? <Avatar name={current.name} size={24} kind={current.kind} /> : <span className="switcher-all"><Home size={15} /></span>}
      <span className="switcher-text"><strong>{label}</strong><span>{current ? (current.kind === "org" ? "Org" : current.kind === "agent" ? "Agent" : "Builder") : "This hub"}</span></span>
      <ChevronsUpDown size={15} className="switcher-chevron" />
    </button>
    {open && <div className="menu switcher-menu" role="menu">
      <a role="menuitem" href="/" onClick={event => { setOpen(false); onLink(event); }} className={!current ? "on" : undefined}><span className="switcher-all small"><Home size={13} /></span>All spaces</a>
      {options.length > 0 && <div className="menu-title">Your spaces</div>}
      {options.map(option => <a role="menuitem" key={option.name} href={option.href} onClick={event => { setOpen(false); onLink(event); }} className={current?.name === option.name ? "on" : undefined}>
        <Avatar name={option.name} size={20} kind={option.kind} />{option.name}{current?.name === option.name && <Check size={14} className="menu-check" />}
      </a>)}
    </div>}
  </div>;
}

function Item({ item, onClose }: { item: NavItem; onClose: () => void }) {
  return <a className={`nav-item${item.active ? " active" : ""}${item.dim ? " dim" : ""}`} href={item.href} onClick={event => { onClose(); onLink(event); }} aria-current={item.active ? "page" : undefined}>
    <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.badge && <span className="nav-badge">{item.badge}</span>}{item.fresh && <i className="unread-dot" title="New since you last looked" />}
  </a>;
}

/**
 * Your places, in a glass panel that slides over from the left: a space
 * switcher, Home and search, short collapsible lists (the current space's
 * projects, recent ones) that expand on request, and a footer.
 */
export function Sidebar({ switcher, primary, sections, footer, open, onClose, onSearch, recoveryOnly = false }: {
  switcher: { current: SpaceOption | null; options: SpaceOption[] }; primary: NavItem[]; sections: SideSection[]; footer: NavItem[];
  open: boolean; onClose: () => void; onSearch: () => void;
  recoveryOnly?: boolean;
}) {
  const [state, setState] = useState(readSide);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setState(current => {
    const next = { ...current, collapsed: { ...current.collapsed, [key]: !current.collapsed[key] } };
    try { localStorage.setItem(SIDE, JSON.stringify(next)); } catch { /* Storage may be blocked. */ }
    return next;
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [open, onClose]);
  return <>
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Your places" inert={!open}>
      <Glass />
      <div className="sidebar-head">
        {!recoveryOnly && <SpaceSwitcher current={switcher.current} options={switcher.options} />}
        <button className="bar-button" type="button" aria-label="Close your places" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="nav-group">
        {primary.slice(0, 1).map(item => <Item key={item.key} item={item} onClose={onClose} />)}
        {!recoveryOnly && <button type="button" className="nav-item" onClick={() => { onClose(); onSearch(); }}><span className="nav-icon"><Search size={16} /></span><span className="nav-label">Search</span><kbd className="nav-kbd">⌘K</kbd></button>}
        {primary.slice(1).map(item => <Item key={item.key} item={item} onClose={onClose} />)}
      </div>
      <div className="side-scroll">
        {!recoveryOnly && sections.filter(section => section.items.length).map(section => {
          const collapsed = !!state.collapsed[section.key];
          const all = expanded[section.key];
          const active = section.items.find(item => item.active);
          let shown = all ? section.items : section.items.slice(0, section.limit);
          // The place you are in stays visible even when it is further down the list.
          if (!all && active && !shown.includes(active)) shown = [...shown.slice(0, section.limit - 1), active];
          return <div className="nav-section" key={section.key}>
            <button type="button" className="nav-title" aria-expanded={!collapsed} onClick={() => toggle(section.key)}>
              <ChevronRight size={12} className={`nav-caret${collapsed ? "" : " open"}`} /><span>{section.title}</span><span className="nav-count">{section.items.length}</span>
            </button>
            {!collapsed && <div className="nav-list">
              {shown.map(item => <Item key={item.key} item={item} onClose={onClose} />)}
              {section.items.length > section.limit && <button type="button" className="nav-more" onClick={() => setExpanded(current => ({ ...current, [section.key]: !all }))}>{all ? "Show fewer" : `Show all ${section.items.length}`}</button>}
              {section.more && <a className="nav-more" href={section.more.href} onClick={event => { onClose(); onLink(event); }}>{section.more.label}</a>}
            </div>}
          </div>;
        })}
      </div>
      <div className="side-foot">
        <ThemePicker variant="nav" />
        {footer.filter(item => !recoveryOnly || item.key === "settings").map(item => <Item key={item.key} item={item} onClose={onClose} />)}
      </div>
    </nav>
    {open && <button className="scrim" type="button" aria-label="Close your places" onClick={onClose} />}
  </>;
}

export type DockItem = { key: string; label: string; href: string; icon: DockIcon; title?: string; active?: boolean; fresh?: boolean; divider?: boolean };

/** The dock: a labeled launcher that goes anywhere (home, your spaces, the projects you were in, settings, the guide). */

// xo-swarm's liquid glass: the backdrop is bent through fractal noise, blurred
// into a soft displacement map, under a frosted tint and a shine on the edge.
// Rendered once; every distorted pane of glass points at it.
export function GlassFilter() {
  return <svg className="glass-filter" aria-hidden="true">
    <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
      <feGaussianBlur in="turbulence" stdDeviation={3} result="softMap" />
      <feDisplacementMap in="SourceGraphic" in2="softMap" scale={150} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </svg>;
}

// macOS's dock magnification: an icon grows and lifts the nearer the pointer
// is, along a cosine over `REACH` pixels each way.
const REACH = 140;

/** The places inside where you are, as app icons on a glass dock: they magnify under the pointer, bounce when opened, and show their name above. */
export function Dock({ places }: { places: DockItem[] }) {
  const row = useRef<HTMLDivElement>(null);
  const magnify = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = row.current;
    if (!box || event.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const x = event.clientX - box.getBoundingClientRect().left + box.scrollLeft;
    for (const item of Array.from(box.children) as HTMLElement[]) {
      // Layout positions, which the magnification itself does not move.
      const distance = Math.abs(x - (item.offsetLeft + item.offsetWidth / 2));
      item.style.setProperty("--lift", distance < REACH ? ((Math.cos((distance / REACH) * Math.PI) + 1) / 2).toFixed(3) : "0");
    }
  };
  const settle = () => { for (const item of Array.from(row.current?.children ?? []) as HTMLElement[]) item.style.removeProperty("--lift"); };
  const open = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const item = event.currentTarget;
    item.classList.remove("opening");
    void item.offsetWidth;
    item.classList.add("opening");
    onLink(event);
  };
  if (!places.length) return null;
  return <nav className="dock" aria-label="Dock">
    <Glass distort />
    <div className="dock-items" ref={row} onPointerMove={magnify} onPointerLeave={settle}>
      {places.map(entry => <Fragment key={entry.key}>
        {entry.divider && <span className="dock-divider" aria-hidden="true" />}
        <a className={`dock-item${entry.active ? " active" : ""}`} href={entry.href} onClick={open} onAnimationEnd={event => event.currentTarget.classList.remove("opening")} title={entry.title} aria-current={entry.active ? "page" : undefined}>
          <span className="dock-pic"><AppIcon icon={entry.icon} />{entry.fresh && <span className="dock-fresh" title="Changed since you last looked" />}</span>
          <span className="dock-name">{entry.label}</span>
        </a>
      </Fragment>)}
    </div>
  </nav>;
}

/** The right-hand glass panel, sliding over the page like your places panel on the left. `note` says whose it is. */
export function Inspector({ title, note, onClose, children }: { title: string; note?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [onClose]);
  return <>
    <aside className="inspector" aria-label={note ? `${title} in ${note}` : title}>
      <Glass />
      <div className="inspector-scroll">
        <div className="inspector-head"><h2>{title}{note && <span className="inspector-note" title={note}>{note}</span>}</h2><button className="bar-button" type="button" aria-label={`Close ${title}`} title="Close" onClick={onClose}><X size={16} /></button></div>
        {children}
      </div>
    </aside>
    <button className="scrim" type="button" aria-label={`Close ${title}`} onClick={onClose} />
  </>;
}
