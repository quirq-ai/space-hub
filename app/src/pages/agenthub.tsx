import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Check, ChevronRight, CircleAlert, GitPullRequest, LogIn, Plus, Rocket, Square, Terminal, Trash2, UserRound, Wrench, X } from "lucide-react";
import { Markdown } from "@/components/content-view";
import { useLive } from "@/hooks/use-live";
import { useTaskEvents } from "@/hooks/use-agenthub";
import { foldEvents, withoutCredit, isRunning, linkLabel, newKey, send, statusLabel, toDetail, toTasks, type AgentHubStatus, type Step, type Task, type ThreadItem } from "@/lib/agenthub";
import { AGENTHUB_PATH, hashOf, navigate, onLink } from "@/router";
import { Ago, Avatar, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";
import { PageHeader } from "./common";

const API = "/-/api/agenthub";
const sessionUrl = (id: string) => AGENTHUB_PATH + "#" + hashOf("session", { id });

export function StatusBadge({ status }: { status: string }) {
  return <span className={`task-status is-${status}`}>{isRunning(status) && <i className="task-pulse" />}{statusLabel(status)}</span>;
}

/** Agenthub: start a worker agent session on the hub's Agents Hub, and follow the ones running. */
export function AgentHubPage({ task, me, signIn }: { task: string; me: string | null; signIn: string }) {
  const status = useLive<AgentHubStatus>(API, 0);
  const ready = status.data?.enabled && status.data.allowed;
  return <div className="page agenthub">
    {!status.data ? (status.error ? <ErrorNote message={status.error} retry={status.refresh} /> : <SkeletonRows rows={4} />)
      : !status.data.enabled ? <NotSetUp />
      : !status.data.signedIn ? <Empty icon={<Rocket size={20} />} title="Sign in to use Agenthub"><p>Agenthub starts worker agents for the builders of this hub.</p><a className="button" href={signIn}><LogIn size={15} />Sign in</a></Empty>
      : !status.data.allowed ? <Empty icon={<Rocket size={20} />} title="Agenthub isn’t open to you yet"><p>Sessions run on GitHub as the hub’s owner, so only the builders they allow can start them.{me ? <> Ask them to add <code>{me}</code> to <code>SPACEHUB_AGENTHUB_BUILDERS</code>.</> : null}</p></Empty>
      : ready && task ? <Session id={task} me={me ?? ""} />
      : <Sessions me={me ?? ""} />}
  </div>;
}

function NotSetUp() {
  return <Empty icon={<Rocket size={20} />} title="Agenthub isn’t set up on this hub">
    <p>Agenthub starts worker agents on an Agents Hub. The hub admin sets these on the server, and restarts it:</p>
    <pre className="agenthub-env">{"SPACEHUB_AGENTHUB_URL=https://<your agents hub>\nSPACEHUB_AGENTHUB_TOKEN=<Settings → Agent access>\nSPACEHUB_AGENTHUB_BUILDERS=<builders who may use it>"}</pre>
  </Empty>;
}

/** The list of sessions, newest first, with the form to start one. */
function Sessions({ me }: { me: string }) {
  const tasks = useLive<unknown>(API + "/tasks", 5000);
  const list = tasks.data ? toTasks(tasks.data) : undefined;
  const [composing, setComposing] = useState(false);
  const running = list?.filter(task => isRunning(task.status)).length ?? 0;
  return <>
    <PageHeader
      leading={<span className="agenthub-mark"><Rocket size={22} /></span>}
      title="Agenthub"
      subtitle="Start a worker agent session. It runs in its own sandbox, works on GitHub, and reports back here."
      actions={!composing && <button type="button" className="button primary" onClick={() => setComposing(true)}><Plus size={15} />New session</button>} />
    {(composing || list?.length === 0) && <NewSession me={me} onClose={list?.length ? () => setComposing(false) : undefined} />}
    {tasks.error && <ErrorNote message={tasks.error} retry={tasks.refresh} />}
    {!list ? !tasks.error && <SkeletonRows rows={4} /> : list.length > 0 && <>
      <div className="list-head"><span>{list.length} {list.length === 1 ? "session" : "sessions"}{running ? <> · <span className="strip-here"><i className="online-dot" />{running} running</span></> : null}</span></div>
      <ul className="rows">{list.map(task => <li key={task.id}><TaskRow task={task} /></li>)}</ul>
    </>}
  </>;
}

function TaskRow({ task }: { task: Task }) {
  return <a className="row" href={sessionUrl(task.id)} onClick={onLink}>
    <Bot size={18} className="row-icon" />
    <span className="row-main"><strong>{task.title}</strong><span>{task.repo || "No repository"}</span></span>
    <StatusBadge status={task.status} />
    {(task.updatedAt || task.createdAt) && <span className="row-meta"><Ago iso={task.updatedAt || task.createdAt} /></span>}
    <ChevronRight size={15} className="row-icon" />
  </a>;
}

const EXAMPLES = [
  "Summarise the open issues in quirq-ai/space-hub",
  "Fix the failing test in owner/repo and open a pull request",
  "Add a \"Local setup\" section to the README of owner/repo",
];

function NewSession({ me, onClose }: { me: string; onClose?: () => void }) {
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per start, kept across retries of the same start.
  const key = useRef(newKey());
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const made = await send("POST", "/tasks", { text, repo, title }, key.current);
      const id = toDetail(made).task?.id;
      key.current = newKey();
      if (id) navigate(sessionUrl(id));
      else { setText(""); setTitle(""); onClose?.(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The session did not start.");
    } finally {
      setBusy(false);
    }
  };
  return <form className="new-session" onSubmit={event => { event.preventDefault(); void start(); }}>
    <div className="new-session-head"><strong>New session</strong>{onClose && <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={15} /></button>}</div>
    <label className="field"><span>What should the agent do?</span>
      <textarea ref={box} rows={4} maxLength={20000} value={text} placeholder="Describe the task, like you would to a colleague" onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void start(); } }} />
    </label>
    {!text && <div className="suggestions">{EXAMPLES.map(example => <button key={example} type="button" onClick={() => { setText(example); box.current?.focus(); }}>{example}</button>)}</div>}
    <div className="field-row">
      <label className="field"><span>Repository <em>optional</em></span><input value={repo} placeholder="owner/repo" onChange={event => setRepo(event.target.value)} spellCheck={false} autoCapitalize="off" /></label>
      <label className="field"><span>Title <em>optional</em></span><input value={title} maxLength={200} placeholder="The task’s first line" onChange={event => setTitle(event.target.value)} /></label>
    </div>
    {error && <ErrorNote message={error} />}
    <div className="new-session-foot">
      <span className="composer-note">Runs on the hub’s Agents Hub as its owner · started by {me} · ⌘Enter to start</span>
      <button type="submit" className="button primary" disabled={!text.trim() || busy}><Rocket size={15} />{busy ? "Starting…" : "Start session"}</button>
    </div>
  </form>;
}

/** One session: its status, what happened, its result, and a follow-up box. */
function Session({ id, me }: { id: string; me: string }) {
  const detail = useLive<unknown>(`${API}/tasks/${encodeURIComponent(id)}`, 4000);
  const { task, result } = detail.data ? toDetail(detail.data) : { task: null, result: null };
  const running = task ? isRunning(task.status) : true;
  const events = useTaskEvents(id, running);
  const items = foldEvents(events.events);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "instant" }); }, [items.length]);

  const act = async (what: "stop" | "teardown") => {
    if (what === "teardown" && !confirm("Tear down this session? Its sandbox and history are deleted.")) return;
    setBusy(what); setError("");
    try {
      if (what === "stop") await send("POST", `/tasks/${encodeURIComponent(id)}/stop`, {});
      else { await send("DELETE", `/tasks/${encodeURIComponent(id)}`); navigate(AGENTHUB_PATH); return; }
      detail.refresh(); events.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy("");
    }
  };

  if (!detail.data && detail.status === 404) return <>
    <PageHeader crumbs={[{ label: "Agenthub", href: AGENTHUB_PATH }]} title="Session ended" />
    <Empty icon={<Bot size={20} />} title="This session has ended"><p>It was torn down, so its history is gone.</p><a className="button" href={AGENTHUB_PATH} onClick={onLink}>Back to Agenthub</a></Empty>
  </>;
  return <div className="session">
    <PageHeader
      crumbs={[{ label: "Agenthub", href: AGENTHUB_PATH }]}
      title={task?.title ?? "Session"}
      subtitle={task && <span className="session-facts"><StatusBadge status={task.status} />{task.repo && <a href={`https://github.com/${task.repo}`} target="_blank" rel="noreferrer">{task.repo}</a>}{task.createdAt && <span>Started <Ago iso={task.createdAt} /></span>}</span>}
      actions={task && (running
        ? <button type="button" className="button" disabled={!!busy} onClick={() => act("stop")}><Square size={13} fill="currentColor" />{busy === "stop" ? "Stopping…" : "Stop"}</button>
        : <button type="button" className="button danger" disabled={!!busy} onClick={() => act("teardown")}><Trash2 size={14} />{busy === "teardown" ? "Tearing down…" : "Tear down"}</button>)} />
    {(error || detail.error) && <ErrorNote message={error || detail.error} retry={error ? undefined : detail.refresh} />}
    {result && !running && (result.summary || result.links.length > 0 || result.error) && <Result result={result} status={task?.status ?? ""} />}
    <div className="chat session-chat">
      <ol className="thread">
        {!items.length && (events.error ? <li><ErrorNote message={events.error} retry={events.refresh} /></li> : <li className="thread-note">{running ? "Waiting for the agent…" : "Nothing happened in this session."}</li>)}
        {items.map(item => <Item key={item.key} item={item} me={me} />)}
        {running && items.length > 0 && <li className="message-row"><span className="message-avatar"><span className="agent-avatar"><Bot size={18} /></span></span><div className="message-main"><div className="typing" aria-label="The agent is working"><i /><i /><i /></div></div></li>}
        <div ref={end} />
      </ol>
      <FollowUp id={id} me={me} running={running} gone={!task} onSent={() => { detail.refresh(); events.refresh(); }} />
    </div>
  </div>;
}

function Result({ result, status }: { result: NonNullable<ReturnType<typeof toDetail>["result"]>; status: string }) {
  return <section className={`session-result${result.error || status === "failed" ? " is-failed" : ""}`}>
    <div className="session-result-head">{result.error ? <CircleAlert size={16} /> : <Check size={16} />}<strong>{result.error ? "It failed" : "Result"}</strong></div>
    {result.summary && <div className="message-text"><Markdown content={result.summary} filePath="" navigate={() => {}} /></div>}
    {result.error && <p className="session-error">{result.error}</p>}
    {result.links.length > 0 && <div className="session-links">{result.links.map(link => <LinkCard key={link.url} url={link.url} label={link.label} />)}</div>}
  </section>;
}

function LinkCard({ url, label }: { url: string; label: string }) {
  return <a className="link-card" href={url} target="_blank" rel="noopener noreferrer"><GitPullRequest size={16} /><span><strong>{label || linkLabel(url)}</strong><small>{label ? linkLabel(url) : url.replace(/^https:\/\//, "").split("/")[0]}</small></span></a>;
}

function Item({ item, me }: { item: ThreadItem; me: string }) {
  if (item.type === "note") return <li className={`thread-note${item.tone ? ` is-${item.tone}` : ""}`}>{item.text}</li>;
  if (item.type === "link") return <li className="message-row"><span className="message-avatar" /><div className="message-main"><LinkCard url={item.url} label={item.label} /></div></li>;
  if (item.type === "steps") return <li className="message-row"><span className="message-avatar" /><div className="message-main"><Steps steps={item.steps} open={item.open} /></div></li>;
  const mine = item.type === "user";
  return <li className={`message-row${mine ? " mine" : ""}`}>
    <span className="message-avatar">{mine ? (me ? <Avatar name={me} size={32} /> : <span className="avatar-anon"><UserRound size={18} /></span>) : <span className="agent-avatar"><Bot size={18} /></span>}</span>
    <div className="message-main">
      <div className="message-meta"><strong>{mine ? "Task" : "Agent"}</strong>{item.ts && /^\d{4}-/.test(item.ts) && <Ago iso={item.ts} />}</div>
      <div className="message-text">{mine ? <p className="session-prompt">{withoutCredit(item.text)}</p> : <Markdown content={item.text} filePath="" navigate={() => {}} />}</div>
    </div>
  </li>;
}

/** One stretch of work: open while it runs, folded once the agent moves on. */
function Steps({ steps, open }: { steps: Step[]; open: boolean }) {
  const counted = steps.filter(step => step.kind !== "thinking").length;
  return <details className="steps" open={open}>
    <summary><Wrench size={13} /><span>{open ? "Working" : "Steps"}</span>{counted > 0 && <span className="quiet">{counted} {counted === 1 ? "step" : "steps"}</span>}</summary>
    <ul>{steps.map((step, i) => <li key={i} className={`step is-${step.state}`}>
      {step.kind === "thinking" ? <span className="step-line"><span className="step-icon"><i className="step-dot" /></span><span className="step-label quiet">{step.label}</span></span>
        : <details>
          <summary className="step-line"><span className="step-icon">{step.state === "run" ? <span className="step-spin" /> : step.state === "ok" ? <Check size={13} /> : <X size={13} />}</span>
            {step.kind === "command" ? <code className="step-label"><Terminal size={12} /> {step.label}</code> : <span className="step-label">{step.label}</span>}
            {step.exit !== null && step.exit !== 0 && <span className="step-exit">exit {step.exit}</span>}</summary>
          {(step.detail || step.output) && <pre className="step-pre">{[step.detail, step.output && `→ ${step.output}`].filter(Boolean).join("\n\n")}</pre>}
        </details>}
    </li>)}</ul>
  </details>;
}

function FollowUp({ id, me, running, gone, onSent }: { id: string; me: string; running: boolean; gone: boolean; onSent: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(newKey());
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = input.current;
    if (box) { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 160) + "px"; }
  }, [draft]);
  const submit = async () => {
    if (!draft.trim() || busy || running) return;
    setBusy(true); setError("");
    try {
      await send("POST", `/tasks/${encodeURIComponent(id)}/messages`, { text: draft }, key.current);
      key.current = newKey();
      setDraft("");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not sent.");
    } finally {
      setBusy(false);
    }
  };
  if (gone) return null;
  return <div className="composer-wrap">
    {error && <ErrorNote message={`Not sent. ${error}`} />}
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Avatar name={me} size={28} />
      <textarea ref={input} rows={1} maxLength={20000} aria-label="Follow up" placeholder={running ? "The agent is working. You can follow up when it finishes." : "Follow up: ask for a change, a test, or the next step"} value={draft} disabled={running}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <button type="submit" className="send" aria-label="Send" disabled={running || busy || !draft.trim()}><ArrowUp size={17} /></button>
    </form>
    <p className="composer-note">{running ? "Stop the session to interrupt it" : "The agent picks up where it left off"} · Enter to send, Shift+Enter for a new line</p>
  </div>;
}
