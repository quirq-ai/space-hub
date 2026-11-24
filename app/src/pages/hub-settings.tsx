import { useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { useLive } from "@/hooks/use-live";
import { send } from "@/lib/workers";
import { builderAction, HUB_API, operatorsLine, parseHubSettings } from "@/lib/hub-settings";
import { ErrorNote, SkeletonRows } from "@/ui/primitives";

/**
 * Settings → Hub, shown to the hub's owner only: who the recovery operators are (the owner always is one, so
 * nobody holds that power unseen), and the hub's builders, each of whom the owner can suspend or restore. A
 * suspended builder is signed out and cannot write; nothing it made is removed. The web service and the module
 * check that this is the owner (cli/src/hubsettings.ts); this page only shows it.
 */
export function HubSettingsSection() {
  const hub = useLive<unknown>(HUB_API, 0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const settings = parseHubSettings(hub.data);
  if (hub.status === 401 || hub.status === 403) return null;
  const act = async (what: "suspend" | "restore", name: string) => {
    if (what === "suspend" && !confirm(`Suspend ${name}? They are signed out and can't change anything on this hub until you restore them. Nothing they made is removed.`)) return;
    setBusy(name); setError("");
    try { await send("POST", `/hub/${what}`, { name }); hub.refresh(); } catch (err) { setError(err instanceof Error ? err.message : "That did not work."); } finally { setBusy(""); }
  };
  return <section className="subhubs" aria-label="Hub">
    <header className="subhub-heading"><div><h2><Users size={20} />Hub</h2><p className="quiet">You own this hub.</p></div></header>
    {hub.error && <ErrorNote message={hub.error} retry={hub.refresh} />}
    {hub.loading && !settings ? <SkeletonRows rows={2} /> : settings && <>
      <p className="instance-permission"><ShieldCheck size={16} />Full backups and recovery: {operatorsLine(settings)}</p>
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
