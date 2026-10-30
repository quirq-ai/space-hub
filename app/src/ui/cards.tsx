import type { ReactNode } from "react";
import { onLink } from "@/router";
import { Ago, Avatar } from "./primitives";

/**
 * Every list of places in the app (spaces, projects, sections, folders,
 * channels, agents, people) is drawn the same way: groups with a title, a
 * count and one line on what belongs there, each holding cards. A card says
 * what the place is, its newest change (who, what), when, and whether it
 * changed since the viewer last looked. Cards show where to go, not what a
 * file says: reading is the Code tab's job.
 */

export type Latest = { who?: string; kind?: string; text: ReactNode };

export type PlaceCard = {
  key: string; href: string; icon: ReactNode; title: ReactNode; labels?: ReactNode; detail?: ReactNode;
  latest?: Latest; empty?: string; time?: string; meta?: ReactNode; fresh?: boolean; done?: boolean;
};

/** "6 channels in Chat", with the place's actions on the right. */
export function ListHead({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="list-head"><span>{children}</span>{actions}</div>;
}

export function CardGroup({ title, note, count, compact, cards }: { title: ReactNode; note?: ReactNode; count?: number; compact?: boolean; cards: PlaceCard[] }) {
  if (!cards.length) return null;
  return <section className="place-group">
    <h2 className="section-title">{title} <span className="quiet">{count ?? cards.length}</span></h2>
    {note && <p className="quiet">{note}</p>}
    <ul className={`place-cards${compact ? " compact" : ""}`}>{cards.map(card => <li key={card.key}><Card card={card} /></li>)}</ul>
  </section>;
}

export function Card({ card }: { card: PlaceCard }) {
  return <a className={`place-card${card.done ? " done" : ""}`} href={card.href} onClick={onLink}>
    <span className="place-card-icon">{card.icon}</span>
    <span className="place-card-main">
      <span className="place-card-title"><strong>{card.title}</strong>{card.labels}</span>
      {card.detail && <span className="place-card-detail">{card.detail}</span>}
      {card.latest ? <span className="place-card-last">{card.latest.who && <Avatar name={card.latest.who} size={16} kind={card.latest.kind} />}<span>{card.latest.who && <b>{card.latest.who}</b>} {card.latest.text}</span></span>
        : card.empty ? <span className="place-card-last quiet">{card.empty}</span> : null}
    </span>
    <span className="place-card-meta">{card.time && <Ago iso={card.time} />}{card.meta}{card.fresh && <i className="unread-dot" title="New since you last looked" />}</span>
  </a>;
}

/** The square badge a card shows for a place that has no picture: a folder, a section, a channel. */
export function Glyph({ children, tone }: { children: ReactNode; tone?: "accent" | "quiet" }) {
  return <span className={`glyph${tone ? " " + tone : ""}`}>{children}</span>;
}
