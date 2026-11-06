import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, FileText, Github, MessagesSquare, UserRound } from "lucide-react";
import { placeUrl, viewUrl, type Place, type ProjectMeta, type View } from "@/api";
import { Markdown } from "@/components/content-view";
import { useLive } from "@/hooks/use-live";
import { parseChatLog } from "@/lib/chat-log";
import { explainReply, repoOfGithubUrl, ROOM_CHAT_FOLDER, ROOM_CHAT_LOG, STATE_TEXT } from "@/lib/rooms";
import { hashOf, navigate, onLink } from "@/router";
import { Avatar } from "@/ui/primitives";

/** One URL sent, and what came of it. */
type Turn = { id: string; url: string; project?: string; error?: string };

const KEEP = 20;
const storageKey = (space: string) => `spacehub-explain-chat:${space}`;

// The rooms a viewer opened here stay in their browser; the rooms themselves are public.
function loadTurns(space: string): Turn[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(space)) || "[]");
    return Array.isArray(saved) ? saved.filter(turn => typeof turn?.id === "string" && typeof turn.project === "string" && repoOfGithubUrl(turn.url)).slice(-KEEP) : [];
  } catch {
    return [];
  }
}

const sameRepo = (a: string, b: string) => repoOfGithubUrl(a)?.toLowerCase() === repoOfGithubUrl(b)?.toLowerCase();

/** The explain org's chat: it takes only a GitHub repository URL, and replies with the repository's room and, once an agent has written it, the explanation. */
export function ExplainChat({ space, me }: { space: string; me: string | null }) {
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(space));
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const wanted = repoOfGithubUrl(draft);
  const invalid = !!draft.trim() && !wanted;

  useEffect(() => {
    try { localStorage.setItem(storageKey(space), JSON.stringify(turns.filter(turn => turn.project).slice(-KEEP))); } catch { /* Keep chatting without storage. */ }
  }, [space, turns]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }, [turns.length]);

  const patch = (id: string, change: Partial<Turn>) => setTurns(current => current.map(turn => turn.id === id ? { ...turn, ...change } : turn));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!wanted) return;
    const url = draft.trim();
    const id = crypto.randomUUID();
    setDraft("");
    // The same repository again moves to the end instead of showing twice.
    setTurns(current => [...current.filter(turn => !sameRepo(turn.url, url)), { id, url }]);
    try {
      const response = await fetch("/-/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const body = await response.json().catch(() => ({})) as { project?: string; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? "The room did not open. Try again in a minute.");
      patch(id, { project: body.project });
    } catch (error) {
      patch(id, { error: error instanceof Error ? error.message : "The room did not open. Try again in a minute." });
    }
  };

  return <div className="chat">
    <div className="chat-head"><div>
      <h2>Explain any GitHub repository</h2>
      <p>Paste a repository's URL. The hub opens its room, and an agent connected to {space} writes the explanation.</p>
    </div></div>
    <ol className="thread">
      {turns.map(turn => <Fragment key={turn.id}>
        <li className="message-row mine">
          <span className="message-avatar">{me ? <Avatar name={me} size={32} /> : <span className="avatar-anon"><UserRound size={18} /></span>}</span>
          <div className="message-main">
            <div className="message-meta"><strong>{me ? `${me} (you)` : "You"}</strong></div>
            <div className="message-text"><a href={`https://github.com/${repoOfGithubUrl(turn.url)}`} target="_blank" rel="noreferrer">{turn.url}</a></div>
          </div>
        </li>
        {turn.project ? <RoomReply place={{ space, project: turn.project }} /> : <HubReply space={space}>{turn.error ?? <span className="quiet">Opening the room…</span>}</HubReply>}
      </Fragment>)}
      <div ref={end} />
    </ol>
    <div className="composer-wrap">
      <form className={`composer${invalid ? " invalid" : ""}`} onSubmit={event => void submit(event)}>
        {me ? <Avatar name={me} size={28} /> : <span className="avatar-anon"><UserRound size={16} /></span>}
        <input type="text" inputMode="url" value={draft} maxLength={300} placeholder="https://github.com/owner/repo" aria-label="GitHub repository URL" aria-invalid={invalid} aria-describedby="explain-hint"
          spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="send" aria-label="Explain this repository" disabled={!wanted}><ArrowUp size={17} /></button>
      </form>
      {invalid
        ? <p className="composer-note problem" id="explain-hint" role="alert">Only a GitHub repository URL works here, like https://github.com/owner/repo.</p>
        : <p className="composer-note" id="explain-hint">Only a GitHub repository URL works here. Rooms are public; this list stays in your browser.</p>}
    </div>
  </div>;
}

function HubReply({ space, children }: { space: string; children: React.ReactNode }) {
  return <li className="message-row">
    <span className="message-avatar"><Avatar name={space} size={32} /></span>
    <div className="message-main">
      <div className="message-meta"><strong>{space}</strong></div>
      <div className="message-text">{children}</div>
    </div>
  </li>;
}

/** A room's reply, kept live until its explanation is in. */
function RoomReply({ place }: { place: Place }) {
  const [done, setDone] = useState(false);
  const live = useLive<View<ProjectMeta>>(viewUrl(place, ROOM_CHAT_LOG), done ? 0 : 5000);
  const room = live.data?.meta.room;
  const reply = explainReply(room, parseChatLog(live.data?.snapshot.file?.content ?? ""));
  const answered = !!reply.answer;
  useEffect(() => { if (answered) setDone(true); }, [answered]);
  const repo = room?.repo ?? place.project;
  const inRoom = (path: string) => placeUrl(place, hashOf("files", { path }));
  const links = <div className="message-links">
    {reply.answer?.links?.map(link => /^https:\/\//.test(link.path)
      ? <a key={link.path} href={link.path} target="_blank" rel="noreferrer"><Github size={14} />{link.label || link.path}</a>
      : <a key={link.path} href={inRoom(link.path)} onClick={onLink}><FileText size={14} />{link.label || link.path}</a>)}
    <a href={inRoom(ROOM_CHAT_FOLDER)} onClick={onLink}><MessagesSquare size={14} />Open the room</a>
    {!answered && room && <a href={room.github} target="_blank" rel="noreferrer"><Github size={14} />{repo}</a>}
  </div>;
  if (reply.answer) {
    return <li className="message-row">
      <span className="message-avatar"><Avatar name={reply.agent} size={32} kind="agent" /></span>
      <div className="message-main">
        <div className="message-meta"><strong>{reply.agent}</strong></div>
        <div className="message-text"><Markdown content={reply.answer.content} filePath={ROOM_CHAT_LOG} navigate={path => navigate(inRoom(path))} /></div>
        {links}
      </div>
    </li>;
  }
  return <HubReply space={place.space}>
    {live.error && !live.data ? live.error : !room ? <span className="quiet">Opening the room…</span> : <>
      <p>The room for <strong>{repo}</strong> is open. The explanation appears here once an agent writes it.</p>
      <div className="message-state"><span className="label open">{room.agents.length ? STATE_TEXT[reply.state](reply.agent) : "No agents connected yet"}</span></div>
    </>}
    {links}
  </HubReply>;
}
