import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Archive, ArrowDownToLine, Check, Database, FolderOpen, HardDrive, RefreshCw, ServerCog, ShieldCheck, X } from "lucide-react";
import { size } from "@/api";
import { useInstanceRecovery } from "@/hooks/use-instance-recovery";
import { instanceBackupCommand, instancePost, instanceRestoreBody, instanceRestoreCommand, instanceSnapshotsCommand, instanceVerifyCommand, type CommandShell, type InstanceCoverage, type InstanceRecoveryStatus, type InstanceRestore, type InstanceSnapshot, type InstanceVerification } from "@/lib/instance-recovery";
import { Ago, CommandTabs, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";
import { PageHeader } from "./common";

type Section = "overview" | "backups" | "restore";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The full-instance recovery request could not be completed.";
function commandOf(build: () => string) { try { return build(); } catch { return ""; } }

/** Instance recovery is global. Space membership and node project catalogs do not grant recovery access. */
export function InstanceRecoveryPage({ onConnectionState }: { onConnectionState?: (state: "live" | "offline" | "loading") => void }) {
  const status = useInstanceRecovery<InstanceRecoveryStatus>("/status");
  const catalog = useInstanceRecovery<{ snapshots: InstanceSnapshot[] }>("/snapshots");
  const connection = status.error ? "offline" : status.loading && !status.data ? "loading" : "live";
  useEffect(() => { onConnectionState?.(connection); }, [connection, onConnectionState]);
  const [section, setSection] = useState<Section>("overview");
  const [backupFlow, setBackupFlow] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [verified, setVerified] = useState<Record<string, InstanceVerification>>({});
  const [restored, setRestored] = useState<InstanceRestore>();
  const snapshots = [...(catalog.data?.snapshots ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const latest = snapshots[0];
  const selected = snapshots.find(snapshot => snapshot.id === selectedId) ?? latest;
  const error = status.error || catalog.error || status.data?.error || "";
  const canManage = status.data?.canManage === true && !status.error;
  const available = status.data?.available === true && !status.error;
  const storage = status.data?.cli.storage ?? "";
  const source = status.data?.source || latest?.source;
  const refresh = () => { status.refresh(); catalog.refresh(); };
  const chooseRestore = (snapshot: InstanceSnapshot) => { if (busy) return; setSelectedId(snapshot.id); setSection("restore"); setDirectory(""); setRestored(undefined); setActionError(""); };
  const verify = async (snapshot: InstanceSnapshot) => {
    if (!canManage || !available) return;
    setBusy(snapshot.id); setActionError("");
    setVerified(previous => { const next = { ...previous }; delete next[snapshot.id]; return next; });
    try { const result = await instancePost<InstanceVerification>(`/snapshots/${snapshot.id}/verify`); setVerified(previous => ({ ...previous, [snapshot.id]: result })); }
    catch (caught) { setActionError(messageOf(caught)); } finally { setBusy(""); }
  };
  const restore = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !canManage || !available) return;
    setSelectedId(selected.id);
    setBusy("restore"); setActionError(""); setRestored(undefined);
    try { setRestored(await instancePost<InstanceRestore>("/restore", instanceRestoreBody(selected.id, directory))); }
    catch (caught) { setActionError(messageOf(caught)); } finally { setBusy(""); }
  };
  const empty = <Empty icon={<Archive size={23} />} title="No full-instance backup yet"><p>Back up this entire Spacehub instance from its Docker host to a dedicated local vault.</p>{canManage && <button className="button" type="button" onClick={() => setBackupFlow(true)}>Back up instance</button>}</Empty>;
  return <div className="page subhubs instance-recovery">
    <PageHeader crumbs={[{ label: "Home", href: "/" }]} leading={<span className="instance-mark"><Archive size={24} /></span>} title="Sub-hubs" subtitle="Backup and restore this entire Spacehub instance"
      actions={<><button className="button" type="button" onClick={refresh}><RefreshCw size={14} />Refresh</button>{canManage && <button className="button primary" type="button" onClick={() => setBackupFlow(true)}><Archive size={15} />Back up instance</button>}</>}>
      <div className="meta-strip"><span className="label">Full instance</span>{source && <span><ServerCog size={14} />{source}</span>}<span className="quiet">Managed by the hub operator</span></div>
    </PageHeader>
    <nav className="subhub-sections" aria-label="Full-instance recovery sections">{([{ key: "overview", label: "Overview", Icon: HardDrive }, { key: "backups", label: "Backups", Icon: Archive }, { key: "restore", label: "Restore", Icon: ArrowDownToLine }] as const).map(({ key, label, Icon }) => <button key={key} type="button" className={section === key ? "on" : ""} aria-current={section === key ? "page" : undefined} onClick={() => { setSection(key); setActionError(""); }}><Icon size={15} />{label}</button>)}</nav>
    {error && <ErrorNote message={error} retry={refresh} />}
    {actionError && <ErrorNote message={actionError} />}
    {!status.loading && status.data && !canManage && <p className="instance-permission"><ShieldCheck size={16} />Backup verification and restore require full-hub operator permission.</p>}
    {section === "overview" && <>
      <div className="subhub-stats instance-stats"><div className="subhub-stat"><span><HardDrive size={17} />Local vault</span><strong className="instance-stat-text">{status.loading && !status.data ? "Connecting…" : available ? "Connected" : "Unavailable"}</strong></div><div className="subhub-stat"><span><Archive size={17} />Last full backup</span><strong className="instance-stat-text">{latest ? <Ago iso={new Date(latest.createdAt).toISOString()} /> : catalog.loading ? "Loading…" : catalog.data ? "No backup yet" : "Unavailable"}</strong></div><div className="subhub-stat"><span><ShieldCheck size={17} />Latest backup integrity</span><strong className="instance-stat-text">{latest && verified[latest.id] ? "Verified" : latest ? "Not verified here" : "—"}</strong></div></div>
      <div className="instance-vault"><div className="subhub-section-heading"><h3>Full-instance recovery vault</h3><p className="quiet">A local, retained copy of the hub’s data and operating configuration.</p></div><dl><div><dt>Storage directory</dt><dd>{storage ? <code>{storage}</code> : "Not configured"}</dd></div><div><dt>Retained backups</dt><dd>{catalog.data ? snapshots.length : "Unavailable"}</dd></div><div><dt>Retained size</dt><dd>{catalog.data ? size(snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0)) : "Unavailable"}</dd></div><div><dt>Consistency</dt><dd>Containers stopped during capture</dd></div></dl><Coverage coverage={latest?.coverage} />{latest && <div className="subhub-actions"><button className="button" type="button" disabled={!canManage || !available || !!busy || !!error} onClick={() => void verify(latest)}><ShieldCheck size={14} />{busy === latest.id ? "Verifying…" : "Verify latest backup"}</button><button className="button" type="button" disabled={!!busy} onClick={() => chooseRestore(latest)}><FolderOpen size={14} />Restore…</button></div>}</div>
      {catalog.loading && !catalog.data ? <SkeletonRows rows={2} /> : catalog.data && !snapshots.length ? empty : null}
      <p className="subhub-note">A full-instance backup includes the database and Git data, accounts and permissions, and the server’s runtime and configuration. Capture runs on the hub’s Docker host and interrupts the selected containers.</p>
    </>}
    {section === "backups" && <><div className="subhub-section-heading"><h3>Full-instance backups</h3><p className="quiet">Retained generations in this hub’s local vault.</p></div>{catalog.loading && !catalog.data ? <SkeletonRows rows={3} /> : catalog.data && !snapshots.length ? empty : <div className="instance-backups">{snapshots.map(snapshot => {
      const result = verified[snapshot.id];
      const command = commandOf(() => instanceVerifyCommand(snapshot.id, storage));
      return <article className="instance-backup" key={snapshot.id}><div className="subhub-heading"><div><h3>{new Date(snapshot.createdAt).toLocaleString()}</h3><p className="quiet">{snapshot.source} · {snapshot.files.toLocaleString()} files · {size(snapshot.bytes)}</p></div><span className="label">Full instance</span></div><code className="instance-snapshot-id">{snapshot.id}</code><Coverage coverage={snapshot.coverage} /><div className="instance-integrity">{result ? <><Check size={14} /><span>Integrity verified <Ago iso={new Date(result.verifiedAt).toISOString()} /></span></> : <><ShieldCheck size={14} /><span>Integrity has not been verified here</span></>}</div><div className="subhub-actions"><button className="button" type="button" disabled={!canManage || !available || !!busy || !!error} onClick={() => void verify(snapshot)}>{busy === snapshot.id ? "Verifying…" : "Verify backup"}</button><button className="button" type="button" disabled={!!busy} onClick={() => chooseRestore(snapshot)}>Restore…</button></div><details className="instance-backup-details"><summary>Backup details and verify command</summary><dl><div><dt>Services</dt><dd>{snapshot.services.join(", ")}</dd></div><div><dt>Manifest SHA-256</dt><dd><code>{snapshot.sha256}</code></dd></div><div><dt>Consistency</dt><dd>Stopped containers</dd></div></dl>{command && <CommandTabs tabs={[{ label: "Verify locally", lines: [command] }]} />}</details></article>;
    })}</div>}</>}
    {section === "restore" && <><div className="subhub-section-heading"><h3>Restore a full-instance backup</h3><p className="quiet">Write the selected backup into a new directory. The restored instance is not started automatically.</p></div>{catalog.loading && !catalog.data ? <SkeletonRows rows={2} /> : !selected ? catalog.data ? empty : null : <form className="subhub-form instance-restore" onSubmit={event => void restore(event)}>
      <label htmlFor="instance-restore-snapshot">Full-instance backup<select id="instance-restore-snapshot" value={selected.id} disabled={!!busy} onChange={event => { setSelectedId(event.target.value); setRestored(undefined); setActionError(""); }}>{snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.source} · {snapshot.id.slice(0, 8)}</option>)}</select></label>
      <Coverage coverage={selected.coverage} /><label htmlFor="instance-restore-directory">New restore directory<input id="instance-restore-directory" value={directory} onChange={event => { setDirectory(event.target.value); setRestored(undefined); }} placeholder={status.data?.cli.restoreRoot ? `${status.data.cli.restoreRoot.replace(/[\\/]+$/, "")}/restored-instance` : "/new/restore-directory"} disabled={!!busy} required /><span className="quiet">The directory must not already exist.{status.data?.cli.restoreRoot && <> Allowed restore root: <code>{status.data.cli.restoreRoot}</code>.</>}</span></label>
      <div className="instance-restore-note"><FolderOpen size={18} /><p>Restoring writes files only. Review the restored configuration and data before starting an instance.</p></div>
      {directory.trim() && commandOf(() => instanceRestoreCommand(selected.id, directory, storage)) && <CommandTabs tabs={[{ label: "Equivalent CLI command", lines: [instanceRestoreCommand(selected.id, directory, storage)] }]} />}
      {restored && <div className="instance-restored" role="status"><Check size={20} /><div><h3>Restored files; instance not started</h3><p>{restored.files.toLocaleString()} files · {size(restored.bytes)}</p><code>{restored.directory}</code></div></div>}
      <button className="button primary" type="submit" disabled={!canManage || !available || !!error || !!busy || !directory.trim()}><ArrowDownToLine size={15} />{busy === "restore" ? "Restoring files…" : "Restore to new directory"}</button>
    </form>}</>}
    {backupFlow && <BackupCommandDialog config={status.data?.cli} onClose={() => setBackupFlow(false)} />}
  </div>;
}

function Coverage({ coverage }: { coverage?: InstanceCoverage }) {
  const included = !!coverage?.data && !!coverage.runtime && !!coverage.configuration;
  return <div className={`instance-coverage${included ? " included" : ""}`} aria-label={included ? "Included in this full-instance backup" : "Full-instance backup coverage"}><span><Database size={14} />Database &amp; Git</span><span><ShieldCheck size={14} />Accounts &amp; permissions</span><span><ServerCog size={14} />Server &amp; configuration</span></div>;
}

function BackupCommandDialog({ config, onClose }: { config?: InstanceRecoveryStatus["cli"]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const [containers, setContainers] = useState(config?.containers.join("\n") ?? "");
  const [storage, setStorage] = useState(config?.storage ?? "");
  const [shell, setShell] = useState<CommandShell>("powershell");
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  let command = "", error = "";
  try { command = instanceBackupCommand({ containers: containers.split(/[\n,]+/).map(name => name.trim()).filter(Boolean), storage, shell }); } catch (caught) { error = messageOf(caught); }
  return <dialog className="subhub-dialog instance-command-dialog" ref={dialog} aria-labelledby={`${prefix}-title`} onCancel={onClose}><div className="subhub-dialog-heading"><div><h2 id={`${prefix}-title`}>Back up instance</h2><p className="quiet">Run a reviewed capture command on this hub’s Docker host.</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close backup command"><X size={18} /></button></div><div className="instance-capture-note"><ServerCog size={21} /><div><strong>This capture stops the selected containers.</strong><p>The entire hub may be unavailable during capture, including this page. Run the command from the Docker host with operator access.</p></div></div>
    <div className="subhub-form"><label htmlFor={`${prefix}-containers`}>Docker containers, one per line<textarea id={`${prefix}-containers`} value={containers} onChange={event => { setContainers(event.target.value); setReviewed(false); }} rows={3} placeholder={"spacehub\nspacehub-proxy"} autoFocus /><span className="quiet">Include the main hub and any proxy or other service required to restore this instance.</span></label><label htmlFor={`${prefix}-storage`}>Dedicated local vault directory<input id={`${prefix}-storage`} value={storage} onChange={event => { setStorage(event.target.value); setReviewed(false); }} placeholder="/srv/spacehub-recovery" /></label><label htmlFor={`${prefix}-shell`}>Command shell<select id={`${prefix}-shell`} value={shell} onChange={event => setShell(event.target.value as CommandShell)}><option value="powershell">PowerShell</option><option value="sh">macOS / Linux shell</option></select></label></div>
    <label className="instance-review"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed the containers and vault path, and understand that capture stops these containers.</label>
    {error ? <p className="subhub-note">{error}</p> : reviewed && <CommandTabs tabs={[{ label: "Capture full instance", lines: [command] }, { label: "List retained backups", lines: [instanceSnapshotsCommand(storage, shell)] }]} note="After the CLI capture completes and the hub is available, refresh this page to see the retained backup." />}
  </dialog>;
}
