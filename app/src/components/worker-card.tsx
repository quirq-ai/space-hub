import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, CircleSlash, GitPullRequest, Square, Trash2, Unplug, WifiOff, X, CornerDownRight } from "lucide-react";
import { Markdown } from "@/components/content-view";
import { useLive } from "@/hooks/use-live";
import { useTaskEvents } from "@/hooks/use-workers";
import { cardActions, cardHeadline, foldEvents, isRunning, linkLabel, newKey, send, stateNote, statusLabel, toWorkerDetail, webLinksOnly, withoutCredit, type Step, type ThreadItem, type WorkerState } from "@/lib/workers";

const tone = (status: string, state: WorkerState) => (state === "gone" || state === "disconnected" ? "quiet" : isRunning(status) ? "run" : status === "done" ? "done" : status === "failed" ? "fail" : "stop");
const STATE_ICON = { gone: CircleSlash, disconnected: Unplug, unreachable: WifiOff } as const;
// A result taller than this is folded, with Show more.
const FOLD_PX = 260;

/** The newest thing a running worker did, as one line. */
function latest(items: ThreadItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "steps") { const step = item.steps.at(-1); if (step) return step.kind === "command" ? `$ ${step.label}` : step.label; }
    if (item.type === "agent") return item.text.split("\n")[0];
    if (item.type === "note") return item.text;
  }
  return "Starting a sandbox…";
}

/**
 * A worker launched from this chat, in the message that launched it: its
 * status, whose runner it is on, what it is doing, then its result and pull
 * requests (a copy is kept once it ends). Members open its steps; only the
 * launcher stops it, follows up once it stops, or tears it down, each only
 * when the runner can.
 */
export function WorkerCard({ id, me }: { id: string; me: string | null }) {
  const [running, setRunning] = useState(true);
  const detail = useLive<unknown>(`/-/api/workers/${encodeURIComponent(id)}`, running ? 5000 : 0);
  const worker = detail.data ? toWorkerDetail(detail.data) : null;
  const task = worker?.task ?? null;
  const result = worker?.result ?? null;
  const status = task?.status ?? "";
  const live = task ? isRunning(status) && !worker?.state : !detail.error;
  if (live !== running) setRunning(live);
  const [open, setOpen] = useState(false);
  const can = worker ? cardActions(worker, me) : { steps: false, followUp: false, stop: false, tearDown: false };
  const events = useTaskEvents(task && can.steps && (live || open) ? id : "", live);
  const items = foldEvents(events.events);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  // One key per follow-up: a retry of it is not sent twice, the next one is new.
  const [key, setKey] = useState(newKey);

  if (!task || !worker) {
    const note = detail.status === 404 ? "This worker is not known here." : detail.status === 403 ? "Only members of this space can follow its workers." : detail.error;
    return <div className="worker is-quiet"><div className="worker-head"><i className="worker-dot" /><strong className="worker-title">Worker</strong><span className="worker-status">{note || "Loading…"}</span></div></div>;
  }
  // A follow-up box only stays while the worker can take one: torn down, disconnected or running again closes it.
  if (reply !== null && !can.followUp) setReply(null);
  const quiet = stateNote(worker, me);
  const StateIcon = worker.state ? STATE_ICON[worker.state] : null;

  const act = async (what: "stop" | "teardown" | "reply") => {
    if (what === "teardown" && !confirm("Tear down this worker? Its sandbox and history on the runner are deleted; the result stays here.")) return;
    setBusy(what); setError("");
    try {
      const path = `/workers/${encodeURIComponent(id)}`;
      if (what === "stop") await send("POST", `${path}/stop`, {});
      if (what === "teardown") { await send("DELETE", path); setReply(null); }
      if (what === "reply") { await send("POST", `${path}/messages`, { text: reply }, key); setReply(null); setKey(newKey()); }
      detail.refresh(); events.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy("");
    }
  };

  const hasActions = can.steps || can.stop || can.followUp || can.tearDown;
  return <div className={`worker is-${tone(status, worker.state)}`}>
    <div className="worker-head">
      <i className="worker-dot" />
      <strong className="worker-title" title={task.title}>{task.title}</strong>
      <span className="worker-status">{statusLabel(status)}</span>
    </div>
    <div className="worker-meta">
      <span>{cardHeadline(worker, me)}</span>
      {task.repo && <a href={`https://github.com/${task.repo}`} target="_blank" rel="noreferrer">{task.repo}</a>}
    </div>
    {live && <p className="worker-now">{can.steps ? latest(items) : "Working…"}</p>}
    {quiet && StateIcon && <p className={`worker-state is-${worker.state}`}><StateIcon size={13} />{quiet}</p>}
    {!live && result?.summary && <WorkerResult summary={result.summary} />}
    {!live && result?.error && <p className="worker-error">{result.error}</p>}
    {result && result.links.length > 0 && <div className="message-links">{result.links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"><GitPullRequest size={14} />{link.label || linkLabel(link.url)}</a>)}</div>}
    {open && <ol className="worker-steps">{items.map(item => <WorkerItem key={item.key} item={item} />)}{!items.length && <li className="worker-line is-note">{events.error || "Nothing yet."}</li>}</ol>}
    {reply !== null && <ReplyBox value={reply} busy={busy === "reply"} onChange={setReply} onSend={() => void act("reply")} onCancel={() => setReply(null)} />}
    {error && <p className="worker-error">{error}</p>}
    {hasActions && <div className="worker-actions">
      {can.steps && <button type="button" className="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}><ChevronDown size={13} className={open ? "flip" : undefined} />{open ? "Hide steps" : "Steps"}</button>}
      <span className="grow" />
      {can.stop && <button type="button" disabled={!!busy} onClick={() => act("stop")}><Square size={11} fill="currentColor" />{busy === "stop" ? "Stopping…" : "Stop"}</button>}
      {can.followUp && reply === null && <button type="button" onClick={() => setReply("")}><CornerDownRight size={13} />Follow up</button>}
      {can.tearDown && <button type="button" className="danger" disabled={!!busy} onClick={() => act("teardown")}><Trash2 size={12} />{busy === "teardown" ? "Tearing down…" : "Tear down"}</button>}
    </div>}
  </div>;
}

/** The worker's answer, folded to a few lines when it is long. Links into its sandbox show as text. */
function WorkerResult({ summary }: { summary: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => { if (box.current) setTall(box.current.scrollHeight > FOLD_PX + 40); }, [summary]);
  return <div className="worker-result-wrap">
    <div ref={box} className={`worker-result${tall && !more ? " is-folded" : ""}`} style={tall && !more ? { maxHeight: FOLD_PX } : undefined}>
      <Markdown content={webLinksOnly(summary)} filePath="" navigate={() => {}} />
    </div>
    {tall && <button type="button" className="worker-more" aria-expanded={more} onClick={() => setMore(value => !value)}><ChevronDown size={13} className={more ? "flip" : undefined} />{more ? "Show less" : "Show more"}</button>}
  </div>;
}

/** A follow-up for the worker: grows as you type; Enter sends, Shift+Enter is a new line, Escape cancels. */
function ReplyBox({ value, busy, onChange, onSend, onCancel }: { value: string; busy: boolean; onChange: (v: string) => void; onSend: () => void; onCancel: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } }, [value]);
  const ready = !!value.trim() && !busy;
  return <form className="worker-reply" onSubmit={event => { event.preventDefault(); if (ready) onSend(); }}>
    <textarea ref={input} rows={1} value={value} placeholder="Ask for a change, a test, or the next step" aria-label="Follow-up for this worker"
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (ready) onSend(); }
      }} />
    <div className="worker-reply-bar">
      <span className="worker-reply-hint">Enter to send · Shift+Enter for a new line · Esc to cancel</span>
      <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      <button type="submit" className="send" aria-label="Send follow-up" disabled={!ready}>{busy ? <span className="step-spin" /> : <ArrowUp size={15} />}</button>
    </div>
  </form>;
}

function WorkerItem({ item }: { item: ThreadItem }) {
  if (item.type === "steps") return <>{item.steps.map((step, i) => <StepLine key={item.key + i} step={step} />)}</>;
  if (item.type === "user") return <li className="worker-line is-task">{withoutCredit(item.text)}</li>;
  if (item.type === "agent") return <li className="worker-line is-agent"><Markdown content={webLinksOnly(item.text)} filePath="" navigate={() => {}} /></li>;
  if (item.type === "link") return <li className="worker-line"><a href={item.url} target="_blank" rel="noopener noreferrer"><GitPullRequest size={13} /> {item.label || linkLabel(item.url)}</a></li>;
  return <li className={`worker-line is-note${item.tone ? ` is-${item.tone}` : ""}`}>{item.text}</li>;
}

function StepLine({ step }: { step: Step }) {
  const icon = step.state === "run" ? <span className="step-spin" /> : step.kind === "thinking" ? <i className="step-dot" /> : step.state === "ok" ? <Check size={12} /> : <X size={12} />;
  const label = step.kind === "command" ? <code>$ {step.label}</code> : <span>{step.label}</span>;
  const more = [step.detail, step.output].filter(Boolean).join("\n\n");
  return <li className={`worker-line is-step is-${step.state}`}>
    {more ? <details><summary><span className="step-icon">{icon}</span>{label}{step.exit ? <span className="step-exit">exit {step.exit}</span> : null}</summary><pre>{more}</pre></details>
      : <span className="worker-step"><span className="step-icon">{icon}</span>{label}</span>}
  </li>;
}
