import { useState } from "react";
import { ArrowUp, Check, ChevronDown, GitPullRequest, X } from "lucide-react";
import { Markdown } from "@/components/content-view";
import { useLive } from "@/hooks/use-live";
import { useTaskEvents } from "@/hooks/use-workers";
import { cardActions, cardHeadline, foldEvents, isRunning, linkLabel, newKey, send, stateNote, statusLabel, toWorkerDetail, withoutCredit, type Step, type ThreadItem } from "@/lib/workers";

const tone = (status: string) => (isRunning(status) ? "run" : status === "done" ? "done" : status === "failed" ? "fail" : "stop");

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
    return <div className="worker is-quiet"><div className="worker-head"><i className="worker-dot" /><strong>Worker</strong>{note ? <span className="quiet">{note}</span> : <span className="quiet">Loading…</span>}</div></div>;
  }
  const quiet = stateNote(worker);

  const act = async (what: "stop" | "teardown" | "reply") => {
    if (what === "teardown" && !confirm("Tear down this worker? Its sandbox and history on the runner are deleted; the result stays here.")) return;
    setBusy(what); setError("");
    try {
      const path = `/workers/${encodeURIComponent(id)}`;
      if (what === "stop") await send("POST", `${path}/stop`, {});
      if (what === "teardown") await send("DELETE", path);
      if (what === "reply") { await send("POST", `${path}/messages`, { text: reply }, key); setReply(null); setKey(newKey()); }
      detail.refresh(); events.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy("");
    }
  };

  return <div className={`worker is-${tone(status)}`}>
    <div className="worker-head">
      <i className="worker-dot" />
      <strong>{task.title}</strong>
      <span className="quiet">{cardHeadline(worker, me)}</span>
      {task.repo && <a className="quiet" href={`https://github.com/${task.repo}`} target="_blank" rel="noreferrer">{task.repo}</a>}
      <span className="worker-status">{statusLabel(status)}</span>
    </div>
    {live && <p className="worker-now">{can.steps ? latest(items) : "Working…"}</p>}
    {quiet && <p className="worker-now quiet">{quiet}</p>}
    {!live && result?.summary && <div className="worker-result"><Markdown content={result.summary} filePath="" navigate={() => {}} /></div>}
    {!live && result?.error && <p className="worker-error">{result.error}</p>}
    {result && result.links.length > 0 && <div className="message-links">{result.links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"><GitPullRequest size={14} />{link.label || linkLabel(link.url)}</a>)}</div>}
    {open && <ol className="worker-steps">{items.map(item => <WorkerItem key={item.key} item={item} />)}{!items.length && <li className="quiet">{events.error || "Nothing yet."}</li>}</ol>}
    {reply !== null && <form className="worker-reply" onSubmit={event => { event.preventDefault(); if (reply.trim()) void act("reply"); }}>
      <input autoFocus value={reply} placeholder="Ask for a change, a test, or the next step" onChange={event => setReply(event.target.value)} />
      <button type="submit" className="send" aria-label="Send" disabled={!reply.trim() || !!busy}><ArrowUp size={15} /></button>
    </form>}
    {error && <p className="worker-error">{error}</p>}
    {(can.steps || can.stop || can.followUp || can.tearDown) && <div className="worker-actions">
      {can.steps && <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}><ChevronDown size={13} className={open ? "flip" : undefined} />{open ? "Hide steps" : "Steps"}</button>}
      {can.stop && <button type="button" disabled={!!busy} onClick={() => act("stop")}>{busy === "stop" ? "Stopping…" : "Stop"}</button>}
      {can.followUp && reply === null && <button type="button" onClick={() => setReply("")}>Follow up</button>}
      {can.tearDown && <button type="button" className="danger" disabled={!!busy} onClick={() => act("teardown")}>{busy === "teardown" ? "Tearing down…" : "Tear down"}</button>}
    </div>}
  </div>;
}

function WorkerItem({ item }: { item: ThreadItem }) {
  if (item.type === "steps") return <>{item.steps.map((step, i) => <StepLine key={item.key + i} step={step} />)}</>;
  if (item.type === "user") return <li className="worker-line is-task">{withoutCredit(item.text)}</li>;
  if (item.type === "agent") return <li className="worker-line is-agent"><Markdown content={item.text} filePath="" navigate={() => {}} /></li>;
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
