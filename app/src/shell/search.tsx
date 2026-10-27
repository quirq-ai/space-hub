import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderGit2, Search } from "lucide-react";
import { codeUrl, placeUrl, viewUrl, type Files, type HubMeta, type Place, type View } from "@/api";
import { useLive } from "@/hooks/use-live";
import { hashOf, navigate } from "@/router";
import { Avatar } from "@/ui/primitives";

type Result = { key: string; kind: "space" | "project" | "file"; label: string; detail: string; href: string; name?: string };

/** Spaces and projects of the hub, and the files of the project you are in. */
export function SearchPalette({ place, onClose }: { place: Place; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const hub = useLive<View<HubMeta>>(viewUrl({ space: "", project: "" }), 0);
  const files = useLive<Files>(place.project ? codeUrl(place, "files") : undefined, 0);
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);

  const results = useMemo(() => {
    const q = text.trim().toLowerCase();
    const score = (value: string) => { const at = value.toLowerCase().indexOf(q); return at < 0 ? -1 : at === 0 ? 2 : value.toLowerCase().includes("/" + q) ? 1 : 0; };
    const out: (Result & { score: number })[] = [];
    for (const entry of hub.data?.snapshot.directory.entries ?? []) {
      const s = q ? score(entry.name) : 0;
      if (s >= 0) out.push({ key: "s:" + entry.name, kind: "space", label: entry.name, detail: entry.detail ?? "Space", href: placeUrl({ space: entry.name, project: "" }), name: entry.name, score: s + 0.3 });
    }
    for (const project of hub.data?.meta.allProjects ?? []) {
      const s = q ? Math.max(score(project.fullName), score(project.description) - 1) : 0;
      if (s >= 0 || (!q && out.length < 12)) {
        const [space, name] = project.fullName.split("/");
        out.push({ key: "p:" + project.fullName, kind: "project", label: project.fullName, detail: project.description || "Project", href: placeUrl({ space, project: name }), score: s + 0.2 });
      }
    }
    if (q) for (const path of files.data?.paths ?? []) {
      const s = score(path.split("/").pop() ?? path) >= 0 ? 1.5 : score(path) >= 0 ? 0.5 : -1;
      if (s >= 0) out.push({ key: "f:" + path, kind: "file", label: path.split("/").pop() ?? path, detail: path, href: placeUrl(place, hashOf("code", { path })), score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }, [text, hub.data, files.data, place]);

  useEffect(() => setIndex(0), [text]);
  const go = (result: Result | undefined) => { if (!result) return; onClose(); navigate(result.href); };
  const groups: [string, Result["kind"]][] = [["Spaces", "space"], ["Projects", "project"], [place.project ? `Files in ${place.space}/${place.project}` : "Files", "file"]];
  let row = -1;
  return <dialog ref={dialog} className="palette" aria-label="Search" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette-box">
      <label className="palette-input"><Search size={17} /><input ref={input} value={text} onChange={event => setText(event.target.value)} placeholder={place.project ? "Search spaces, projects and files in this project" : "Search spaces and projects"} aria-label="Search"
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setIndex(value => Math.min(results.length - 1, value + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setIndex(value => Math.max(0, value - 1)); }
          if (event.key === "Enter") { event.preventDefault(); go(results[index]); }
        }} /><kbd>Esc</kbd></label>
      <div className="palette-results" role="listbox">
        {!hub.data && <p className="palette-note">Loading the hub…</p>}
        {hub.data && !results.length && <p className="palette-note">Nothing matches “{text}”.</p>}
        {groups.map(([title, kind]) => {
          const items = results.filter(result => result.kind === kind);
          if (!items.length) return null;
          return <div key={kind}><div className="palette-group">{title}</div>{items.map(result => {
            row = results.indexOf(result);
            const selected = row === index;
            return <button key={result.key} type="button" role="option" aria-selected={selected} className={`palette-row${selected ? " selected" : ""}`} onMouseEnter={() => setIndex(results.indexOf(result))} onClick={() => go(result)}>
              {result.kind === "space" ? <Avatar name={result.name!} size={22} /> : result.kind === "project" ? <FolderGit2 size={18} /> : <FileText size={18} />}
              <span className="palette-label">{result.label}</span><span className="palette-detail">{result.detail}</span>
            </button>;
          })}</div>;
        })}
      </div>
    </div>
  </dialog>;
}
