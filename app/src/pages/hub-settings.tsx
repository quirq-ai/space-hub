import { useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { useLive } from "@/hooks/use-live";
import { send } from "@/lib/workers";
import { builderAction, HUB_API, inviteState, JOIN_POLICIES, loginOf, operatorsLine, parseHubSettings, type HubSettings } from "@/lib/hub-settings";
import { ErrorNote, SkeletonRows } from "@/ui/primitives";

/**
 * Settings → Hub, shown to the hub's owner only: who the recovery operators are (the owner always is one, so
 * nobody holds that power unseen), the hub's builders, each of whom the owner can suspend or restore, and who may
 * join: the policy, the GitHub logins allowed in and one-time invite codes. A suspended builder is signed out and
 * cannot write; nothing it made is removed. The web service and the module check that this is the owner
 * (cli/src/hubsettings.ts); this page only shows it.
 */
export function HubSettingsSection() {
  const hub = useLive<unknown>(HUB_API, 0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const settings = parseHubSettings(hub.data);
  if (hub.status === 401 || hub.status === 403) return null;
  const run = async (key: string, path: string, body: unknown) => {
    setBusy(key); setError("");
    try { const out = await send("POST", path, body); hub.refresh(); return out; } catch (err) { setError(err instanceof Error ? err.message : "That did not work."); return null; } finally { setBusy(""); }
  };
  const act = async (what: "suspend" | "restore", name: string) => {
    if (what === "suspend" && !confirm(`Suspend ${name}? They are signed out and can't change anything on this hub until you restore them. Nothing they made is removed.`)) return;
    await run(name, `/hub/${what}`, { name });
  };
  return <section className="subhubs" aria-label="Hub">
    <header className="subhub-heading"><div><h2><Users size={20} />Hub</h2><p className="quiet">You own this hub.</p></div></header>
    {hub.error && <ErrorNote message={hub.error} retry={hub.refresh} />}
    {hub.loading && !settings ? <SkeletonRows rows={2} /> : settings && <>
      <p className="instance-permission"><ShieldCheck size={16} />Full backups and recovery: {operatorsLine(settings)}</p>
      <JoinSection settings={settings} busy={busy} run={run} />
      <div className="subhub-section-heading"><h3>Builders</h3></div>
      <ul className="runner-list">{settings.builders.map(b => {
        const action = builderAction(settings, b);
        return <li key={b.name} className="runner-row">
          <div><strong>{b.name}</strong>{b.name === settings.owner && <span className="quiet"> · owner</span>}{b.suspended && <span className="quiet"> · suspended</span>}</div>
          {action && <div className="subhub-actions">
            <button type="button" className={`button small${action === "suspend" ? " danger" : ""}`} disabled={!!busy} onClick={() => void act(action, b.name)}>
              {busy === b.name ? (action === "suspend" ? "Suspending…" : "Restoring…") : action === "suspend" ? "Suspend" : "Restore"}
            </button>
          </div>}
        </li>;
      })}</ul>
    </>}
    {error && <p className="launch-note is-error">{error}</p>}
  </section>;
}

type Run = (key: string, path: string, body: unknown) => Promise<unknown>;

/** Who may join: the policy, the GitHub logins let in, and invite codes (a new one is shown once, here). */
function JoinSection({ settings, busy, run }: { settings: HubSettings; busy: string; run: Run }) {
  const { join } = settings;
  const [login, setLogin] = useState("");
  const [days, setDays] = useState("7");
  const [made, setMade] = useState<{ code: string; link: string } | null>(null);
  const wanted = loginOf(login);
  const now = Date.now();
  const allow = async () => {
    if (!wanted) return;
    if (await run("allow", "/hub/allow", { login: wanted })) setLogin("");
  };
  const invite = async () => {
    const out = await run("invite", "/hub/invite", { hours: Math.round(Number(days) * 24) }) as { code?: unknown; link?: unknown } | null;
    if (out && typeof out.code === "string" && typeof out.link === "string") setMade({ code: out.code, link: out.link });
  };
  return <>
    <div className="subhub-section-heading"><h3>Who may join</h3></div>
    <fieldset className="runner-list" disabled={!!busy} aria-label="Join policy">
      {JOIN_POLICIES.map(p => <label key={p.value} className="runner-row">
        <span><input type="radio" name="join-policy" value={p.value} checked={join.policy === p.value} onChange={() => void run("policy", "/hub/join", { policy: p.value })} /> <strong>{p.label}</strong> <span className="quiet">{p.help}</span></span>
      </label>)}
    </fieldset>
    <p className="quiet">Builders already here stay whatever you choose. On a hub that isn't open to anyone, only builders open new repo rooms.</p>

    <div className="subhub-section-heading"><h3>GitHub accounts let in</h3></div>
    <form className="subhub-actions" onSubmit={event => { event.preventDefault(); void allow(); }}>
      <input value={login} onChange={event => setLogin(event.target.value)} placeholder="GitHub login, like octocat" aria-label="GitHub login" spellCheck={false} autoCapitalize="off" />
      <button type="submit" className="button small" disabled={!!busy || !wanted}>{busy === "allow" ? "Adding…" : "Add"}</button>
    </form>
    {join.allowlist.length === 0 ? <p className="quiet">No accounts listed.</p> : <ul className="runner-list">{join.allowlist.map(name => <li key={name} className="runner-row">
      <div><strong>{name}</strong></div>
      <div className="subhub-actions"><button type="button" className="button small" disabled={!!busy} onClick={() => void run(`disallow-${name}`, "/hub/disallow", { login: name })}>{busy === `disallow-${name}` ? "Removing…" : "Remove"}</button></div>
    </li>)}</ul>}

    <div className="subhub-section-heading"><h3>Invites</h3></div>
    <form className="subhub-actions" onSubmit={event => { event.preventDefault(); void invite(); }}>
      <label>Lasts <select value={days} onChange={event => setDays(event.target.value)} aria-label="How long the invite lasts">
        {["1", "7", "30"].map(d => <option key={d} value={d}>{d === "1" ? "1 day" : `${d} days`}</option>)}
      </select></label>
      <button type="submit" className="button small" disabled={!!busy}>{busy === "invite" ? "Making…" : "New invite"}</button>
    </form>
    {made && <div className="instance-permission" role="status">
      <div>
        <p>Send this link to the person you invite. It works once. It is shown only now: copy it before you leave.</p>
        <p><code>{made.link}</code></p>
        <p className="quiet">Or from the terminal: <code>spacehub auth login --invite {made.code}</code></p>
      </div>
    </div>}
    {join.invites.length > 0 && <ul className="runner-list">{join.invites.map(i => {
      const state = inviteState(i, now);
      return <li key={i.id} className="runner-row">
        <div><strong>Invite {i.id}</strong> <span className="quiet">· {state.text}</span></div>
        {!i.usedBy && <div className="subhub-actions"><button type="button" className="button small danger" disabled={!!busy} onClick={() => void run(`revoke-${i.id}`, "/hub/revoke", { id: i.id })}>{busy === `revoke-${i.id}` ? "Revoking…" : state.kind === "expired" ? "Remove" : "Revoke"}</button></div>}
      </li>;
    })}</ul>}
  </>;
}
