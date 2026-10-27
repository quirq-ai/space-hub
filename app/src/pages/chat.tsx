import { useEffect, useRef } from "react";
import { ArrowUp, FileText, LogIn, Square, UserRound } from "lucide-react";
import { MAX_MESSAGE_LENGTH } from "@/lib/demo-chat";
import { Markdown } from "@/components/content-view";
import { useChat } from "@/hooks/use-chat";
import { type Place } from "@/api";
import { Ago, Avatar, AvatarStack, ErrorNote } from "@/ui/primitives";

type Message = { id: string; role: string; author: string; content: string; links?: { label: string; path: string }[]; time?: string; saving?: boolean };
type Conversation = { title?: unknown; subtitle?: unknown; messages: Record<string, unknown>[] };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A conversation file and its saved log, as a thread of people and agents, with a composer for members. */
export function ChatView({ place, path, data, repliesPath, logExists, me, canWrite, signIn, onSaved, onOpen }: {
  place: Place; path: string; data: Conversation; repliesPath: string | undefined; logExists: boolean; me: string | null; canWrite: boolean; signIn: string; onSaved: () => void; onOpen: (path: string) => void;
}) {
  const blocked = !me ? "signin" : !canWrite ? "member" : undefined;
  const chat = useChat(place, path, repliesPath, blocked ? "blocked" : undefined, logExists, onSaved, me ?? undefined);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const saved: Message[] = data.messages.map((message, index) => ({
    id: "file-" + index,
    role: text(message.role),
    author: text(message.author) || (message.role === "user" ? "" : message.role === "system" ? "note" : "quirqy"),
    content: text(message.content),
    links: Array.isArray(message.links) ? (message.links as Message["links"]) : undefined,
    time: text(message.time) || undefined,
  }));
  const added: Message[] = chat.messages.map(turn => ({ ...turn, author: turn.author || (turn.role === "assistant" ? "quirqy" : "") }));
  const all = [...saved, ...added];
  const people = [...new Set(all.map(message => message.author).filter(name => name && name !== "note"))];

  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }, [all.length, chat.pending]);
  useEffect(() => {
    const box = input.current;
    if (box) { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 160) + "px"; }
  }, [chat.draft]);

  return <div className="chat">
    <div className="chat-head">
      <div><h2>{text(data.title) || path.split("/").pop()}</h2>{text(data.subtitle) && <p>{text(data.subtitle)}</p>}</div>
      {people.length > 0 && <AvatarStack names={people} />}
    </div>
    <ol className="thread">
      {all.map((message, index) => {
        const previous = all[index - 1];
        const grouped = previous && previous.author === message.author && !message.time;
        if (message.role === "system") return <li key={message.id} className="thread-note">{message.content}</li>;
        return <li key={message.id} className={`message-row${grouped ? " grouped" : ""}${message.saving ? " saving" : ""}${me && message.author === me ? " mine" : ""}`}>
          <span className="message-avatar">{!grouped && (message.author ? <Avatar name={message.author} size={32} /> : <span className="avatar-anon"><UserRound size={18} /></span>)}</span>
          <div className="message-main">
            {!grouped && <div className="message-meta"><strong>{!message.author ? "User" : message.author === me ? `${message.author} (you)` : message.author}</strong>{message.saving ? <span className="quiet">Saving…</span> : message.time && (/^\d{4}-/.test(message.time) ? <Ago iso={message.time} /> : <span className="quiet">{message.time}</span>)}</div>}
            <div className="message-text"><Markdown content={message.content} filePath={path} navigate={onOpen} /></div>
            {message.links && message.links.length > 0 && <div className="message-links">{message.links.map((link, i) => <button key={i} type="button" onClick={() => onOpen(link.path)}><FileText size={14} />{link.label || link.path}</button>)}</div>}
          </div>
        </li>;
      })}
      {chat.pending && <li className="message-row"><span className="message-avatar"><Avatar name="quirqy" size={32} /></span><div className="message-main"><div className="message-meta"><strong>quirqy</strong></div><div className="typing" aria-label="Writing a reply"><i /><i /><i /></div></div></li>}
      <div ref={end} />
    </ol>
    <div className="composer-wrap">
      {chat.sendError && <ErrorNote message={`Not saved. ${chat.sendError}`} />}
      {chat.error && chat.error !== "blocked" && <ErrorNote message={chat.error} retry={chat.refresh} />}
      {blocked === "signin" && <div className="composer-blocked"><span>Sign in to write in this conversation.</span><a className="button" href={signIn}><LogIn size={15} />Sign in</a></div>}
      {blocked === "member" && <div className="composer-blocked"><span>Only members of {place.space} can write here. You can read along.</span></div>}
      {!blocked && <>
        {!added.length && chat.suggestions.length > 0 && <div className="suggestions">{chat.suggestions.map(item => <button key={item.label} type="button" disabled={!chat.ready || chat.pending} onClick={() => chat.send(item.prompt)}>{item.label}</button>)}</div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); chat.send(); }}>
          <Avatar name={me!} size={28} />
          <textarea ref={input} rows={1} maxLength={MAX_MESSAGE_LENGTH} aria-label={`Message ${place.space}/${place.project}`} placeholder={chat.ready ? "Write a message" : "Connecting…"} value={chat.draft}
            onChange={event => chat.setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {chat.pending ? <button type="button" className="send stop" aria-label="Stop the sample reply" onClick={chat.stop}><Square size={13} fill="currentColor" /></button>
            : <button type="submit" className="send" aria-label="Send" disabled={!chat.ready || !chat.draft.trim()}><ArrowUp size={17} /></button>}
        </form>
        <p className="composer-note">Saved to {place.space}/{place.project} as {me}{chat.sampleReplies ? " · sample replies on" : ""} · Enter to send, Shift+Enter for a new line</p>
      </>}
    </div>
  </div>;
}
