import { useState } from "react";
import { LogIn, MessageCircle, MessageCirclePlus } from "lucide-react";
import { placeUrl, startChat, viewUrl, type Place, type ProjectMeta, type View } from "@/api";
import { useLive } from "@/hooks/use-live";
import { chatLogPath } from "@/lib/chat-log";
import { chatPlace } from "@/lib/chat-place";
import { isConversation } from "@/lib/conversation";
import { hashOf, navigate, onLink } from "@/router";
import { Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";
import { ChatView } from "./chat";

/** A place's one chat (lib/chat-place.ts): the conversation once it is there, else a button that starts it. */
export function ChatSection({ place, kind = "", me, signIn, canStart }: { place: Place; kind?: string; me: string | null; signIn: string; canStart: boolean }) {
  const chat = chatPlace(place, kind)!;
  const live = useLive<View<ProjectMeta>>(viewUrl(chat.place, chat.path), 5000);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState("");
  const where = place.project ? `${place.space}/${place.project}` : place.space;
  const file = live.data?.snapshot.file;
  if (file && file.format === "json" && isConversation(file.data)) {
    const log = chatLogPath(file.path);
    return <ChatView key={`${chat.place.space}/${chat.place.project}/${file.path}`} place={chat.place} path={file.path} data={file.data} repliesPath={undefined}
      logExists={!!log && live.data!.snapshot.directory.entries.some(entry => entry.path === log)} me={me} canWrite={live.data!.meta.canWrite} signIn={signIn}
      onSaved={live.refresh} onOpen={path => navigate(placeUrl(chat.place, hashOf("files", { path })))} room={live.data!.meta.room} />;
  }
  if (!live.data && !live.error) return <SkeletonRows rows={4} />;
  if (live.error && live.status !== 404) return <ErrorNote message={live.error} retry={live.refresh} />;
  const start = async () => {
    setStarting(true);
    setProblem("");
    try {
      await startChat(place);
      live.refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };
  const saved = `${chat.place.space}/${chat.place.project}/${chat.path}`;
  return <Empty icon={<MessageCircle size={20} />} title={file ? `${chat.path} is not a conversation` : `No chat in ${where} yet`}>
    <p>{file ? <>The file is there but is not a chat. Open it in <a href={placeUrl(chat.place, hashOf("files", { path: chat.path }))} onClick={onLink}>{saved}</a>.</> : <>One conversation for everyone who works on {where}, saved in {saved}.</>}</p>
    {!file && (canStart
      ? <button className="button primary" type="button" onClick={() => void start()} disabled={starting}><MessageCirclePlus size={15} />{starting ? "Starting the chat" : "Start a chat"}</button>
      : !me && <a className="button" href={signIn}><LogIn size={15} />Sign in to start it</a>)}
    {problem && <p className="chat-start-error" role="alert">{problem}</p>}
  </Empty>;
}
