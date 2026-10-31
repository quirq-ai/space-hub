import { useEffect, useId, useState, type FormEvent } from "react";
import { Archive, ArrowDownToLine, Check, Clock, Database, FolderOpen, HardDrive, Laptop, RefreshCw, ServerCog, ShieldCheck } from "lucide-react";
import { size } from "@/api";
import { useInstanceRecovery } from "@/hooks/use-instance-recovery";
import { instanceBackupCommand, instanceConnectionLabel, instancePost, instanceRemoteRestoreCommand, instanceRestoreBody, instanceRestoreCommand, instanceRunCommand, instanceSnapshotsCommand, instanceVerifyCommand, latestInstanceSnapshot, type CommandShell, type InstanceConnection, type InstanceCoverage, type InstanceRecoveryStatus, type InstanceRestore, type InstanceSnapshot, type InstanceVerification } from "@/lib/instance-recovery";
import { Ago, CommandTabs, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

type Section = "overview" | "backups" | "restore";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The full-instance recovery request could not be completed.";
function commandOf(build: () => string) { try { return build(); } catch { return ""; } }
const iso = (at: number) => new Date(at).toISOString();

/** CLI connections report automatic backups; only this recovery service's vault is writable here. */
export function InstanceRecoveryPage({ onConnectionState }: { onConnectionState?: (state: "live" | "offline" | "loading") => void }) {
  const status = useInstanceRecovery<InstanceRecoveryStatus>("/status");
  const catalog = useInstanceRecovery<{ snapshots: InstanceSnapshot[] }>("/snapshots");
  const peers = useInstanceRecovery<{ connections: InstanceConnection[] }>("/connections");
  const connection = status.error ? "offline" : status.loading && !status.data ? "loading" : "live";
  useEffect(() => { onConnectionState?.(connection); }, [connection, onConnectionState]);
  const [section, setSection] = useState<Section>("overview");
  const [selectedId, setSelectedId] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [verified, setVerified] = useState<Record<string, InstanceVerification>>({});
  const [restored, setRestored] = useState<InstanceRestore>();
  const snapshots = [...(catalog.data?.snapshots ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const connections = peers.data?.connections ?? [];
  const online = peers.error ? [] : connections.filter(peer => peer.online);
  const latestLocal = snapshots[0];
  const latest = latestInstanceSnapshot([...snapshots, ...connections.flatMap(peer => peer.snapshots)]);
  const selected = snapshots.find(snapshot => snapshot.id === selectedId) ?? latestLocal;
  const error = status.error || peers.error;
  const localError = catalog.error || status.data?.error || "";
  const canManage = status.data?.canManage === true && !status.error;
  const available = status.data?.available === true && !status.error;
  const storage = status.data?.cli?.storage ?? "";
  const machine = status.data?.machineName || "Recovery service machine";
  const refresh = () => { status.refresh(); catalog.refresh(); peers.refresh(); };
  const chooseRestore = (snapshot: InstanceSnapshot) => { if (busy) return; setSelectedId(snapshot.id); setSection("restore"); setDirectory(""); setRestored(undefined); setActionError(""); };
  const verify = async (snapshot: InstanceSnapshot) => {
    if (!canManage || !available || busy) return;
    setBusy(snapshot.id); setActionError("");
    setVerified(previous => { const next = { ...previous }; delete next[snapshot.id]; return next; });
    try { const result = await instancePost<InstanceVerification>(`/snapshots/${snapshot.id}/verify`); setVerified(previous => ({ ...previous, [snapshot.id]: result })); }
    catch (caught) { setActionError(messageOf(caught)); } finally { setBusy(""); }
  };
  const restore = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !canManage || !available || busy) return;
    setSelectedId(selected.id); setBusy("restore"); setActionError(""); setRestored(undefined);
    try { setRestored(await instancePost<InstanceRestore>("/restore", instanceRestoreBody(selected.id, directory))); }
    catch (caught) { setActionError(messageOf(caught)); } finally { setBusy(""); }
  };
  return <section className="subhubs instance-recovery" aria-label="Sub-hubs">
    <header className="subhub-heading"><div><h2><Archive size={20} />Sub-hubs</h2><p className="quiet">Automatic backups of this entire Spacehub instance</p></div><button className="button" type="button" onClick={refresh}><RefreshCw size={14} />Refresh</button></header>
    <div className="meta-strip"><span className="label">Full instance</span>{status.data?.source && <span><ServerCog size={14} />{status.data.source}</span>}<span className="quiet">Automatic backups</span></div>
    <nav className="subhub-sections" aria-label="Full-instance recovery sections">{([{ key: "overview", label: "Overview", Icon: Laptop }, { key: "backups", label: "Backups", Icon: Archive }, { key: "restore", label: "Restore", Icon: ArrowDownToLine }] as const).map(({ key, label, Icon }) => <button key={key} type="button" className={section === key ? "on" : ""} aria-current={section === key ? "page" : undefined} onClick={() => { setSection(key); setActionError(""); }}><Icon size={15} />{label}</button>)}</nav>
    {error && <ErrorNote message={error} retry={refresh} />}
    {actionError && <ErrorNote message={actionError} />}
    {!status.loading && status.data && !canManage && <p className="instance-permission"><ShieldCheck size={16} />Backup verification and restore require full-hub operator permission.</p>}

    {section === "overview" && <>
      <div className="subhub-stats instance-stats"><div className="subhub-stat"><span><Laptop size={17} />Sub-hubs online</span><strong className="instance-stat-text">{peers.error ? "Unavailable" : peers.loading && !peers.data ? "Checking…" : `${online.length} / ${connections.length}`}</strong></div><div className="subhub-stat"><span><Archive size={17} />Last reported backup</span><strong className="instance-stat-text">{latest ? <Ago iso={iso(latest.createdAt)} /> : "No backup yet"}</strong></div><div className="subhub-stat"><span><ServerCog size={17} />Backup source</span><strong className="instance-stat-text">{status.loading && !status.data ? "Checking…" : status.data?.sourceAvailable === true ? "Configured" : status.data?.sourceAvailable === false ? "Waiting" : "Not reported"}</strong></div></div>
      {status.data?.sourceAvailable === false && <div className="instance-waiting"><Clock size={18} /><div><strong>Waiting for backup source</strong><p>{status.data.sourceError || "Automatic backups will begin when this hub’s backup source is available."}</p></div></div>}
      {peers.loading && !peers.data ? <SkeletonRows rows={2} /> : connections.length ? <div className="instance-connections">{connections.map(peer => <SubhubConnectionCard key={peer.id} connection={peer} unavailable={!!peers.error} />)}</div> : peers.data && !peers.error ? <Empty icon={<Laptop size={23} />} title="No Sub-hubs connected"><p>Run the CLI on a backup machine. It connects to your configured hub and keeps backups automatically.</p></Empty> : null}
      <ConnectionSetup />
    </>}

    {section === "backups" && <>
      <div className="subhub-section-heading"><h3>Backups in this recovery vault</h3><p className="quiet">Machine: {machine}. Verify and restore actions below use this machine’s local vault{storage ? <> at <code>{storage}</code></> : ""}.</p></div>
      {!available && !status.loading && <p className="instance-permission"><HardDrive size={16} />No local recovery vault is available here. Copies reported by connected Sub-hubs remain on their own machines.</p>}
      {available && localError && <ErrorNote message={localError} retry={catalog.refresh} />}
      {available && catalog.loading && !catalog.data ? <SkeletonRows rows={2} /> : available && catalog.data && !snapshots.length ? <Empty icon={<Archive size={22} />} title="No backups in this local vault yet"><p>Automatic backups appear here when the CLI saves them on this machine.</p></Empty> : <div className="instance-backups">{snapshots.map(snapshot => {
        const result = verified[snapshot.id];
        return <article className="instance-backup" key={snapshot.id}><SnapshotHeading snapshot={snapshot} machine={machine} /><Coverage coverage={snapshot.coverage} /><div className="instance-integrity">{result ? <><Check size={14} /><span>Integrity verified <Ago iso={iso(result.verifiedAt)} /></span></> : <><ShieldCheck size={14} /><span>Integrity has not been verified here</span></>}</div><div className="subhub-actions"><button className="button" type="button" disabled={!canManage || !available || !!busy || !!localError} onClick={() => void verify(snapshot)}>{busy === snapshot.id ? "Verifying…" : "Verify backup"}</button><button className="button" type="button" disabled={!!busy || !available} onClick={() => chooseRestore(snapshot)}><FolderOpen size={14} />Restore…</button></div><details className="instance-backup-details"><summary>Backup details and local CLI command</summary><p className="quiet">Run on {machine}.</p><code className="instance-snapshot-id">SHA-256 {snapshot.sha256}</code>{commandOf(() => instanceVerifyCommand(snapshot.id, storage)) && <CommandTabs tabs={[{ label: "Verify locally", lines: [instanceVerifyCommand(snapshot.id, storage)] }]} />}</details></article>;
      })}</div>}
      {available && storage && <details className="instance-local-commands"><summary>CLI commands for this local vault</summary><p className="subhub-note">Run these commands on {machine}.</p><CommandTabs tabs={[{ label: "Back up once", lines: [instanceBackupCommand(storage)] }, { label: "List backups", lines: [instanceSnapshotsCommand(storage)] }]} /></details>}
      {!!connections.length && <section className="instance-remote-catalog"><div className="subhub-section-heading"><h3>Copies on connected Sub-hubs</h3><p className="quiet">Reported catalogs are read-only here. Restore each copy on the named machine using its local CLI.</p></div>{connections.map(peer => <RemoteBackupCatalog key={peer.id} connection={peer} unavailable={!!peers.error} />)}</section>}
    </>}

    {section === "restore" && <>
      <div className="subhub-section-heading"><h3>Restore on {machine}</h3><p className="quiet">Choose a backup in this recovery service’s local vault and a new directory on this same machine. The restored instance is not started automatically.</p></div>
      {!available && !status.loading ? <Empty icon={<FolderOpen size={22} />} title="Restore from the machine holding your backup"><p>No local recovery vault is available here. Use the machine-specific CLI instructions in Backups for copies on other Sub-hubs.</p><button className="button" type="button" onClick={() => setSection("backups")}>View reported backups</button></Empty> : catalog.loading && !catalog.data ? <SkeletonRows rows={2} /> : !selected ? <Empty icon={<Archive size={22} />} title="No local backup to restore"><p>Backups reported by other Sub-hubs can be restored on those machines.</p></Empty> : <form className="subhub-form instance-restore" onSubmit={event => void restore(event)}>
        {localError && <ErrorNote message={localError} retry={catalog.refresh} />}
        <label htmlFor="instance-restore-snapshot">Backup on {machine}<select id="instance-restore-snapshot" value={selected.id} disabled={!!busy} onChange={event => { setSelectedId(event.target.value); setRestored(undefined); setActionError(""); }}>{snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.source} · {snapshot.id.slice(0, 8)}</option>)}</select></label>
        <Coverage coverage={selected.coverage} /><label htmlFor="instance-restore-directory">New restore directory on {machine}<input id="instance-restore-directory" value={directory} onChange={event => { setDirectory(event.target.value); setRestored(undefined); }} placeholder={status.data?.cli?.restoreRoot ? `${status.data.cli.restoreRoot.replace(/[\\/]+$/, "")}/restored-instance` : "/new/restore-directory"} disabled={!!busy} required /><span className="quiet">The directory must not already exist.{status.data?.cli?.restoreRoot && <> Allowed restore root: <code>{status.data.cli.restoreRoot}</code>.</>}</span></label>
        <div className="instance-restore-note"><FolderOpen size={18} /><p>Restoring writes files on {machine} only. Review the restored configuration and data before starting an instance.</p></div>
        {directory.trim() && commandOf(() => instanceRestoreCommand(selected.id, directory, storage)) && <CommandTabs tabs={[{ label: "Equivalent local CLI command", lines: [instanceRestoreCommand(selected.id, directory, storage)] }]} />}
        {restored && <div className="instance-restored" role="status"><Check size={20} /><div><h3>Restored files; instance not started</h3><p>{machine} · {restored.files.toLocaleString()} files · {size(restored.bytes)}</p><code>{restored.directory}</code></div></div>}
        <button className="button primary" type="submit" disabled={!canManage || !available || !!localError || !!busy || !directory.trim()}><ArrowDownToLine size={15} />{busy === "restore" ? "Restoring files…" : "Restore to new directory"}</button>
      </form>}
    </>}
  </section>;
}

export function SubhubConnectionCard({ connection, unavailable = false }: { connection: InstanceConnection; unavailable?: boolean }) {
  const latest = latestInstanceSnapshot(connection.snapshots);
  const label = unavailable ? "Status unavailable" : instanceConnectionLabel(connection);
  return <article className="instance-connection"><div className="subhub-heading"><div className="instance-connection-name"><Laptop size={20} /><h3>{connection.name || connection.id}</h3></div><span className={`label ${!unavailable && connection.online && connection.state === "up-to-date" ? "done" : !unavailable && connection.online && connection.state === "error" ? "warn" : ""}`}>{connection.online && !unavailable && <i className="online-dot" />}{label}</span></div><dl><div><dt>Heartbeat</dt><dd>Last seen <Ago iso={iso(connection.lastSeen)} /></dd></div><div><dt>Connected</dt><dd><Ago iso={iso(connection.connectedAt)} /></dd></div><div><dt>Last reported backup</dt><dd>{latest ? <><Ago iso={iso(latest.createdAt)} /><span className="instance-backup-fact">{latest.source} · {size(latest.bytes)}</span></> : "No backup reported yet"}</dd></div></dl>{!unavailable && connection.online && connection.state === "waiting" && <p className="subhub-note">Connected and waiting for the hub’s backup source.</p>}{!connection.online && <p className="subhub-note">This Sub-hub is offline. Its last reported backups stay on that machine.</p>}{connection.error && <p className="instance-connection-error">{connection.error}</p>}</article>;
}

export function RemoteBackupCatalog({ connection, unavailable = false }: { connection: InstanceConnection; unavailable?: boolean }) {
  return <article className="instance-backup instance-remote-backup"><div className="subhub-heading"><h3><Laptop size={16} />{connection.name || connection.id}</h3><span className="label">{unavailable ? "Status unavailable" : instanceConnectionLabel(connection)}</span></div>{!connection.snapshots.length ? <p className="subhub-note">No backup reported by this machine yet.</p> : <ul>{[...connection.snapshots].sort((a, b) => b.createdAt - a.createdAt).map(snapshot => <li key={snapshot.id}><div><strong><Ago iso={iso(snapshot.createdAt)} /></strong><span className="instance-backup-fact">{snapshot.source} · {size(snapshot.bytes)} · {snapshot.files.toLocaleString()} files</span><code>{snapshot.id}</code></div><details><summary>Restore on {connection.name || connection.id}</summary><p className="subhub-note">Run on {connection.name || connection.id}. Replace &lt;folder&gt; with the storage folder used by its CLI and choose a new directory on that machine.</p><CommandTabs tabs={[{ label: "Restore on this machine", lines: [instanceRemoteRestoreCommand(snapshot.id)] }]} /></details></li>)}</ul>}</article>;
}

function SnapshotHeading({ snapshot, machine }: { snapshot: InstanceSnapshot; machine: string }) {
  return <><div className="subhub-heading"><div><h3>{new Date(snapshot.createdAt).toLocaleString()}</h3><p className="quiet">{snapshot.source} · {snapshot.files.toLocaleString()} files · {size(snapshot.bytes)}</p></div><span className="label">{machine}</span></div><code className="instance-snapshot-id">{snapshot.id}</code></>;
}
function Coverage({ coverage }: { coverage?: InstanceCoverage }) {
  const included = !!coverage?.data && !!coverage.runtime && !!coverage.configuration;
  return <div className={`instance-coverage${included ? " included" : ""}`} aria-label={included ? "Included in this full-instance backup" : "Full-instance backup coverage"}><span><Database size={14} />Database &amp; Git</span><span><ShieldCheck size={14} />Accounts &amp; permissions</span><span><ServerCog size={14} />Server &amp; configuration</span></div>;
}
function ConnectionSetup() {
  const prefix = useId();
  const [storage, setStorage] = useState("");
  const [shell, setShell] = useState<CommandShell>("powershell");
  const command = storage.trim() ? commandOf(() => instanceRunCommand({ storage, shell })) : "spacehub subhub run --storage <folder>";
  return <section className="instance-setup" aria-labelledby={`${prefix}-title`}><h3 id={`${prefix}-title`}>Run a Sub-hub from the CLI</h3><p className="quiet">Sign in to this hub with the CLI, then run this on the machine that will hold the backups. Keep it running to connect and back up automatically.</p><div className="instance-setup-fields"><label htmlFor={`${prefix}-storage`}>Folder on the backup machine<input id={`${prefix}-storage`} value={storage} onChange={event => setStorage(event.target.value)} placeholder="<folder>" /></label><label htmlFor={`${prefix}-shell`}>Command shell<select id={`${prefix}-shell`} value={shell} onChange={event => setShell(event.target.value as CommandShell)}><option value="powershell">PowerShell</option><option value="sh">macOS / Linux shell</option></select></label></div>{command ? <CommandTabs tabs={[{ label: "Automatic backups", lines: [command] }]} note={<>Replace &lt;folder&gt; with a local backup folder. Optional flags: <code>--name &lt;name&gt;</code> and <code>--interval &lt;seconds&gt;</code>. Connections appear above when the CLI checks in.</>} /> : <p className="subhub-note">Enter a folder path without line breaks.</p>}</section>;
}
