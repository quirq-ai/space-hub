import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, ChevronsUpDown, Home, LogIn, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, User, X } from "lucide-react";
import { ThemePicker } from "@/components/theme-picker";
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

export function TopBar({ me, signIn, live, onSearch, onMenu }: {
  me: { checked: boolean; name: string | null }; signIn: string; live: "live" | "offline" | "loading"; onSearch: () => void; onMenu: () => void;
}) {
  return <header className="topbar">
    <button className="icon-button only-narrow" type="button" aria-label="Open navigation" onClick={onMenu}><Menu size={18} /></button>
    <a className="logo" href="/" onClick={onLink} aria-label="spacehub home"><QuirqMark /><span>spacehub</span></a>
    <button className="search-trigger" type="button" onClick={onSearch} aria-label="Search spaces, projects and files"><Search size={15} /><span>Search spaces, projects, files</span><kbd>⌘K</kbd></button>
    <span className="topbar-spacer" />
    <span className={`live-pill ${live}`} title={live === "offline" ? "Reconnecting to the hub" : "Changes appear as they happen"}><i />{live === "offline" ? "Reconnecting" : "Live"}</span>
    <ThemePicker />
    {!me.checked ? <span className="user-placeholder" aria-hidden="true" /> : me.name ? <UserMenu name={me.name} /> : <a className="button" href={signIn}><LogIn size={15} />Sign in</a>}
  </header>;
}

export type NavItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; badge?: string; fresh?: boolean; dim?: boolean };
export type SideSection = { key: string; title: string; items: NavItem[]; limit: number; more?: { label: string; href: string } };
export type SpaceOption = { name: string; kind: string; href: string };

const SIDE = "spacehub:side:v1";
function readSide(): { collapsed: Record<string, boolean> } { try { return { collapsed: {}, ...JSON.parse(localStorage.getItem(SIDE) || "{}") }; } catch { return { collapsed: {} }; } }

/** Which space you are in, and a menu to jump to any of yours. */
function SpaceSwitcher({ current, options, rail }: { current: SpaceOption | null; options: SpaceOption[]; rail: boolean }) {
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
    <button type="button" className="switcher-button" aria-haspopup="menu" aria-expanded={open} title={rail ? label : undefined} onClick={() => setOpen(value => !value)}>
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

function Item({ item, rail, onClose }: { item: NavItem; rail: boolean; onClose: () => void }) {
  return <a className={`nav-item${item.active ? " active" : ""}${item.dim ? " dim" : ""}`} href={item.href} onClick={event => { onClose(); onLink(event); }} aria-current={item.active ? "page" : undefined} title={rail ? item.label : undefined}>
    <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.badge && <span className="nav-badge">{item.badge}</span>}{item.fresh && <i className="unread-dot" title="New since you last looked" />}
  </a>;
}

/**
 * The sidebar fits the window: a space switcher, the main places, short
 * collapsible lists (the current space's projects, recent ones) that expand
 * on request, and a footer pinned to the bottom. It folds into an icon rail.
 */
export function Sidebar({ switcher, primary, sections, footer, open, onClose, rail, onRail, onSearch }: {
  switcher: { current: SpaceOption | null; options: SpaceOption[] }; primary: NavItem[]; sections: SideSection[]; footer: NavItem[];
  open: boolean; onClose: () => void; rail: boolean; onRail: () => void; onSearch: () => void;
}) {
  const [state, setState] = useState(readSide);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setState(current => {
    const next = { ...current, collapsed: { ...current.collapsed, [key]: !current.collapsed[key] } };
    try { localStorage.setItem(SIDE, JSON.stringify(next)); } catch { /* Storage may be blocked. */ }
    return next;
  });
  return <>
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Navigation">
      <SpaceSwitcher current={switcher.current} options={switcher.options} rail={rail} />
      <div className="nav-group">
        {primary.slice(0, 1).map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
        <button type="button" className="nav-item" onClick={() => { onClose(); onSearch(); }} title={rail ? "Search" : undefined}><span className="nav-icon"><Search size={16} /></span><span className="nav-label">Search</span><kbd className="nav-kbd">⌘K</kbd></button>
        {primary.slice(1).map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
      </div>
      <div className="side-scroll">
        {sections.filter(section => section.items.length).map(section => {
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
            {!collapsed && <>
              {shown.map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
              {section.items.length > section.limit && <button type="button" className="nav-more" onClick={() => setExpanded(current => ({ ...current, [section.key]: !all }))}>{all ? "Show fewer" : `Show all ${section.items.length}`}</button>}
              {section.more && <a className="nav-more" href={section.more.href} onClick={event => { onClose(); onLink(event); }}>{section.more.label}</a>}
            </>}
          </div>;
        })}
      </div>
      <div className="side-foot">
        {footer.map(item => <Item key={item.key} item={item} rail={rail} onClose={onClose} />)}
        <button type="button" className="nav-item rail-toggle only-wide" onClick={onRail} aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"} title={rail ? "Expand the sidebar" : "Collapse the sidebar"}>
          <span className="nav-icon">{rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</span><span className="nav-label">Collapse</span>
        </button>
      </div>
    </nav>
    {open && <button className="scrim only-narrow" type="button" aria-label="Close navigation" onClick={onClose} />}
  </>;
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

/** The right-hand panel: beside the page on wide windows, over it with a scrim on narrower ones. */
export function Inspector({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <>
    <aside className="inspector" aria-label={title}>
      <div className="inspector-head"><h2>{title}</h2><button className="icon-button" type="button" aria-label={`Close ${title}`} title="Close" onClick={onClose}><X size={16} /></button></div>
      {children}
    </aside>
    <button className="scrim only-medium" type="button" aria-label={`Close ${title}`} onClick={onClose} />
  </>;
}
