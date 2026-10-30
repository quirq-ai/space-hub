import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDownAZ, Clock, LayoutGrid, List, Search, X } from "lucide-react";
import { onLink } from "@/router";
import { Ago, Avatar, AvatarStack } from "./primitives";

/**
 * Every list of places in the app (spaces, projects, sections, folders,
 * channels, agents, people) is drawn the same way: groups with a title, a
 * count and one line on what belongs there, each holding cards. A card says
 * what the place is, its newest change (who, what), who has been at work
 * there, when, and whether it changed since the viewer last looked. Cards
 * show where to go, not what a file says: reading is the Code tab's job.
 */

export type Latest = { who?: string; kind?: string; text: ReactNode };

export type PlaceCard = {
  key: string; href: string; icon: ReactNode; title: ReactNode; labels?: ReactNode; detail?: ReactNode;
  latest?: Latest; empty?: string; time?: string; meta?: ReactNode; fresh?: boolean; done?: boolean;
  /** Plain text for filtering and sorting: the name, then anything else worth matching. */
  name?: string; search?: string;
  /** Who has been at work here lately, newest first. */
  people?: string[];
};

export type Group = { key: string; title: ReactNode; note?: ReactNode; compact?: boolean; cards: PlaceCard[] };

/** "6 channels in Chat", with the place's actions on the right. */
export function ListHead({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="list-head"><span>{children}</span>{actions}</div>;
}

export function CardGroup({ title, note, count, compact, list, cards }: { title: ReactNode; note?: ReactNode; count?: number; compact?: boolean; list?: boolean; cards: PlaceCard[] }) {
  if (!cards.length) return null;
  return <section className="place-group">
    <h2 className="section-title">{title} <span className="quiet">{count ?? cards.length}</span></h2>
    {note && <p className="quiet">{note}</p>}
    <ul className={`place-cards${compact ? " compact" : ""}${list ? " list" : ""}`}>{cards.map(card => <li key={card.key}><Card card={card} /></li>)}</ul>
  </section>;
}

export function Card({ card }: { card: PlaceCard }) {
  return <a className={`place-card${card.done ? " done" : ""}${card.fresh ? " fresh" : ""}`} href={card.href} onClick={onLink}>
    <span className="place-card-icon">{card.icon}</span>
    <span className="place-card-main">
      <span className="place-card-title"><strong>{card.title}</strong>{card.labels}</span>
      {card.detail && <span className="place-card-detail">{card.detail}</span>}
      {card.latest ? <span className="place-card-last">{card.latest.who && <Avatar name={card.latest.who} size={16} kind={card.latest.kind} />}<span>{card.latest.who && <b>{card.latest.who}</b>} {card.latest.text}</span></span>
        : card.empty ? <span className="place-card-last quiet">{card.empty}</span> : null}
    </span>
    <span className="place-card-meta">
      <span className="place-card-when">{card.time && <Ago iso={card.time} />}{card.fresh && <i className="unread-dot" title="New since you last looked" />}</span>
      {card.meta}
      {card.people && card.people.length > 0 && <span className="place-card-people" title={`Lately: ${card.people.join(", ")}`}><AvatarStack names={card.people} max={3} size={18} /></span>}
    </span>
  </a>;
}

/** The square badge a card shows for a place that has no picture: a folder, a section, a channel. */
export function Glyph({ children, tone }: { children: ReactNode; tone?: "accent" | "quiet" }) {
  return <span className={`glyph${tone ? " " + tone : ""}`}>{children}</span>;
}

type Sort = "recent" | "name";
type View = "cards" | "list";
const PREFS = "spacehub:browse:v1";
function readPrefs(): { sort: Sort; view: View } {
  try { const value = JSON.parse(localStorage.getItem(PREFS) || "{}"); return { sort: value.sort === "name" ? "name" : "recent", view: value.view === "list" ? "list" : "cards" }; } catch { return { sort: "recent", view: "cards" }; }
}

const text = (card: PlaceCard) => `${card.name ?? ""} ${card.search ?? ""}`.toLowerCase();
const byRecent = (a: PlaceCard, b: PlaceCard) => (b.time ?? "").localeCompare(a.time ?? "");
const byName = (a: PlaceCard, b: PlaceCard) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true });

/**
 * A page's places, the same everywhere: a toolbar (filter as you type, sort
 * by newest or by name, cards or a dense list, both remembered for the
 * viewer), anything new since the viewer last looked pulled to the top, then
 * the groups. Arrow keys move between cards; Enter opens one.
 */
export function Browser({ head, actions, intro, groups, keepOrder = false }: { head: ReactNode; actions?: ReactNode; intro?: ReactNode; groups: Group[]; keepOrder?: boolean }) {
  const [prefs, setPrefs] = useState(readPrefs);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const set = (next: Partial<typeof prefs>) => setPrefs(current => {
    const value = { ...current, ...next };
    try { localStorage.setItem(PREFS, JSON.stringify(value)); } catch { /* Storage may be blocked. */ }
    return value;
  });
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const order = prefs.sort === "name" ? byName : byRecent;
  const shape = (cards: PlaceCard[]) => {
    const kept = words.length ? cards.filter(card => words.every(word => text(card).includes(word))) : cards;
    return keepOrder && prefs.sort === "recent" ? kept : [...kept].sort((a, b) => order(a, b) || byName(a, b));
  };
  const all = groups.flatMap(group => group.cards);
  const fresh = shape(all.filter(card => card.fresh));
  const freshKeys = new Set(fresh.map(card => card.key));
  const shown = groups.map(group => ({ ...group, cards: shape(group.cards.filter(card => !freshKeys.has(card.key))) }));
  const found = fresh.length + shown.reduce((sum, group) => sum + group.cards.length, 0);
  const list = prefs.view === "list";

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || !(event.target instanceof HTMLAnchorElement) || !event.target.classList.contains("place-card")) return;
    const cards = [...(box.current?.querySelectorAll<HTMLAnchorElement>(".place-card") ?? [])];
    const next = cards[cards.indexOf(event.target) + step];
    if (next) { event.preventDefault(); next.focus(); }
  };
  const filter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setQuery("");
    if (event.key === "ArrowDown" || event.key === "Enter") { const first = box.current?.querySelector<HTMLAnchorElement>(".place-card"); if (first) { event.preventDefault(); first.focus(); } }
  };

  return <div className="browser" ref={box} onKeyDown={move}>
    <div className="browser-bar">
      <span className="browser-head">{words.length ? <>{found} of {all.length} match</> : head}</span>
      {all.length > 4 && <label className="browser-filter"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={filter} placeholder="Filter" aria-label="Filter these places" />{query && <button type="button" aria-label="Clear the filter" onClick={() => setQuery("")}><X size={13} /></button>}</label>}
      <div className="segmented browser-toggle" role="group" aria-label="Sort">
        <button type="button" className={prefs.sort === "recent" ? "on" : ""} aria-pressed={prefs.sort === "recent"} onClick={() => set({ sort: "recent" })} title="Newest first"><Clock size={14} /></button>
        <button type="button" className={prefs.sort === "name" ? "on" : ""} aria-pressed={prefs.sort === "name"} onClick={() => set({ sort: "name" })} title="By name"><ArrowDownAZ size={14} /></button>
      </div>
      <div className="segmented browser-toggle" role="group" aria-label="View">
        <button type="button" className={!list ? "on" : ""} aria-pressed={!list} onClick={() => set({ view: "cards" })} title="Cards"><LayoutGrid size={14} /></button>
        <button type="button" className={list ? "on" : ""} aria-pressed={list} onClick={() => set({ view: "list" })} title="List"><List size={14} /></button>
      </div>
      {actions}
    </div>
    {intro && !words.length && <p className="place-intro">{intro}</p>}
    <CardGroup title="New since you last looked" note="Changed after your last visit; they move back to their group once you open them." list={list} cards={fresh} />
    {shown.map(group => <CardGroup key={group.key} title={group.title} note={words.length ? undefined : group.note} compact={group.compact} list={list} cards={group.cards} />)}
    {words.length > 0 && !found && <p className="quiet browser-none">Nothing here matches “{query}”. <button type="button" className="nav-more" onClick={() => setQuery("")}>Clear the filter</button></p>}
  </div>;
}
