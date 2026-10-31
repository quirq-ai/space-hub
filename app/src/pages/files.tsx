import { useEffect, useRef } from "react";
import { BookOpen, Boxes, ChevronRight, Code2, File, FileCode2, FileImage, FileText, FileVideo, Folder, FolderOpen, Lightbulb, MessageCircle, PanelsTopLeft, Shapes, SquareCheck, type LucideIcon } from "lucide-react";
import type { Entry } from "@/lib/types";
import { mediaOf } from "@/lib/media";
import { isConversation } from "@/lib/conversation";
import { chatLogPath } from "@/lib/chat-log";
import { FileContent } from "@/components/content-view";
import { placeUrl, rawUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, navigate, onLink } from "@/router";
import { Avatar, Empty, ErrorNote, SkeletonRows, SkeletonText } from "@/ui/primitives";
import { Browser, Glyph, type PlaceCard } from "@/ui/cards";
import { useFolderSummaries } from "@/hooks/use-folders";
import { ChatView } from "./chat";
import { ChannelList, ChannelPage } from "./channels";
import { channelConversation, intro, listsChannels } from "@/lib/channels";
import type { WorkspaceSnapshot } from "@/lib/types";

export const SECTION_ICONS = new Map<string, LucideIcon>([
  ["chat", MessageCircle], ["activity", PanelsTopLeft], ["insights", Lightbulb], ["vision", SquareCheck],
  ["library", BookOpen], ["ideas", Lightbulb], ["goals", SquareCheck], ["files", FolderOpen], ["apps", Shapes],
]);
export const SECTION_ORDER = ["chat", "activity", "insights", "vision", "library", "ideas", "goals", "files", "apps"];

export function entryIcon(entry: Entry): LucideIcon {
  if (entry.kind === "directory") return SECTION_ICONS.get(entry.name.toLowerCase()) || Folder;
  const media = mediaOf(entry.name);
  if (media) return media === "video" ? FileVideo : FileImage;
  if (/json|js|ts|py|css|html|csv|yaml|toml/.test(entry.extension)) return FileCode2;
  return /md|txt|pdf/.test(entry.extension) ? FileText : File;
}

const filesHref = (place: Place, path: string, as?: string) => placeUrl(place, hashOf("files", { path, as }));
const readmeOf = (snapshot: WorkspaceSnapshot) => snapshot.directory.docs?.find(doc => /^readme/i.test(doc.name));

/** A folder shown as a channel: a README with an Input or Output format, and a conversation. */
export function isChannel(snapshot: WorkspaceSnapshot): boolean {
  return !snapshot.file && !!channelConversation(snapshot.directory.entries, readmeOf(snapshot)?.content);
}

/** A folder's labels from its README: Status (Done reads as finished), Owner, Output format. */
function Labels({ entry }: { entry: Entry }) {
  if (!entry.status && !entry.owner && !entry.outputFormat) return null;
  const done = /^(done|closed|finished)$/i.test(entry.status ?? "");
  return <>
    {entry.status && <span className={`label${done ? " done" : " open"}`} title="Status">{entry.status}</span>}
    {entry.owner && <span className="label" title="Owner"><Avatar name={entry.owner} size={14} />{entry.owner}</span>}
    {entry.outputFormat && <span className="label quiet-label" title="Output format">{entry.outputFormat}</span>}
  </>;
}

/** The project as open-chat shows it: folders as places, files rendered as conversations, documents, data and feeds. */
export function FilesTab({ place, path, as, view, error, me, signIn, refresh }: {
  place: Place; path: string; as: string; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void;
}) {
  const snapshot = view?.snapshot;
  const meta = view?.meta;
  const first = useRef(true);
  const folders = snapshot && !snapshot.file ? snapshot.directory.entries.filter(entry => entry.kind === "directory").map(entry => entry.path) : [];
  const summaries = useFolderSummaries(place, folders, snapshot?.revision ?? "");
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
      return <>
        <ChatView key={file.path} place={place} path={file.path} data={file.data} repliesPath={typeof file.data.demoReplies === "string" ? file.data.demoReplies : undefined}
          logExists={!!log && snapshot.directory.entries.some(entry => entry.path === log)} me={me} canWrite={meta.canWrite} signIn={signIn} onSaved={refresh} onOpen={open} />
      </>;
    }
    return <div className="file-view">
      {file.path === "DEPS" && meta.deps > 0 && <a className="callout" href={placeUrl(place, hashOf("deps"))} onClick={onLink}><Boxes size={18} /><span><strong>See the {meta.deps} pinned {meta.deps === 1 ? "repository" : "repositories"}</strong><span>Each linked to its project on the hub, with whether its pin is current</span></span><ChevronRight size={16} /></a>}
      <FileContent key={file.path} file={file} revision={snapshot.revision} navigate={open} src={rawUrl(place, meta.defaultBranch, file.path)} />
    </div>;
  }
  // A channel opens on its conversation, and a folder of channels as a list of them, unless asked for files.
  const readme = readmeOf(snapshot);
  const conversation = as !== "folder" ? channelConversation(snapshot.directory.entries, readme?.content) : undefined;
  if (conversation && readme) return <><ChannelPage key={snapshot.directory.path} place={place} snapshot={snapshot} conversation={conversation} readme={readme} meta={meta} me={me} signIn={signIn} refresh={refresh} /></>;
  if (as !== "folder" && listsChannels(snapshot.directory.entries)) return <><ChannelList place={place} snapshot={snapshot} meta={meta} me={me} /></>;
  // A conversation's saved turns open with the conversation, so its log is not listed apart.
  const logs = new Set(snapshot.directory.entries.map(entry => chatLogPath(entry.path)).filter(Boolean));
  const entries = snapshot.directory.entries.filter(entry => !logs.has(entry.path));
  const dirs = entries.filter(entry => entry.kind === "directory");
  const files = entries.filter(entry => entry.kind === "file");
  const atRoot = !snapshot.directory.path;
  const isSection = (entry: Entry) => atRoot && SECTION_ICONS.has(entry.name.toLowerCase());
  const purpose = readme ? intro(readme.content) : "";
  const folderCard = (entry: Entry): PlaceCard => {
    const Icon = entryIcon(entry);
    const summary = summaries[entry.path];
    const holds = !summary ? undefined : summary.channels ? `${summary.channels} ${summary.channels === 1 ? "channel" : "channels"}` : `${summary.items} ${summary.items === 1 ? "item" : "items"}`;
    return {
      key: entry.path, name: entry.name, search: [entry.detail, entry.status, entry.owner, entry.outputFormat].filter(Boolean).join(" "), href: filesHref(place, entry.path), done: /^(done|closed|finished)$/i.test(entry.status ?? ""),
      icon: <Glyph tone={isSection(entry) ? "accent" : undefined}><Icon size={17} /></Glyph>,
      title: entry.name, labels: <>{holds && <span className="label">{holds}</span>}<Labels entry={entry} /></>,
      detail: entry.detail || undefined, time: entry.modifiedAt,
    };
  };
  const fileCard = (entry: Entry): PlaceCard => {
    const Icon = entryIcon(entry);
    return { key: entry.path, name: entry.name, search: entry.extension, href: filesHref(place, entry.path), icon: <Glyph><Icon size={16} /></Glyph>, title: entry.name, detail: `${(entry.extension || "file").toUpperCase()} · ${size(entry.size)}`, time: entry.modifiedAt };
  };
  const sections = dirs.filter(isSection).sort((a, b) => SECTION_ORDER.indexOf(a.name.toLowerCase()) - SECTION_ORDER.indexOf(b.name.toLowerCase()));
  const parts = [dirs.length && `${dirs.length} ${dirs.length === 1 ? "folder" : "folders"}`, files.length && `${files.length} ${files.length === 1 ? "file" : "files"}`].filter(Boolean).join(" and ");
  return <div className="folder">
    {as === "folder" && (channelConversation(snapshot.directory.entries, readme?.content) || listsChannels(snapshot.directory.entries)) && <a className="callout" href={filesHref(place, snapshot.directory.path)} onClick={onLink}><MessageCircle size={18} /><span><strong>Back to the {listsChannels(snapshot.directory.entries) && !channelConversation(snapshot.directory.entries, readme?.content) ? "channels" : "conversation"}</strong><span>You are looking at this folder as files</span></span><ChevronRight size={16} /></a>}
    {index && <a className="callout" href={filesHref(place, index.path)} onClick={onLink}><MessageCircle size={18} /><span><strong>Open the saved view</strong><span>index.json</span></span><ChevronRight size={16} /></a>}
    {entries.length ? <Browser head={<>{parts} in {atRoot ? place.project : snapshot.directory.name}</>} intro={purpose || undefined} keepOrder={atRoot}
      actions={<a className="button ghost small" href={placeUrl(place, hashOf("code", { path: snapshot.directory.path }))} onClick={onLink} title="Read these files in the Code tab"><Code2 size={14} />Code</a>}
      groups={[
        { key: "sections", title: "Sections", note: "The places this workspace is made of. Each one opens the way its content reads best.", cards: sections.map(folderCard) },
        { key: "folders", title: sections.length ? "Other folders" : "Folders", cards: dirs.filter(entry => !isSection(entry)).map(folderCard) },
        { key: "files", title: "Files", compact: true, cards: files.map(fileCard) },
      ]} /> : meta.head ? <Empty icon={<FolderOpen size={20} />} title="This folder is empty"><p>Files pushed here appear as they arrive.</p></Empty>
      : <Empty icon={<FolderOpen size={20} />} title="Nothing pushed yet"><p>Clone it and push the first files:</p><code>spacehub project clone {place.space}/{place.project}</code></Empty>}
  </div>;
}
