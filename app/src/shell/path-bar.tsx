import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Ellipsis, File, Folder, FolderGit2, Home } from "lucide-react";
import { placeUrl, viewUrl, type Place, type View } from "@/api";
import { foldedSegments } from "@/lib/path-fold";
import { hashOf, onLink } from "@/router";
import { Avatar } from "@/ui/primitives";

type Option = { key: string; label: string; href: string; kind: "space" | "project" | "folder" | "file"; spaceKind?: string };
type Segment = { key: string; label: string; href: string; kind: "space" | "project" | "folder"; current: boolean; load: () => Promise<Option[]> };

const MAX = 60;

async function listing(url: string): Promise<View | undefined> {
  try { const response = await fetch(url, { cache: "no-store" }); return response.ok ? await response.json() as View : undefined; } catch { return undefined; }
}

const spaceKind = (detail = "") => detail.startsWith("org") ? "org" : detail.startsWith("agent") ? "agent" : "personal";

/** The segments for where you are: each space, project and folder, with the places beside it one click away. */
function segmentsOf(place: Place, path: string): Segment[] {
  const segments: Segment[] = [{
    key: "space", label: place.space, href: placeUrl({ space: place.space, project: "" }), kind: "space", current: !place.project,
    load: async () => (await listing(viewUrl({ space: "", project: "" })))?.snapshot.directory.entries.map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: entry.name, project: "" }), kind: "space" as const, spaceKind: spaceKind(entry.detail) })) ?? [],
  }];
  if (!place.project) return segments;
  segments.push({
    key: "project", label: place.project, href: placeUrl(place, hashOf("files")), kind: "project", current: !path,
    load: async () => (await listing(viewUrl({ space: place.space, project: "" })))?.snapshot.directory.entries.map(entry => ({ key: entry.name, label: entry.name, href: placeUrl({ space: place.space, project: entry.name }), kind: "project" as const })) ?? [],
  });
  const parts = path.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    const parent = parts.slice(0, i).join("/");
    segments.push({
      key: "p" + i, label: part, href: placeUrl(place, hashOf("files", { path: parts.slice(0, i + 1).join("/") })), kind: "folder", current: i === parts.length - 1,
      load: async () => {
        const entries = (await listing(viewUrl(place, parent)))?.snapshot.directory.entries ?? [];
        return [...entries].filter(entry => !/\.log\.jsonl$/i.test(entry.name)).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name))
          .map(entry => ({ key: entry.path, label: entry.name, href: placeUrl(place, hashOf("files", { path: entry.path })), kind: entry.kind === "directory" ? "folder" as const : "file" as const }));
      },
    });
  });
  return segments;
}

const iconOf = (kind: Option["kind"], label: string, spaceKind?: string) => kind === "space" ? <Avatar name={label} size={18} kind={spaceKind} />
  : kind === "project" ? <FolderGit2 size={15} /> : kind === "folder" ? <Folder size={15} /> : <File size={15} />;

/** A menu on the bar: Escape or a click outside closes it, and it stays on screen. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open]);
  // After every render: a menu's options arrive after it opens, and they can widen it.
  useLayoutEffect(() => {
    if (!menu.current) return;
    menu.current.style.left = "";
    const over = menu.current.getBoundingClientRect().right - (innerWidth - 8);
    if (over > 0) menu.current.style.left = `${-over}px`;
  });
  return { open, setOpen, box, menu };
}

function SegmentMenu({ segment }: { segment: Segment }) {
  const { open, setOpen, box, menu } = useMenu();
  const [options, setOptions] = useState<Option[]>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    void segment.load().then(list => { if (live) setOptions(list); });
    return () => { live = false; };
  }, [open, segment.href]);
  return <span className="path-seg" ref={box}>
    <a href={segment.href} onClick={onLink} aria-current={segment.current ? "page" : undefined} className={segment.current ? "current" : undefined}>{segment.label}</a>
    <button type="button" className="path-more" aria-haspopup="menu" aria-expanded={open} aria-label={`Places beside ${segment.label}`} title="Jump to a place beside this one" onClick={() => setOpen(value => !value)}><ChevronDown size={13} /></button>
    {open && <div className="menu path-menu" role="menu" ref={menu}>
      {!options ? <div className="menu-title">Loading…</div> : !options.length ? <div className="menu-title">Nothing else here</div>
        : options.slice(0, MAX).map(option => <a role="menuitem" key={option.key} href={option.href} className={option.label === segment.label ? "on" : undefined} onClick={event => { setOpen(false); onLink(event); }}>
          {iconOf(option.kind, option.label, option.spaceKind)}<span>{option.label}</span>{option.label === segment.label && <Check size={14} className="menu-check" />}
        </a>)}
      {options && options.length > MAX && <div className="menu-title">and {options.length - MAX} more</div>}
    </div>}
  </span>;
}

/** The segments that did not fit, in one menu: each goes up to that place, as it does on the bar. */
function FoldMenu({ segments }: { segments: Segment[] }) {
  const { open, setOpen, box, menu } = useMenu();
  return <span className="path-seg" ref={box}>
    <button type="button" className="path-more path-fold" aria-haspopup="menu" aria-expanded={open} aria-label="Show the rest of the path" title="The rest of the path" onClick={() => setOpen(value => !value)}><Ellipsis size={14} /></button>
    {open && <div className="menu path-menu" role="menu" ref={menu}>
      {segments.map(segment => <a role="menuitem" key={segment.key} href={segment.href} onClick={event => { setOpen(false); onLink(event); }}>{iconOf(segment.kind, segment.label)}<span>{segment.label}</span></a>)}
    </div>}
  </span>;
}

/**
 * Where you are, as one line in the page header of every space and project:
 * home, then the space, the project and each folder. A segment goes up to
 * that place; its arrow opens the places beside it, so moving across never
 * needs a trip back up. What does not fit folds into a "…" menu, measured on
 * a hidden copy of the bar, so the name of where you are stays readable.
 */
export function PathBar({ place, path }: { place: Place; path: string }) {
  const segments = segmentsOf(place, path);
  const bar = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [folded, setFolded] = useState<number[]>([]);
  const trail = segments.map(segment => segment.label).join("/");
  useLayoutEffect(() => {
    const measure = () => {
      if (!bar.current || !ruler.current) return;
      // Each width counts the 2px gap before it; the ruler's last child is the "…" itself.
      const widths = [...ruler.current.children].map(item => item.getBoundingClientRect().width + 2);
      const room = bar.current.clientWidth - (bar.current.querySelector<HTMLElement>(".path-home")?.offsetWidth ?? 0);
      const next = foldedSegments(widths.slice(0, -1), room, widths[widths.length - 1]);
      setFolded(current => current.join() === next.join() ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (bar.current) observer.observe(bar.current);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [trail]);
  const hidden = folded.filter(i => i < segments.length - 1);
  return <nav className="path-bar" aria-label="Where you are" ref={bar}>
    <span className="path-ruler" aria-hidden="true" ref={ruler}>
      {segments.map(segment => <span key={segment.key} className="path-item"><ChevronRight size={14} className="crumb-sep" /><span className="path-seg"><a className={segment.current ? "current" : undefined}>{segment.label}</a><span className="path-more"><ChevronDown size={13} /></span></span></span>)}
      <span className="path-item"><ChevronRight size={14} className="crumb-sep" /><span className="path-seg"><span className="path-more path-fold"><Ellipsis size={14} /></span></span></span>
    </span>
    <a className="path-home" href="/" onClick={onLink} aria-label="All spaces" title="All spaces"><Home size={14} /></a>
    {segments.map((segment, i) => hidden.includes(i)
      ? i === hidden[0] && <span key="fold" className="path-item"><ChevronRight size={14} className="crumb-sep" /><FoldMenu segments={hidden.map(at => segments[at])} /></span>
      : <span key={segment.key} className="path-item"><ChevronRight size={14} className="crumb-sep" /><SegmentMenu segment={segment} /></span>)}
  </nav>;
}
