import { useEffect, useRef } from "react";
import { BookOpen, ChevronRight, File, FileCode2, FileImage, FileText, Folder, FolderOpen, Lightbulb, MessageCircle, PanelsTopLeft, Shapes, SquareCheck, type LucideIcon } from "lucide-react";
import type { Entry } from "@/lib/types";
import { isConversation } from "@/lib/conversation";
import { chatLogPath } from "@/lib/chat-log";
import { FileContent } from "@/components/content-view";
import { placeUrl, rawUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, navigate, onLink } from "@/router";
import { Ago, Empty, ErrorNote, SkeletonRows, SkeletonText } from "@/ui/primitives";
import { ChatView } from "./chat";

export const SECTION_ICONS = new Map<string, LucideIcon>([
  ["chat", MessageCircle], ["activity", PanelsTopLeft], ["insights", Lightbulb], ["vision", SquareCheck],
  ["library", BookOpen], ["ideas", Lightbulb], ["goals", SquareCheck], ["files", FolderOpen], ["apps", Shapes],
]);
export const SECTION_ORDER = ["chat", "activity", "insights", "vision", "library", "ideas", "goals", "files", "apps"];

export function entryIcon(entry: Entry): LucideIcon {
  if (entry.kind === "directory") return SECTION_ICONS.get(entry.name.toLowerCase()) || Folder;
  if (/json|js|ts|py|css|html|csv|yaml|toml/.test(entry.extension)) return FileCode2;
  if (/png|jpg|jpeg|gif|webp|avif/.test(entry.extension)) return FileImage;
  return /md|txt|pdf/.test(entry.extension) ? FileText : File;
}

const filesHref = (place: Place, path: string) => placeUrl(place, hashOf("files", { path }));

/** The project as open-chat shows it: folders as places, files rendered as conversations, documents, data and feeds. */
export function FilesTab({ place, path, view, error, me, signIn, refresh }: {
  place: Place; path: string; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void;
}) {
  const snapshot = view?.snapshot;
  const meta = view?.meta;
  const first = useRef(true);
  const index = snapshot && !path ? snapshot.directory.entries.find(entry => entry.kind === "file" && entry.name === "index.json") : undefined;
  // A saved home view opens by itself the first time, unless a link says otherwise.
  useEffect(() => {
    if (!snapshot || !first.current) return;
    first.current = false;
    if (!location.hash && index) navigate(filesHref(place, index.path));
  }, [snapshot, index, place]);

  if (!snapshot || !meta) return error ? <ErrorNote message={error} retry={refresh} /> : path && /\.[a-z0-9]+$/i.test(path) ? <SkeletonText lines={10} /> : <SkeletonRows rows={7} />;
  const open = (next: string) => navigate(filesHref(place, next));
  const file = snapshot.file;
  if (file) {
    if (file.format === "json" && isConversation(file.data)) {
      const log = chatLogPath(file.path);
      return <ChatView key={file.path} place={place} path={file.path} data={file.data} repliesPath={typeof file.data.demoReplies === "string" ? file.data.demoReplies : undefined}
        logExists={!!log && snapshot.directory.entries.some(entry => entry.path === log)} me={me} canWrite={meta.canWrite} signIn={signIn} onSaved={refresh} onOpen={open} />;
    }
    return <div className="file-view"><FileContent key={file.path} file={file} revision={snapshot.revision} navigate={open} src={rawUrl(place, meta.defaultBranch, file.path)} /></div>;
  }
  const entries = snapshot.directory.entries;
  return <div className="folder">
    {index && <a className="callout" href={filesHref(place, index.path)} onClick={onLink}><MessageCircle size={18} /><span><strong>Open the saved view</strong><span>index.json</span></span><ChevronRight size={16} /></a>}
    {entries.length ? <ul className="rows">{entries.map(entry => {
      const Icon = entryIcon(entry);
      return <li key={entry.path}><a className="row" href={filesHref(place, entry.path)} onClick={onLink}>
        <Icon size={18} className="row-icon" />
        <span className="row-main"><strong>{entry.name}</strong><span>{entry.kind === "directory" ? "Folder" : `${(entry.extension || "file").toUpperCase()} · ${size(entry.size)}`}</span></span>
        <span className="row-meta"><Ago iso={entry.modifiedAt} /></span>
      </a></li>;
    })}</ul> : meta.head ? <Empty icon={<FolderOpen size={20} />} title="This folder is empty"><p>Files pushed here appear as they arrive.</p></Empty>
      : <Empty icon={<FolderOpen size={20} />} title="Nothing pushed yet"><p>Clone it and push the first files:</p><code>spacehub project clone {place.space}/{place.project}</code></Empty>}
  </div>;
}
