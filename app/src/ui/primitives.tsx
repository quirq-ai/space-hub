import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
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
