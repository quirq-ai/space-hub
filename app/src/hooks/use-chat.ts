import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_STORAGE_PREFIX, MAX_MESSAGE_LENGTH, parseDemoReplies, sampleReply } from "@/lib/demo-chat";
import { chatLogPath, parseChatLog, type ChatTurn } from "@/lib/chat-log";
import { viewUrl, type Place, type View } from "@/api";
import { useLive } from "./use-live";

/**
 * A conversation's new turns live in `<conversation>.log.jsonl` beside it and
 * are saved to the hub as the signed-in builder. `blocked` says why saving
 * cannot work (signed out, not a member). Drafts stay in this browser tab.
 */
export function useChat(place: Place, conversationPath: string | undefined, repliesPath: string | undefined, blocked: string | undefined, logExists: boolean, onSaved: () => void, me?: string) {
  const storageKey = DEMO_STORAGE_PREFIX + "hub:" + place.space + "/" + place.project + ":" + conversationPath;
  const replies = useLive<View>(repliesPath ? viewUrl(place, repliesPath) : undefined);
  const config = parseDemoReplies(replies.data?.snapshot.file?.data);
  const configError = repliesPath ? replies.error || (replies.data && !config ? "The sample reply file is not valid. Check its demo-replies structure." : "") : "";
  // Read the log only once the folder lists it, so a new conversation polls nothing that is missing.
  const log = useLive<View>(conversationPath && logExists ? viewUrl(place, chatLogPath(conversationPath)) : undefined);
  const logContent = log.data?.snapshot.file?.content;
  const logTurns = useMemo(() => parseChatLog(logContent ?? ""), [logContent]);
  const logError = log.error && log.status !== 404 ? log.error : "";
  const [outbox, setOutbox] = useState<ChatTurn[]>([]);
  const [sendError, setSendError] = useState("");
  const [draftState, setDraftState] = useState<{ path: string | undefined; draft: string }>({ path: undefined, draft: "" });
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sending = useRef(false);
  const stop = useCallback(() => { clearTimeout(timer.current); sending.current = false; setPending(false); }, []);
  const refreshLog = log.refresh;
  const refreshReplies = replies.refresh;
  const refresh = useCallback(() => { refreshReplies(); refreshLog(); }, [refreshReplies, refreshLog]);

  useEffect(() => {
    stop();
    setOutbox([]);
    setSendError("");
    if (conversationPath === undefined) return;
    let draft = "";
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null"); if (typeof saved?.draft === "string") draft = saved.draft.slice(0, MAX_MESSAGE_LENGTH); } catch { /* Storage may be blocked. */ }
    setDraftState({ path: conversationPath, draft });
    return () => { clearTimeout(timer.current); sending.current = false; };
  }, [conversationPath, stop, storageKey]);

  useEffect(() => {
    if (conversationPath === undefined || draftState.path !== conversationPath) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, messages: [], draft: draftState.draft })); } catch { /* Keep chatting without storage. */ }
  }, [draftState, conversationPath, storageKey]);

  useEffect(() => {
    if (!outbox.length) return;
    const saved = new Set(logTurns.map(turn => turn.id));
    if (outbox.some(turn => saved.has(turn.id))) setOutbox(current => current.filter(turn => !saved.has(turn.id)));
  }, [logTurns, outbox]);

  const sessionReady = conversationPath !== undefined && draftState.path === conversationPath;
  const error = configError || logError || (blocked ?? "");
  const ready = sessionReady && !error && (!logExists || !!log.data || log.status === 404);
  // Turns not yet seen in the log are still being saved.
  const messages: (ChatTurn & { saving?: boolean })[] = sessionReady
    ? [...logTurns, ...outbox.filter(turn => !logTurns.some(saved => saved.id === turn.id)).map(turn => ({ ...turn, saving: true }))]
    : [];
  const draft = sessionReady ? draftState.draft : "";
  function setDraft(value: string) { if (sessionReady) setDraftState(current => ({ ...current, draft: value.slice(0, MAX_MESSAGE_LENGTH) })); }

  async function save(turn: ChatTurn): Promise<boolean> {
    setOutbox(current => [...current, turn]);
    try {
      const response = await fetch("/-/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ space: place.space, project: place.project, conversation: conversationPath, turns: [turn] }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The message was not saved.");
      setSendError("");
      refreshLog();
      onSaved();
      return true;
    } catch (cause) {
      setOutbox(current => current.filter(item => item.id !== turn.id));
      setSendError(cause instanceof Error ? cause.message : "The message was not saved.");
      return false;
    }
  }

  async function send(prompt = draft) {
    const text = prompt.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!ready || !text || sending.current) return;
    const path = conversationPath;
    sending.current = true;
    setPending(!!config);
    setDraftState(current => ({ ...current, draft: "" }));
    if (!(await save({ id: crypto.randomUUID(), role: "user", content: text, author: me }))) {
      setDraftState(current => current.path === path ? { ...current, draft: current.draft || text } : current);
      stop();
      return;
    }
    // Without sample replies, whoever answers in the space (a person or an agent) appends the reply.
    if (!config) { sending.current = false; return; }
    const response = sampleReply(text, config);
    timer.current = setTimeout(() => {
      void save({ id: crypto.randomUUID(), role: "assistant", content: response.content.slice(0, MAX_MESSAGE_LENGTH), links: response.links, author: "quirqy" }).finally(() => { sending.current = false; setPending(false); });
    }, 650);
  }
  return { ready, messages, draft, setDraft, send: (prompt?: string) => void send(prompt), stop, reset: () => {}, pending, error, sendError, refresh, suggestions: config?.suggestions || [], hub: { savedTo: `${place.space}/${place.project}` }, sampleReplies: !!config };
}
