import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown, Hexagon, LogIn, LogOut, Menu, PanelRight, Plus, Search, User } from "lucide-react";
import { ThemePicker } from "@/components/theme-picker";
import { useLoading } from "@/hooks/use-live";
import { onLink } from "@/router";
import { Avatar } from "@/ui/primitives";

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

export function TopBar({ me, signIn, live, onSearch, onMenu, onInspector, inspectorOpen }: {
  me: { checked: boolean; name: string | null }; signIn: string; live: "live" | "offline" | "loading"; onSearch: () => void; onMenu: () => void; onInspector?: () => void; inspectorOpen: boolean;
}) {
  return <header className="topbar">
    <button className="icon-button only-narrow" type="button" aria-label="Open navigation" onClick={onMenu}><Menu size={18} /></button>
    <a className="logo" href="/" onClick={onLink}><Hexagon size={18} strokeWidth={2} /><span>spacehub</span></a>
    <button className="search-trigger" type="button" onClick={onSearch} aria-label="Search spaces, projects and files"><Search size={15} /><span>Search spaces, projects, files</span><kbd>⌘K</kbd></button>
    <span className="topbar-spacer" />
    <span className={`live-pill ${live}`} title={live === "offline" ? "Reconnecting to the hub" : "Changes appear as they happen"}><i />{live === "offline" ? "Reconnecting" : "Live"}</span>
    <ThemePicker />
    {onInspector && <button className={`icon-button only-wide${inspectorOpen ? " active" : ""}`} type="button" aria-label={inspectorOpen ? "Hide details" : "Show details"} aria-pressed={inspectorOpen} onClick={onInspector}><PanelRight size={17} /></button>}
    {!me.checked ? <span className="user-placeholder" aria-hidden="true" /> : me.name ? <UserMenu name={me.name} /> : <a className="button" href={signIn}><LogIn size={15} />Sign in</a>}
  </header>;
}

export type NavItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; badge?: string };
export type NavSection = { title?: string; items: NavItem[] };

export function Sidebar({ sections, open, onClose }: { sections: NavSection[]; open: boolean; onClose: () => void }) {
  return <>
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Navigation">
      {sections.filter(section => section.items.length).map((section, index) => <div className="nav-section" key={section.title ?? index}>
        {section.title && <div className="nav-title">{section.title}</div>}
        {section.items.map(item => <a key={item.key} className={`nav-item${item.active ? " active" : ""}`} href={item.href} onClick={event => { onClose(); onLink(event); }} aria-current={item.active ? "page" : undefined} title={item.label}>
          <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.badge && <span className="nav-badge">{item.badge}</span>}
        </a>)}
      </div>)}
    </nav>
    {open && <button className="scrim only-narrow" type="button" aria-label="Close navigation" onClick={onClose} />}
  </>;
}

export type DockItem = { key: string; label: string; href: string; icon: ReactNode; active?: boolean; fresh?: boolean };

/** The dock: the places of where you are, a gap, then tools. */
export function Dock({ places, tools }: { places: DockItem[]; tools: DockItem[] }) {
  if (!places.length && !tools.length) return null;
  const item = (entry: DockItem) => <a key={entry.key} className={`dock-item${entry.active ? " active" : ""}`} href={entry.href} onClick={onLink} aria-label={entry.label} aria-current={entry.active ? "page" : undefined}>
    <span className="dock-icon">{entry.icon}</span><span className="dock-label">{entry.label}</span>{entry.fresh && <span className="dock-fresh" title="Changed since you last looked" />}
  </a>;
  return <nav className="dock" aria-label="Dock">{places.map(item)}{places.length > 0 && tools.length > 0 && <span className="dock-gap" aria-hidden="true" />}{tools.map(item)}</nav>;
}

export function Inspector({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return <>
    <aside className={`inspector${open ? " open" : ""}`} aria-label="Details">{children}</aside>
    {open && <button className="scrim only-medium" type="button" aria-label="Close details" onClick={onClose} />}
  </>;
}

export function InspectorSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="inspector-section"><div className="inspector-title"><h3>{title}</h3>{action}</div>{children}</section>;
}
