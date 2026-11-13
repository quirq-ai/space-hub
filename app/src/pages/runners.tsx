import { useEffect, useRef, useState } from "react";
import { Bot, Plug, Rocket } from "lucide-react";
import { useLive } from "@/hooks/use-live";
import { connectOutcome, isRunning, runnerLabel, send, statusLabel, type RunnerInfo } from "@/lib/workers";
import {
  afterCheck, CANCEL, CHECK, dialogFor, isHubOutcome, launchpadHome, POLL_MS, START, stillWatching, watches,
  type HubDialog,
} from "@/lib/agentshub";
import { Ago, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

type MyWorker = { taskId: string; runnerId: string; title: string; status: string; space: string; project: string; updatedAt: string };

/**
 * Settings → Runners: the runners this person connected (each a Worker
 * Protocol address and a token only it can use), and the workers they
 * launched on them. Workers from chats run here, on the launcher's account.
 * Connect sends the browser to the runner to approve, and back here with
 * ?runner=<outcome>; a runner without that button takes a pasted token.
 * "Connect Agents Hub" (when Launchpad is set up here) signs in with XO for a
 * moment, finds the person's Agents Hub on Launchpad, then connects it the same
 * way, with no address to paste. With no hub yet it comes back with
 * ?runner=nohub, and a dialog links Launchpad's page to create one and watches
 * for it in the background, with no second sign-in (rules: lib/agentshub.ts).
 */
export function RunnersSection() {
  const list = useLive<{ enabled: boolean; launchpad?: boolean; launchpadCreatePage?: string | null; runners: RunnerInfo[] }>("/-/api/runners", 0);
  const [hubDialog, setHubDialog] = useState<HubDialog | null>(null);
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
    const code = params.get("runner");
    if (isHubOutcome(code)) setHubDialog(dialogFor(code));
    else if (outcome) (outcome.ok ? setNote : setError)(outcome.text);
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
    {list.data?.launchpad && !runners.some(r => r.kind.startsWith("Agents Hub")) && <div className="runner-row agents-hub-row" aria-label="Your Agents Hub">
      <div><strong>Your Agents Hub</strong><div className="quiet">Finds yours on Launchpad with your XO sign-in, then you approve it on your hub.</div></div>
      <div className="subhub-actions"><a className="button primary small" href={START}>Connect Agents Hub</a></div>
    </div>}
    {hubDialog && <HubDialogCard initial={hubDialog} createPage={list.data?.launchpadCreatePage ?? null} onClose={() => setHubDialog(null)} />}
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

const COPY: Record<HubDialog, { title: string; text: string }> = {
  "waiting": { title: "No Agents Hub yet", text: "Create one on Launchpad with your OpenAI keys and a hub password. Keep this tab open: as soon as your hub shows up, it's connected here. This page watches for 10 minutes." },
  "timed-out": { title: "Still no Agents Hub", text: "This page stopped watching. Once your hub is created on Launchpad, press Connect Agents Hub (XO asks you to allow access once more)." },
  "failed": { title: "Your Agents Hub didn't start", text: "Launchpad couldn't start it. Open it on Launchpad to see what went wrong, then press Connect Agents Hub again." },
  "stopped": { title: "Your Agents Hub is stopped", text: "Start it on Launchpad, then press Connect Agents Hub again." },
  "slow": { title: "Your Agents Hub is taking a while", text: "It didn't answer within 15 minutes. Check it on Launchpad, then press Connect Agents Hub again." },
};

/**
 * After "Connect Agents Hub" with no working hub: what to do on Launchpad. With
 * no hub yet it watches for one in the background (POST check, using the pass
 * the server holds from the one XO sign-in) and moves on by itself once it
 * shows up. The limits that stop it are in lib/agentshub.ts.
 */
function HubDialogCard({ initial, createPage, onClose }: { initial: HubDialog; createPage: string | null; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<HubDialog>(initial);
  useEffect(() => { const d = box.current; if (d && !d.open) d.showModal(); return () => d?.close(); }, []);

  // Watching: a background request every POLL_MS and when the person comes back to the tab, never a page load.
  // It ends on any answer but "waiting", when time is up, or when the dialog goes away.
  useEffect(() => {
    if (!watches(kind)) return;
    const startedAt = Date.now();
    let over = false;
    let busy = false;
    let timer: number | undefined;
    const check = async () => {
      if (over || busy) return;
      if (!stillWatching(startedAt, Date.now())) { over = true; setKind("timed-out"); return; }
      busy = true;
      try {
        const res = await fetch(CHECK, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
        const step = afterCheck(await res.json().catch(() => null));
        if (over) return;
        if ("go" in step) { over = true; location.assign(step.go); return; }
        if ("dialog" in step) { over = true; setKind(step.dialog); return; }
      } catch { /* offline for a moment: ask again */ } finally { busy = false; }
      if (!over) timer = window.setTimeout(() => void check(), POLL_MS);
    };
    const back = () => {
      if (document.visibilityState !== "visible" || busy || over) return;
      window.clearTimeout(timer);
      void check();
    };
    timer = window.setTimeout(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", back);
    return () => { over = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", back); };
  }, [kind]);

  // Closing while watching lets the server drop the pass at once.
  const close = () => {
    if (watches(kind)) void fetch(CANCEL, { method: "POST", credentials: "same-origin", redirect: "manual" }).catch(() => undefined);
    onClose();
  };
  const home = launchpadHome(createPage);
  const broken = kind === "failed" || kind === "stopped" || kind === "slow";
  // The Launchpad link: the apps list for a hub that is there but broken, else the create page.
  const launchpadLink = broken
    ? home ? { href: home, label: "Open Launchpad" } : null
    : createPage ? { href: createPage, label: kind === "waiting" ? "Create on Launchpad" : "Open Launchpad" } : null;
  const copy = COPY[kind];

  return <dialog ref={box} className="notice-dialog" aria-labelledby="hub-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="notice-dialog-body">
      <span className="empty-icon"><Bot size={22} /></span>
      <h3 id="hub-dialog-title">{copy.title}</h3>
      <p>{copy.text}</p>
      {!createPage && <p className="quiet">Open Launchpad and create an app from the Agents Hub template.</p>}
      {watches(kind) && <p className="notice-dialog-status" role="status">Watching for your new Agents Hub…</p>}
      <div className="notice-dialog-actions">
        <button key="close" type="button" className="button small" onClick={close}>Close</button>
        {/* Each link keeps its own key and place, so a click never lands on a link that just changed. */}
        {launchpadLink && <a key="launchpad" className={`button small${watches(kind) || broken ? " primary" : ""}`} href={launchpadLink.href} target="_blank" rel="noopener noreferrer">{launchpadLink.label}</a>}
        {!watches(kind) && <a key="connect" className={`button small${launchpadLink && broken ? "" : " primary"}`} href={START}>Connect Agents Hub</a>}
      </div>
    </div>
  </dialog>;
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
