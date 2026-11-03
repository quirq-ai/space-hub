import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, File, Folder, FolderGit2, Home } from "lucide-react";
import { placeUrl, viewUrl, type Place, type View } from "@/api";
import { hashOf, onLink } from "@/router";
import { Avatar } from "@/ui/primitives";

type Option = { key: string; label: string; href: string; kind: "space" | "project" | "folder" | "file"; spaceKind?: string };
type Segment = { key: string; label: string; href: string; current: boolean; load: () => Promise<Option[]> };

const MAX = 60;

async function listing(url: string): Promise<View | undefined> {
  try { const response = await fetch(url, { cache: "no-store" }); return response.ok ? await response.json() as View : undefined; } catch { return undefined; }
}

const spaceKind = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

/** The segments for where you are: each space, project and folder, with the places beside it one click away. */
function segmentsOf(place: Place, path: string): Segment[] {
  const segments: Segment[] = [{
    key: "space", label: place.space, href: placeUrl({ space: place.space, project: "" }), current: !place.project,
    load: async () => (await listing(viewUrl({ space: "", project: "" })))?.snapshot.directory.entries.map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: entry.name, project: "" }), kind: "space" as const, spaceKind: spaceKind(entry.detail) })) ?? [],
  }];
  if (!place.project) return segments;
  segments.push({
    key: "project", label: place.project, href: placeUrl(place, hashOf("files")), current: !path,
    load: async () => (await listing(viewUrl({ space: place.space, project: "" })))?.snapshot.directory.entries.map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), kind: "project" as const })) ?? [],
  });
  const parts = path.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    const parent = parts.slice(0, i).join("/");
    segments.push({
      key: "p" + i, label: part, href: placeUrl(place, hashOf("files", { path: parts.slice(0, i + 1).join("/") })), current: i === parts.length - 1,
      load: async () => {
        const entries = (await listing(viewUrl(place, parent)))?.snapshot.directory.entries ?? [];
        return [...entries].filter(entry => !/\.log\.jsonl$/i.test(entry.name)).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name))
          .map(entry => ({ key: entry.path, label: entry.name, href: placeUrl(place, hashOf("files", { path: entry.path })), kind: entry.kind === "directory" ? "folder" as const : "file" as const }));
      },
    });
  });
  return segments;
}

function SegmentMenu({ segment }: { segment: Segment }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[]>();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void segment.load().then(list => { if (live) setOptions(list); });
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { live = false; removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open, segment.href]);
  const icon = (option: Option) => option.kind === "space" ? <Avatar name={option.label} size={18} kind={option.spaceKind} />
    : option.kind === "project" ? <FolderGit2 size={15} /> : option.kind === "folder" ? <Folder size={15} /> : <File size={15} />;
  return <span className="path-seg" ref={box}>
    <a href={segment.href} onClick={onLink} aria-current={segment.current ? "page" : undefined} className={segment.current ? "current" : undefined}>{segment.label}</a>
    <button type="button" className="path-more" aria-haspopup="menu" aria-expanded={open} aria-label={`Places beside ${segment.label}`} title="Jump to a place beside this one" onClick={() => setOpen(value => !value)}><ChevronDown size={13} /></button>
    {open && <div className="menu path-menu" role="menu">
      {!options ? <div className="menu-title">Loading…</div> : !options.length ? <div className="menu-title">Nothing else here</div>
        : options.slice(0, MAX).map(option => <a role="menuitem" key={option.key} href={option.href} className={option.label === segment.label ? "on" : undefined} onClick={event => { setOpen(false); onLink(event); }}>
          {icon(option)}<span>{option.label}</span>{option.label === segment.label && <Check size={14} className="menu-check" />}
        </a>)}
      {options && options.length > MAX && <div className="menu-title">and {options.length - MAX} more</div>}
    </div>}
  </span>;
}

/**
 * Where you are, as one line at the top of every space and project page:
 * home, then the space, the project and each folder. A segment goes up to
 * that place; its arrow opens the places beside it, so moving across never
 * needs a trip back up.
 */
export function PathBar({ place, path }: { place: Place; path: string }) {
  const segments = segmentsOf(place, path);
  return <nav className="path-bar" aria-label="Where you are">
    <a className="path-home" href="/" onClick={onLink} aria-label="All spaces" title="All spaces"><Home size={14} /></a>
    {segments.map(segment => <span key={segment.key} className="path-item"><span className="crumb-sep">/</span><SegmentMenu segment={segment} /></span>)}
  </nav>;
}
