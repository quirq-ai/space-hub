import { useEffect, useState } from "react";
import { Bot, Plug, Rocket } from "lucide-react";
import { useLive } from "@/hooks/use-live";
import { connectOutcome, isRunning, runnerLabel, send, statusLabel, type RunnerInfo } from "@/lib/workers";
import { Ago, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

type MyWorker = { taskId: string; runnerId: string; title: string; status: string; space: string; project: string; updatedAt: string };

/**
 * Settings → Runners: the runners this person connected (each a Worker
 * Protocol address and a token only it can use), and the workers they
 * launched on them. Workers from chats run here, on the launcher's account.
 * Connect sends the browser to the runner to approve, and back here with
 * ?runner=<outcome>; a runner without that button takes a pasted token.
 */
export function RunnersSection() {
  const list = useLive<{ enabled: boolean; runners: RunnerInfo[] }>("/-/api/runners", 0);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [withToken, setWithToken] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const run = async (what: string, fn: () => Promise<unknown>, done = "") => {
    setBusy(what); setError(""); setNote("");
    try { await fn(); setNote(done); list.refresh(); } catch (err) { setError(err instanceof Error ? err.message : "That did not work."); } finally { setBusy(""); }
  };
  // Back from a runner's consent page: say how it went, once, and take the outcome out of the address.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcome = connectOutcome(params.get("runner"));
    if (!params.has("runner")) return;
    if (outcome) (outcome.ok ? setNote : setError)(outcome.text);
    params.delete("runner");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }, []);
  // Connect: to the runner's consent page. A runner that only takes tokens opens the token field instead.
  const connect = async () => {
    setBusy("connect"); setError(""); setNote("");
    try {
      const { redirect } = await send("POST", "/runners/connect", { url: url.trim() }) as { redirect: string };
      location.assign(redirect);
    } catch (err) {
      const message = err instanceof Error ? err.message : "That did not work.";
      setError(message);
      if (/paste/i.test(message)) setWithToken(true);
      setBusy("");
    }
  };
  const paste = () => run("connect", async () => { await send("POST", "/runners", { url: url.trim(), token: token.trim() }); setUrl(""); setToken(""); setWithToken(false); }, "Connected.");
  if (list.status === 401) return null;
  if (list.data && !list.data.enabled) return <section className="subhubs" aria-label="Runners"><header className="subhub-heading"><div><h2><Plug size={20} />Runners</h2><p className="quiet">Connecting runners is not set up on this hub.</p></div></header></section>;
  const runners = list.data?.runners ?? [];
  return <section className="subhubs" aria-label="Runners">
    <header className="subhub-heading"><div><h2><Plug size={20} />Runners</h2><p className="quiet">Where the workers you launch from chats run, on your own account.</p></div></header>
    {list.error && list.status !== 401 && <ErrorNote message={list.error} retry={list.refresh} />}
    {list.loading && !list.data ? <SkeletonRows rows={1} /> : runners.length === 0
      ? <Empty icon={<Bot size={22} />} title="No runner connected"><p>Connect a runner to launch workers from chats: enter its address, press Connect and approve on the runner. A runner without that button takes a token instead (Agents Hub: Settings → Agent access → Only tasks it starts).</p></Empty>
      : <ul className="runner-list">{runners.map(r => <li key={r.id} className="runner-row">
        <div><strong>{runnerLabel(r.name, r.kind)}</strong>{r.isDefault && <span className="quiet"> · default</span>}<div className="quiet">{r.url} · checked <Ago iso={r.checkedAt} /></div></div>
        <div className="subhub-actions">
          <button type="button" className="button small" disabled={!!busy} onClick={() => void run(`test:${r.id}`, () => send("POST", `/runners/${r.id}/test`, {}), `${r.name} answered.`)}>{busy === `test:${r.id}` ? "Testing…" : "Test"}</button>
          {!r.isDefault && <button type="button" className="button small" disabled={!!busy} onClick={() => void run(`default:${r.id}`, () => send("PATCH", `/runners/${r.id}`, { default: true }))}>Make default</button>}
          <button type="button" className="button small danger" disabled={!!busy} onClick={() => { if (confirm(`Disconnect ${r.name}? Its workers keep their results here; connect it again to steer them.`)) void run(`delete:${r.id}`, () => send("DELETE", `/runners/${r.id}`)); }}>Disconnect</button>
        </div>
      </li>)}</ul>}
    <form className="subhub-form runner-form" onSubmit={event => { event.preventDefault(); void (withToken ? paste() : connect()); }}>
      <input aria-label="Runner address" placeholder="https://your-hub.example" value={url} spellCheck={false} autoCapitalize="off" onChange={event => setUrl(event.target.value)} />
      {withToken && <input aria-label="Runner token" type="password" placeholder="Token" value={token} autoComplete="off" onChange={event => setToken(event.target.value)} />}
      <button type="submit" className="button primary small" disabled={!url.trim() || (withToken && !token.trim()) || !!busy}>{busy === "connect" ? "Connecting…" : "Connect"}</button>
    </form>
    <button type="button" className="runner-mode" onClick={() => { setWithToken(value => !value); setError(""); }}>{withToken ? "Use the Connect button instead" : "Have a token? Paste it instead"}</button>
    {error && <p className="launch-note is-error">{error}</p>}
    {note && <p className="launch-note">{note}</p>}
    <YourWorkers />
  </section>;
}

function YourWorkers() {
  const mine = useLive<{ workers: MyWorker[] }>("/-/api/workers?mine=1", 0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const workers = [...(mine.data?.workers ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!workers.length) return null;
  const tearDown = async (w: MyWorker) => {
    if (!confirm(`Tear down "${w.title}"? Its sandbox and history on the runner are deleted; the result stays in the chat.`)) return;
    setBusy(w.taskId); setError("");
    try { await send("DELETE", `/workers/${encodeURIComponent(w.taskId)}`); mine.refresh(); } catch (err) { setError(err instanceof Error ? err.message : "That did not work."); } finally { setBusy(""); }
  };
  return <section className="instance-remote-catalog" aria-label="Your workers">
    <div className="subhub-section-heading"><h3><Rocket size={16} /> Your workers</h3></div>
    <ul className="runner-list">{workers.map(w => {
      const idle = !isRunning(w.status) && w.status !== "gone";
      return <li key={w.taskId} className="runner-row">
        <div><strong>{w.title}</strong> <span className="quiet">{w.space}/{w.project} · {statusLabel(w.status)}</span>
          {idle && <div className="quiet">Done with it? Tear down to free the runner's resources.</div>}</div>
        {idle && <div className="subhub-actions"><button type="button" className="button small danger" disabled={!!busy} onClick={() => void tearDown(w)}>{busy === w.taskId ? "Tearing down…" : "Tear down"}</button></div>}
      </li>;
    })}</ul>
    {error && <p className="launch-note is-error">{error}</p>}
  </section>;
}
