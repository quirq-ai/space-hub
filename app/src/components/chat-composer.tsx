import { useEffect, useRef } from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import { MAX_MESSAGE_LENGTH } from "@/lib/demo-chat";
import type { useChat } from "@/hooks/use-chat";

export function ChatComposer({ chat }: { chat: ReturnType<typeof useChat> }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 132) + "px"; }
  }, [chat.draft]);
  return <>
    {!chat.messages.length && !!chat.suggestions.length && <div className="chat-suggestions" aria-label="Sample prompts">{chat.suggestions.map(item => <button key={item.label} disabled={!chat.ready || chat.pending} onClick={() => chat.send(item.prompt)}>{item.label}</button>)}</div>}
    {chat.error && <div className="chat-config-error" role="alert">{chat.hub ? "Chat unavailable." : "Sample replies unavailable."} <button onClick={chat.refresh}>Retry</button><span>{chat.error}</span></div>}
    {chat.sendError && <div className="chat-config-error" role="alert">Not saved.<span>{chat.sendError}</span></div>}
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); chat.send(); }}>
      <textarea ref={textarea} rows={1} maxLength={MAX_MESSAGE_LENGTH} aria-label="Message quirqy" placeholder={chat.ready ? "Ask quirqy anything…" : chat.hub ? "Connecting to the hub…" : "Loading sample replies…"} value={chat.draft} onChange={event => chat.setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      {chat.pending ? <button type="button" className="chat-send stop" aria-label="Stop sample reply" onClick={chat.stop}><Square size={15} fill="currentColor" /></button> : <button type="submit" className="chat-send" aria-label="Send message" disabled={!chat.ready || !chat.draft.trim()}><ArrowUp size={20} strokeWidth={2} /></button>}
    </form>
    {chat.hub
      ? <div className="mirror-caption chat-caption"><span className="demo-dot" />{chat.sampleReplies && <>Sample replies<span>·</span></>}Saved to {chat.hub.savedTo}</div>
      : <div className="mirror-caption chat-caption"><span className="demo-dot" />Sample replies<span>·</span>Stored in this tab<button onClick={chat.reset} disabled={!chat.messages.length && !chat.draft} aria-label="Reset demo chat"><RotateCcw size={10} />Reset</button></div>}
    <span className="sr-only" role="status" aria-live="polite">{chat.pending ? "quirqy is preparing a sample reply." : chat.messages.at(-1)?.role === "assistant" ? "quirqy replied." : ""}</span>
  </>;
}
