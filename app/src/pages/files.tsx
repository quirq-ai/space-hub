import { useEffect, useRef, useState } from "react";
import { BookOpen, Boxes, ChevronRight, File, FileCode2, FileImage, FileText, Folder, FolderOpen, Lightbulb, MessageCircle, PanelsTopLeft, Shapes, SquareCheck, type LucideIcon } from "lucide-react";
import type { Doc, Entry } from "@/lib/types";
import { isConversation } from "@/lib/conversation";
import { chatLogPath } from "@/lib/chat-log";
import { FileContent, Markdown } from "@/components/content-view";
import { placeUrl, rawUrl, size, type Place, type ProjectMeta, type View } from "@/api";
import { hashOf, navigate, onLink } from "@/router";
import { Ago, Avatar, Empty, ErrorNote, SkeletonRows, SkeletonText } from "@/ui/primitives";
import { ChatView } from "./chat";
import { ChannelList, ChannelPage } from "./channels";
import { channelConversation, listsChannels } from "@/lib/channels";
import type { WorkspaceSnapshot } from "@/lib/types";

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

const filesHref = (place: Place, path: string, as?: string) => placeUrl(place, hashOf("files", { path, as }));
const readmeOf = (snapshot: WorkspaceSnapshot) => snapshot.directory.docs?.find(doc => /^readme/i.test(doc.name));

/** A folder shown as a channel: a README with an Input or Output format, and a conversation. */
export function isChannel(snapshot: WorkspaceSnapshot): boolean {
  return !snapshot.file && !!channelConversation(snapshot.directory.entries, readmeOf(snapshot)?.content);
}

/** Where you are inside the project: its name, then each folder, then the file. */
function FileCrumbs({ place, path }: { place: Place; path: string }) {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return null;
  return <nav className="path-crumbs file-crumbs" aria-label="Path">
    <a href={filesHref(place, "")} onClick={onLink}>{place.project}</a>
    {parts.map((part, i) => <span key={i}><span className="crumb-sep">/</span>{i === parts.length - 1 ? <strong aria-current="page">{part}</strong> : <a href={filesHref(place, parts.slice(0, i + 1).join("/"))} onClick={onLink}>{part}</a>}</span>)}
  </nav>;
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

/** The folder's README, and at the root the workspace's guides as tabs. */
function Docs({ docs, open }: { docs: Doc[]; open: (path: string) => void }) {
  const [active, setActive] = useState(0);
  const doc = docs[Math.min(active, docs.length - 1)];
  return <section className="panel readme docs" aria-label="Documents">
    <div className="panel-head">
      {docs.length > 1 ? <div className="doc-tabs" role="tablist" aria-label="Documents">{docs.map((item, i) => <button key={item.path} type="button" role="tab" aria-selected={item === doc} className={item === doc ? "on" : ""} onClick={() => setActive(i)}>{item.name}</button>)}</div>
        : <><FileText size={15} /><strong>{doc.name}</strong></>}
      <span className="toolbar-spacer" />
      <button type="button" className="button ghost small" onClick={() => open(doc.path)}>Open</button>
    </div>
    {/\.txt$/i.test(doc.name) ? <pre className="padded doc-text">{doc.content}</pre> : <Markdown content={doc.content} filePath={doc.path} navigate={open} />}
  </section>;
}

/** The project as open-chat shows it: folders as places, files rendered as conversations, documents, data and feeds. */
export function FilesTab({ place, path, as, view, error, me, signIn, refresh }: {
  place: Place; path: string; as: string; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void;
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
      return <>
        <FileCrumbs place={place} path={file.path} />
        <ChatView key={file.path} place={place} path={file.path} data={file.data} repliesPath={typeof file.data.demoReplies === "string" ? file.data.demoReplies : undefined}
          logExists={!!log && snapshot.directory.entries.some(entry => entry.path === log)} me={me} canWrite={meta.canWrite} signIn={signIn} onSaved={refresh} onOpen={open} />
      </>;
    }
    return <div className="file-view">
      <FileCrumbs place={place} path={file.path} />
      {file.path === "DEPS" && meta.deps > 0 && <a className="callout" href={placeUrl(place, hashOf("deps"))} onClick={onLink}><Boxes size={18} /><span><strong>See the {meta.deps} pinned {meta.deps === 1 ? "repository" : "repositories"}</strong><span>Each linked to its project on the hub, with whether its pin is current</span></span><ChevronRight size={16} /></a>}
      <FileContent key={file.path} file={file} revision={snapshot.revision} navigate={open} src={rawUrl(place, meta.defaultBranch, file.path)} />
    </div>;
  }
  // A channel opens on its conversation, and a folder of channels as a list of them, unless asked for files.
  const readme = readmeOf(snapshot);
  const conversation = as !== "folder" ? channelConversation(snapshot.directory.entries, readme?.content) : undefined;
  if (conversation && readme) return <><FileCrumbs place={place} path={snapshot.directory.path} /><ChannelPage key={snapshot.directory.path} place={place} snapshot={snapshot} conversation={conversation} readme={readme} meta={meta} me={me} signIn={signIn} refresh={refresh} /></>;
  if (as !== "folder" && listsChannels(snapshot.directory.entries)) return <><FileCrumbs place={place} path={snapshot.directory.path} /><ChannelList place={place} snapshot={snapshot} meta={meta} me={me} /></>;
  // A conversation's saved turns open with the conversation, so its log is not listed apart.
  const logs = new Set(snapshot.directory.entries.map(entry => chatLogPath(entry.path)).filter(Boolean));
  const entries = snapshot.directory.entries.filter(entry => !logs.has(entry.path));
  const docs = snapshot.directory.docs ?? [];
  return <div className="folder">
    <FileCrumbs place={place} path={snapshot.directory.path} />
    {as === "folder" && (channelConversation(snapshot.directory.entries, readme?.content) || listsChannels(snapshot.directory.entries)) && <a className="callout" href={filesHref(place, snapshot.directory.path)} onClick={onLink}><MessageCircle size={18} /><span><strong>Back to the {listsChannels(snapshot.directory.entries) && !channelConversation(snapshot.directory.entries, readme?.content) ? "channels" : "conversation"}</strong><span>You are looking at this folder as files</span></span><ChevronRight size={16} /></a>}
    {index && <a className="callout" href={filesHref(place, index.path)} onClick={onLink}><MessageCircle size={18} /><span><strong>Open the saved view</strong><span>index.json</span></span><ChevronRight size={16} /></a>}
    {entries.length ? <ul className="rows">{entries.map(entry => {
      const Icon = entryIcon(entry);
      return <li key={entry.path}><a className="row" href={filesHref(place, entry.path)} onClick={onLink}>
        <Icon size={18} className="row-icon" />
        <span className="row-main"><div className="row-title"><strong>{entry.name}</strong><Labels entry={entry} /></div><span>{entry.kind === "directory" ? entry.detail || "Folder" : `${(entry.extension || "file").toUpperCase()} · ${size(entry.size)}`}</span></span>
        <span className="row-meta"><Ago iso={entry.modifiedAt} /></span>
      </a></li>;
    })}</ul> : meta.head ? <Empty icon={<FolderOpen size={20} />} title="This folder is empty"><p>Files pushed here appear as they arrive.</p></Empty>
      : <Empty icon={<FolderOpen size={20} />} title="Nothing pushed yet"><p>Clone it and push the first files:</p><code>spacehub project clone {place.space}/{place.project}</code></Empty>}
    {docs.length > 0 && <Docs key={snapshot.directory.path} docs={docs} open={open} />}
  </div>;
}
