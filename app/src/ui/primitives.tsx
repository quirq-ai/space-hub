import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Blobatar } from "@blobatar/react";
import { ago, avatarUrl } from "@/api";
import { onLink } from "@/router";

/** A person, org or agent. The hub serves a picture for every name (GitHub's, or initials). */
export function Avatar({ name, size = 24, kind, title }: { name: string; size?: number; kind?: string; title?: string }) {
  if (name === "quirqy") return <span className="avatar quirqy" style={{ width: size, height: size }} title={title ?? "quirqy"}><Blobatar name="quirqy" size={size} animate="hover" aria-hidden="true" /></span>;
  const square = kind === "org" || kind === "agent";
  return <img className={`avatar${square ? " square" : ""}`} src={avatarUrl(name)} width={size} height={size} alt="" title={title ?? name} loading="lazy" decoding="async" />;
}

/** Stacked avatars for a few people, with a count for the rest. */
export function AvatarStack({ names, max = 4, size = 22 }: { names: string[]; max?: number; size?: number }) {
  const shown = names.slice(0, max);
  return <span className="avatar-stack">{shown.map(name => <Avatar key={name} name={name} size={size} />)}{names.length > max && <span className="avatar-more" style={{ height: size, minWidth: size }}>+{names.length - max}</span>}</span>;
}

export function PersonLink({ name, size = 20, kind }: { name: string; size?: number; kind?: string }) {
  return <a className="person" href={"/" + encodeURIComponent(name)} onClick={onLink}><Avatar name={name} size={size} kind={kind} /><span>{name}</span></a>;
}

/** "3 min ago", kept current, with the exact time on hover. */
export function Ago({ iso }: { iso: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 30_000); return () => clearInterval(timer); }, []);
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{ago(iso)}</time>;
}

export function Skeleton({ width = "100%", height = 12, round = false }: { width?: number | string; height?: number; round?: boolean }) {
  return <span className={`skeleton${round ? " round" : ""}`} style={{ width, height }} aria-hidden="true" />;
}

/** Placeholder rows shaped like the list they stand in for. */
export function SkeletonRows({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  return <div className="skeleton-rows" role="status" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div className="skeleton-row" key={i}>
    {avatar && <Skeleton width={28} height={28} round />}
    <span className="skeleton-lines"><Skeleton width={`${40 + ((i * 17) % 35)}%`} height={11} /><Skeleton width={`${20 + ((i * 11) % 25)}%`} height={9} /></span>
  </div>)}</div>;
}

export function SkeletonText({ lines = 8 }: { lines?: number }) {
  return <div className="skeleton-text" role="status" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={`${55 + ((i * 23) % 40)}%`} height={11} />)}</div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" type="button" aria-label={label} title={copied ? "Copied" : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Clipboard may be blocked. */ }
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon">{icon}</span><h3>{title}</h3>{children && <div className="empty-body">{children}</div>}</div>;
}

export function ErrorNote({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-note" role="alert"><span>{message}</span>{retry && <button type="button" onClick={retry}>Try again</button>}</div>;
}

/** The quirq mark: the "q" in a rounded square, in the text color, so it inverts with the theme. */
export function QuirqMark({ size = 22 }: { size?: number }) {
  return <svg className="quirq-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="currentColor" />
    <path className="quirq-mark-q" transform="translate(15 9) scale(.34)" d="M50 0A50 50 0 0 1 100 50V118A14 14 0 0 1 86 132A14 14 0 0 1 72 118V94.87A50 50 0 1 1 50 0ZM50 33A17 17 0 1 0 50 67A17 17 0 1 0 50 33Z" />
  </svg>;
}

/** A button that opens a small panel below it; Escape or a click outside closes it. */
export function Popover({ label, icon, children, width = 440, primary = false }: { label: string; icon?: ReactNode; children: ReactNode; width?: number; primary?: boolean }) {
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
  return <div className="popover-anchor" ref={box}>
    <button type="button" className={`button${primary ? " primary" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>{icon}{label}<ChevronDown size={14} /></button>
    {open && <div className="popover" role="dialog" aria-label={label} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>{children}</div>}
  </div>;
}

/** Commands to work on a place, in tabs, each wrapping rather than scrolling, with a copy button. */
export function CommandTabs({ tabs, note }: { tabs: { label: string; lines: string[] }[]; note?: ReactNode }) {
  const [current, setCurrent] = useState(0);
  const shown = tabs[Math.min(current, tabs.length - 1)];
  return <div className="command-tabs">
    {tabs.length > 1 && <div className="segmented" role="tablist">{tabs.map((tab, i) => <button key={tab.label} type="button" role="tab" aria-selected={i === current} className={i === current ? "on" : undefined} onClick={() => setCurrent(i)}>{tab.label}</button>)}</div>}
    {shown.lines.map(line => <div className="command" key={line}><code>{line}</code><CopyButton text={line} label="Copy command" /></div>)}
    {note && <p className="command-note">{note}</p>}
  </div>;
}
