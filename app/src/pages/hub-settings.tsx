import { useState } from "react";
import { Check, Globe, Lock, Mail, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useLive } from "@/hooks/use-live";
import { send } from "@/lib/workers";
import { builderAction, HUB_API, inviteState, JOIN_POLICIES, loginOf, operatorsLine, parseHubSettings, readersLine, type HubSettings } from "@/lib/hub-settings";
import { Avatar, CopyButton, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

/**
 * Settings → Hub, shown to the hub's owner only: who the recovery operators are (the owner always is one, so
 * nobody holds that power unseen), the hub's builders, each of whom the owner can suspend or restore, and who may
 * join: the policy, the GitHub logins allowed in and one-time invite codes. A suspended builder is signed out and
 * cannot write; nothing it made is removed. The web service and the module check that this is the owner
 * (cli/src/hubsettings.ts); this page only shows it. The owner also switches the hub to members-only: the database
 * then gives non-members nothing (module/src/index.ts, the visible_* views).
 *
 * Built from the app's settings pieces (Settings → Runners): runner rows and lists, the app's buttons, labels and
 * empty states; the few hub-only controls (the members-only switch, the join-policy cards) are in app.css under
 * "Settings → Hub".
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
  const setMembersOnly = async (on: boolean) => {
    if (on && !confirm("Make this hub members-only? Anyone who is not one of its builders (or their agents) will see nothing, including people who are not signed in.")) return;
    await run("-members-only", "/hub/members-only", { on });
  };
  return <section className="subhubs hub-settings" aria-label="Hub">
    <header className="subhub-heading"><div><h2><Users size={20} />Hub</h2><p className="quiet">You own this hub.</p></div></header>
    {hub.error && <ErrorNote message={hub.error} retry={hub.refresh} />}
    {hub.loading && !settings ? <SkeletonRows rows={2} /> : settings && <>
      <p className="instance-permission"><ShieldCheck size={16} />Full backups and recovery: {operatorsLine(settings)}</p>

      <div className="hub-settings-group">
        <div className="subhub-section-heading"><h3>Who can read</h3></div>
        <div className="runner-row">
          <div className="hub-row-main">
            <span className="hub-row-icon" aria-hidden="true">{settings.membersOnly ? <Lock size={16} /> : <Globe size={16} />}</span>
            <div><strong>{settings.membersOnly ? "Members only" : "Open to anyone"}</strong><div className="quiet">{readersLine(settings)}</div></div>
          </div>
          <div className="subhub-actions">
            {busy === "-members-only" && <span className="quiet" role="status">Saving…</span>}
            <button type="button" role="switch" aria-checked={settings.membersOnly} className="hub-switch" disabled={!!busy} onClick={() => void setMembersOnly(!settings.membersOnly)}>
              <span className="hub-switch-track" aria-hidden="true" />
              Members only
            </button>
          </div>
        </div>
      </div>

      <JoinSection settings={settings} busy={busy} run={run} />

      <div className="hub-settings-group">
        <div className="subhub-section-heading"><h3>Builders</h3></div>
        {settings.builders.length === 0 ? <Empty icon={<Users size={20} />} title="No builders yet" /> : <ul className="runner-list">{settings.builders.map(b => {
          const action = builderAction(settings, b);
          return <li key={b.name} className="runner-row">
            <div className="hub-row-main">
              <Avatar name={b.name} size={24} />
              <div><strong>{b.name}</strong>{b.name === settings.owner && <> <span className="label">owner</span></>}{b.suspended && <> <span className="label warn">suspended</span></>}</div>
            </div>
            {action && <div className="subhub-actions">
              <button type="button" className={`button small${action === "suspend" ? " danger" : ""}`} disabled={!!busy} onClick={() => void act(action, b.name)}>
                {busy === b.name ? (action === "suspend" ? "Suspending…" : "Restoring…") : action === "suspend" ? "Suspend" : "Restore"}
              </button>
            </div>}
          </li>;
        })}</ul>}
      </div>
    </>}
    {error && <p className="launch-note is-error" role="alert">{error}</p>}
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
    <div className="hub-settings-group">
      <div className="subhub-section-heading"><h3>Who may join</h3><p className="quiet">Builders already here stay whatever you choose. On a hub that isn't open to anyone, only builders open new repo rooms.</p></div>
      <fieldset className="hub-choices" disabled={!!busy}>
        <legend className="sr-only">Join policy</legend>
        {JOIN_POLICIES.map(p => <label key={p.value} className="hub-choice">
          <input type="radio" name="join-policy" value={p.value} checked={join.policy === p.value} onChange={() => void run("policy", "/hub/join", { policy: p.value })} />
          <span className="hub-choice-title"><strong>{p.label}</strong><Check className="hub-choice-check" size={15} aria-hidden="true" /></span>
          <span className="quiet">{p.help}</span>
        </label>)}
      </fieldset>
    </div>

    <div className="hub-settings-group">
      <div className="subhub-section-heading"><h3>GitHub accounts let in</h3></div>
      <form className="runner-form" onSubmit={event => { event.preventDefault(); void allow(); }}>
        <input value={login} onChange={event => setLogin(event.target.value)} placeholder="GitHub login, like octocat" aria-label="GitHub login" spellCheck={false} autoCapitalize="off" />
        <button type="submit" className="button primary small" disabled={!!busy || !wanted}>{busy === "allow" ? "Adding…" : "Add"}</button>
      </form>
      {join.allowlist.length === 0 ? <Empty icon={<UserPlus size={20} />} title="No accounts listed" /> : <ul className="runner-list">{join.allowlist.map(name => <li key={name} className="runner-row">
        <div className="hub-row-main"><Avatar name={name} size={24} /><strong>{name}</strong></div>
        <div className="subhub-actions"><button type="button" className="button small" disabled={!!busy} onClick={() => void run(`disallow-${name}`, "/hub/disallow", { login: name })}>{busy === `disallow-${name}` ? "Removing…" : "Remove"}</button></div>
      </li>)}</ul>}
    </div>

    <div className="hub-settings-group">
      <div className="subhub-section-heading"><h3>Invites</h3></div>
      <form className="runner-form" onSubmit={event => { event.preventDefault(); void invite(); }}>
        <select value={days} onChange={event => setDays(event.target.value)} aria-label="How long the invite lasts">
          {["1", "7", "30"].map(d => <option key={d} value={d}>{d === "1" ? "Lasts 1 day" : `Lasts ${d} days`}</option>)}
        </select>
        <button type="submit" className="button primary small" disabled={!!busy}>{busy === "invite" ? "Making…" : "New invite"}</button>
      </form>
      {made && <div className="hub-invite-made" role="status">
        <p>Send this link to the person you invite. It works once. It is shown only now: copy it before you leave.</p>
        <div className="command"><code>{made.link}</code><CopyButton text={made.link} label="Copy invite link" /></div>
        <p className="command-note">Or from the terminal: <code>spacehub auth login --invite {made.code}</code></p>
      </div>}
      {join.invites.length === 0 ? <Empty icon={<Mail size={20} />} title="No invites yet" /> : <ul className="runner-list">{join.invites.map(i => {
        const state = inviteState(i, now);
        return <li key={i.id} className="runner-row">
          <div><strong>Invite {i.id}</strong> <span className={`label${state.kind === "used" ? " done" : state.kind === "open" ? " open" : ""}`}>{state.text}</span></div>
          {!i.usedBy && <div className="subhub-actions"><button type="button" className={`button small${state.kind === "expired" ? "" : " danger"}`} disabled={!!busy} onClick={() => void run(`revoke-${i.id}`, "/hub/revoke", { id: i.id })}>{busy === `revoke-${i.id}` ? "Revoking…" : state.kind === "expired" ? "Remove" : "Revoke"}</button></div>}
        </li>;
      })}</ul>}
    </div>
  </>;
}
