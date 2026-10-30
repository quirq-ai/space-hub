import { useCallback, useState, type ReactNode } from "react";
import { Bot, ChevronRight, FileText, FolderOpen, GitPullRequestArrow, Hash, Inbox, MessageCircle, Package, Paperclip, Rows3, Split, UserRound } from "lucide-react";
import { placeUrl, size, viewUrl, type Place, type ProjectMeta, type View } from "@/api";
import { FilePreview } from "@/components/file-preview";
import { Markdown } from "@/components/content-view";
import { seenChannels, useChannelsHere } from "@/hooks/use-channels";
import { useLive } from "@/hooks/use-live";
import { chatLogPath } from "@/lib/chat-log";
import { CHANNEL_FOLDERS, channelCards, field, intro, isDone, readmeSections, snippet, type ChannelCard } from "@/lib/channels";
import { isConversation } from "@/lib/conversation";
import type { Doc, Entry, WorkspaceSnapshot } from "@/lib/types";
import { hashOf, navigate, onLink } from "@/router";
import { Avatar, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";
import { Browser } from "@/ui/cards";
import { ChatView } from "./chat";
import { entryIcon } from "./files";

const filesHref = (place: Place, path: string, as?: string) => placeUrl(place, hashOf("files", { path, as }));

/** Status (Done reads as finished) and output format, as small labels. */
function ChannelLabels({ status, outputFormat }: { status?: string; outputFormat?: string }) {
  return <>
    {status && <span className={`label${isDone(status) ? " done" : " open"}`} title="Status">{status}</span>}
    {outputFormat && <span className="label quiet-label" title="Output format">{outputFormat}</span>}
  </>;
}

function ChannelIcon({ card, size: px = 34 }: { card: Pick<ChannelCard, "kind"> & { name: string }; size?: number }) {
  if (card.kind === "agent") return <Avatar name={card.name} size={px} kind="agent" />;
  if (card.kind === "person") return <Avatar name={card.name} size={px} />;
  return <span className="channel-hash" style={{ width: px, height: px }}><Hash size={Math.round(px * .5)} /></span>;
}

const GROUPS: { key: string; title: string; note: string; keep: (card: ChannelCard) => boolean }[] = [
  { key: "channel", title: "Channels", note: "Workstreams: each asks for one output.", keep: card => card.kind === "channel" && !card.done },
  { key: "agent", title: "Agents", note: "Every agent connected to the space has a channel. Talk to it there.", keep: card => card.kind === "agent" && !card.done },
  { key: "person", title: "People", note: "Personal channels, named after their GitHub login.", keep: card => card.kind === "person" && !card.done },
  { key: "done", title: "Done", note: "Finished channels keep their conversation and output.", keep: card => card.done },
];

/** The Chat folder as a list of channels, grouped, each with its newest message, like a chat app's home. */
export function ChannelList({ place, snapshot, meta, me }: { place: Place; snapshot: WorkspaceSnapshot; meta: ProjectMeta; me: string | null }) {
  const channels = useChannelsHere();
  const [seen] = useState(() => seenChannels(place));
  const here = snapshot.directory.path;
  const cards = channelCards(snapshot.directory.entries, {
    agents: meta.agents, people: [...meta.owners, ...meta.members, ...meta.collaborators],
    last: channels?.root === here ? channels.last : {}, seen, me,
  });
  const files = snapshot.directory.entries.filter(entry => entry.kind === "file" && entry.name.toLowerCase() !== "readme.md");
  const readme = snapshot.directory.docs?.find(doc => /^readme/i.test(doc.name));
  return <div className="channels">
    {files.length > 0 && <a className="callout inbox" href={filesHref(place, here, "folder")} onClick={onLink}><Inbox size={18} /><span><strong>{files.length} {files.length === 1 ? "file" : "files"} in the inbox</strong><span>Dropped in {here}/ and waiting to be sorted into a channel</span></span><ChevronRight size={16} /></a>}
    <Browser head={<>{cards.length} {cards.length === 1 ? "channel" : "channels"} in {snapshot.directory.name}</>} intro={readme ? intro(readme.content) : undefined} keepOrder
      actions={<a className="button ghost small" href={filesHref(place, here, "folder")} onClick={onLink}><Rows3 size={14} />Files</a>}
      groups={GROUPS.map(group => ({ key: group.key, title: group.title, note: group.note, cards: cards.filter(group.keep).map(card => ({
      key: card.entry.path, name: card.entry.name, search: [card.entry.detail, card.entry.outputFormat, card.entry.status, card.entry.owner, card.last?.author, card.last?.content].filter(Boolean).join(" "), href: filesHref(place, card.entry.path), done: card.done, fresh: card.unread, time: card.last?.time,
      icon: <ChannelIcon card={{ kind: card.kind, name: card.entry.name }} />,
      title: (card.kind === "channel" ? "#" : "") + card.entry.name,
      labels: <><ChannelLabels status={card.entry.status} outputFormat={card.entry.outputFormat} />{card.entry.owner && <span className="label" title="Owner"><Avatar name={card.entry.owner} size={14} />{card.entry.owner}</span>}</>,
      detail: card.entry.detail,
      latest: card.last && { who: card.last.author || (card.last.role === "assistant" ? "quirqy" : "someone"), text: snippet(card.last.content) },
      empty: "No messages on the hub yet",
    })) }))} />
  </div>;
}

/** A list in the channel's side panel: a folder's files, each opening in the preview. */
function FileList({ entries, empty, open }: { entries: Entry[] | undefined; empty: string; open: (path: string) => void }) {
  if (!entries) return <SkeletonRows rows={2} avatar={false} />;
  if (!entries.length) return <p className="quiet side-empty">{empty}</p>;
  return <ul className="side-files">{entries.map(entry => {
    const Icon = entry.kind === "directory" ? FolderOpen : entryIcon(entry);
    return <li key={entry.path}><button type="button" onClick={() => open(entry.path)}><Icon size={15} /><span>{entry.name}</span><small>{entry.kind === "directory" ? "Folder" : size(entry.size)}</small></button></li>;
  })}</ul>;
}

function SideSection({ icon, title, count, children }: { icon: ReactNode; title: string; count?: number; children: ReactNode }) {
  return <section className="side-section"><h3>{icon}{title}{count !== undefined && <span className="quiet">{count}</span>}</h3>{children}</section>;
}

/** Input text can be long (a whole brief): the first lines, with the rest on request. */
function Brief({ text, path, open }: { text: string; path: string; open: (path: string) => void }) {
  const [all, setAll] = useState(false);
  const long = text.length > 420;
  return <div className={`brief${long && !all ? " clamped" : ""}`}>
    <Markdown content={text} filePath={path} navigate={open} />
    {long && <button type="button" className="nav-more" onClick={() => setAll(value => !value)}>{all ? "Show less" : "Show the whole input"}</button>}
  </div>;
}

/**
 * A channel as a chat app shows one: its conversation and composer first,
 * and beside it what the channel is for (Input), what it makes (Output),
 * what it was given (inputs/) and the worker threads inside it
 * (sub-channels). Files open in a preview over the conversation.
 */
export function ChannelPage({ place, snapshot, conversation, readme, meta, me, signIn, refresh }: {
  place: Place; snapshot: WorkspaceSnapshot; conversation: Entry; readme: Doc; meta: ProjectMeta; me: string | null; signIn: string; refresh: () => void;
}) {
  const dir = snapshot.directory;
  const sections = readmeSections(readme.content);
  const title = /^#\s+(.+)$/m.exec(readme.content)?.[1].trim();
  const status = field(sections, "status");
  const outputFormat = field(sections, "output format");
  const owner = field(sections, "owner");
  const agent = field(sections, "agent");
  const worker = field(sections, "worker");
  const has = (name: string) => dir.entries.some(entry => entry.kind === "directory" && entry.name === name);
  const convo = useLive<View>(viewUrl(place, conversation.path));
  const inputs = useLive<View>(has("inputs") ? viewUrl(place, `${dir.path}/inputs`) : undefined, 10_000);
  const output = useLive<View>(has("output") ? viewUrl(place, `${dir.path}/output`) : undefined, 10_000);
  const listed = (live: typeof inputs, name: string) => has(name) ? live.data?.snapshot.directory.entries : [];
  const subChannels = dir.entries.filter(entry => entry.kind === "directory" && !CHANNEL_FOLDERS.has(entry.name));
  const parts = dir.path.split("/");
  const parent = parts.length > 2 ? parts.slice(0, -1).join("/") : "";

  const [previews, setPreviews] = useState<string[]>([]);
  const open = useCallback((path: string) => setPreviews(current => current.at(-1) === path ? current : [...current, path]), []);
  const page = useCallback((path: string) => { setPreviews([]); navigate(filesHref(place, path)); }, [place]);

  const file = convo.data?.snapshot.file;
  const data = file && file.format === "json" && isConversation(file.data) ? file.data : undefined;
  const log = chatLogPath(conversation.path);
  const kind = agent || meta.agents.includes(dir.name) ? "agent" : [...meta.owners, ...meta.members, ...meta.collaborators].includes(dir.name) ? "person" : "channel";
  const outputs = listed(output, "output");

  return <div className="channel-page">
    <header className="channel-head">
      <ChannelIcon card={{ kind, name: dir.name }} size={40} />
      <div className="channel-title">
        <h2>{dir.name}<ChannelLabels status={status} outputFormat={outputFormat} /></h2>
        <p>{title && title.toLowerCase() !== dir.name.toLowerCase() ? title : kind === "agent" ? `${dir.name}'s channel` : kind === "person" ? `${dir.name}'s personal channel` : "A channel"}
          {parent && <> · in <a href={filesHref(place, parent)} onClick={onLink}>#{parent.split("/").pop()}</a></>}</p>
      </div>
      <a className="button ghost small" href={filesHref(place, dir.path, "folder")} onClick={onLink} title="See this channel as files"><Rows3 size={14} />Files</a>
    </header>
    <div className="channel-body">
      <div className="channel-chat">
        {data ? <ChatView key={conversation.path} place={place} path={conversation.path} data={data} repliesPath={typeof data.demoReplies === "string" ? data.demoReplies : undefined}
          logExists={!!log && dir.entries.some(entry => entry.path === log)} me={me} canWrite={meta.canWrite} signIn={signIn} onSaved={refresh} onOpen={open}
          head={false} placeholder={`Message ${kind === "channel" ? "#" : ""}${dir.name}`} />
          : convo.error ? <ErrorNote message={convo.error} retry={convo.refresh} />
          : file ? <Empty icon={<MessageCircle size={20} />} title="No conversation here"><p>{conversation.name} is not a conversation.</p></Empty>
          : <div className="chat"><SkeletonRows rows={5} /></div>}
      </div>
      <aside className="channel-side" aria-label="About this channel">
        {sections.input && <SideSection icon={<FileText size={14} />} title="Input"><Brief text={sections.input} path={readme.path} open={open} /></SideSection>}
        <SideSection icon={<Package size={14} />} title="Output">
          {outputFormat && <p className="side-line">Format: <strong>{outputFormat}</strong></p>}
          <FileList entries={outputs} empty="Nothing yet. The output appears here once it is made." open={open} />
        </SideSection>
        {(kind === "agent" || owner || worker) && <SideSection icon={kind === "agent" ? <Bot size={14} /> : <UserRound size={14} />} title={kind === "agent" ? "Agent" : "Who"}>
          <ul className="side-facts">
            {(agent || kind === "agent") && <li><span>Agent</span><a href={"/" + encodeURIComponent(agent || dir.name)} onClick={onLink}><Avatar name={agent || dir.name} size={16} kind="agent" />{agent || dir.name}</a></li>}
            {owner && <li><span>Owner</span><a href={"/" + encodeURIComponent(owner)} onClick={onLink}><Avatar name={owner} size={16} />{owner}</a></li>}
            {worker && <li><span>Worker</span><code>{worker}</code></li>}
          </ul>
        </SideSection>}
        <SideSection icon={<Paperclip size={14} />} title="Inputs" count={listed(inputs, "inputs")?.length || undefined}>
          <FileList entries={listed(inputs, "inputs")} empty={`No files yet. Drop them in ${dir.name}/inputs/.`} open={open} />
        </SideSection>
        {(subChannels.length > 0 || parts.length === 2) && <SideSection icon={<Split size={14} />} title="Sub-channels" count={subChannels.length || undefined}>
          {subChannels.length ? <ul className="side-subs">{subChannels.map(sub => <li key={sub.path}><a href={filesHref(place, sub.path)} onClick={onLink}>
            <GitPullRequestArrow size={14} /><span className="side-sub-main"><strong>{sub.name}</strong>{sub.detail && <small>{sub.detail}</small>}</span>
            <ChannelLabels status={sub.status} />{sub.owner && <Avatar name={sub.owner} size={16} title={`Owner: ${sub.owner}`} />}
          </a></li>)}</ul> : <p className="quiet side-empty">None. A person or agent opens one when part of the work needs its own owner and output.</p>}
        </SideSection>}
        <button type="button" className="nav-more side-readme" onClick={() => open(readme.path)}><FileText size={13} />Read {readme.name}</button>
      </aside>
    </div>
    {previews.length > 0 && <FilePreview place={place} paths={previews} branch={meta.defaultBranch} onOpen={open} onBack={() => setPreviews(current => current.slice(0, -1))} onClose={() => setPreviews([])} onPage={page} />}
  </div>;
}
