import { useEffect, useState } from "react";
import { Archive, Check, HardDrive, Laptop, ShieldCheck } from "lucide-react";
import { size } from "@/api";
import { useInstanceRecovery } from "@/hooks/use-instance-recovery";
import { instanceConnectionLabel, instancePost, instanceRequest, type InstanceConnection, type InstanceSnapshot, type InstanceVerification } from "@/lib/instance-recovery";
import { hashOf, onLink } from "@/router";
import { Ago, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

/** What a connected sub-hub says about its storage right now (instanceruntime.ts answers it). */
type Storage = { name: string; keep: number; intervalSeconds: number; snapshots: InstanceSnapshot[]; bytes: number; freeBytes: number };
type SubhubView = { connection: InstanceConnection; live: Storage | null; error?: string };
type BackupFiles = { snapshot: InstanceSnapshot; files: { path: string; size: number; sha256: string }[]; total: number; hub: unknown };

const iso = (at: number) => new Date(at).toISOString();
const kindOf = (snapshot: InstanceSnapshot) => (snapshot.consistency === "live-copy" ? "Hub data, copied live" : "Whole deployment, stopped");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "The sub-hub did not answer.");

/**
 * /subhub/<name>: a connected backup machine, read live through the hub. While
 * the machine runs `spacehub subhub run`, this shows its storage folder as it
 * is right now; when it is offline, its last report.
 */
export function SubhubPage({ name, backup }: { name: string; backup: string }) {
  const view = useInstanceRecovery<SubhubView>(`/subhubs/${encodeURIComponent(name)}`);
  const connection = view.data?.connection;
  const live = view.data?.live;
  const snapshots = [...(live?.snapshots ?? connection?.snapshots ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const base = `/subhub/${encodeURIComponent(name)}`;
  if (!view.data) {
    return <div className="page subhub-page">{view.error ? <Empty icon={<Laptop size={20} />} title={`Sub-hub ${name}`}><p>{view.error}</p></Empty> : <SkeletonRows rows={4} />}</div>;
  }
  return <div className="page subhub-page">
    <div className="subhub-heading">
      <div><h1><Laptop size={20} /> {connection?.name ?? name}</h1><p className="quiet">A sub-hub: a machine that keeps copies of this hub's backups. {live ? "Its storage, read from the machine just now." : "Its last report: it is not answering right now."}</p></div>
      {connection && <span className="label">{instanceConnectionLabel(connection)}</span>}
    </div>
    {view.data.error && <ErrorNote message={view.data.error} />}
    <div className="subhub-facts">
      <span><Archive size={14} />{snapshots.length} {snapshots.length === 1 ? "backup" : "backups"}{live ? ` kept (up to ${live.keep})` : ""}</span>
      {live && <span><HardDrive size={14} />{size(live.bytes)} used · {size(live.freeBytes)} free</span>}
      {connection && <span>Seen <Ago iso={iso(connection.lastSeen)} /></span>}
      {live && <span>Checks the hub every {live.intervalSeconds} s</span>}
    </div>
    {!snapshots.length ? <p className="subhub-note">No backups on this machine yet.</p> : <ul className="subhub-backups">
      {snapshots.map(snapshot => <li key={snapshot.id} className={snapshot.id === backup ? "selected" : undefined}>
        <a href={`${base}#${hashOf("backup", { id: snapshot.id })}`} onClick={onLink}>
          <strong><Ago iso={iso(snapshot.createdAt)} /></strong>
          <span className="instance-backup-fact">{kindOf(snapshot)} · {size(snapshot.bytes)} · {snapshot.files.toLocaleString()} files</span>
          <code>{snapshot.id}</code>
        </a>
      </li>)}
    </ul>}
    {backup && <BackupDetail name={name} id={backup} online={!!live} />}
  </div>;
}

/** One backup on the machine: its files, hub.json, and verifying it there. */
function BackupDetail({ name, id, online }: { name: string; id: string; online: boolean }) {
  const [files, setFiles] = useState<BackupFiles>();
  const [error, setError] = useState("");
  const [verified, setVerified] = useState<InstanceVerification>();
  const [busy, setBusy] = useState(false);
  const path = `/subhubs/${encodeURIComponent(name)}/snapshots/${id}`;
  useEffect(() => {
    setFiles(undefined); setError(""); setVerified(undefined);
    if (!online) { setError(`${name} is offline: its files can be read while it runs.`); return; }
    let closed = false;
    instanceRequest<BackupFiles>(path).then(data => { if (!closed) setFiles(data); }, failure => { if (!closed) setError(messageOf(failure)); });
    return () => { closed = true; };
  }, [path, online, name]);
  const verify = async () => {
    setBusy(true); setError("");
    try { setVerified(await instancePost<InstanceVerification>(`${path}/verify`)); } catch (failure) { setError(messageOf(failure)); } finally { setBusy(false); }
  };
  return <section className="subhub-detail" aria-label="Backup files">
    <div className="subhub-heading"><h2>Backup <code>{id}</code></h2>{online && <button className="button" type="button" onClick={verify} disabled={busy}><ShieldCheck size={15} />{busy ? `Verifying on ${name}…` : `Verify on ${name}`}</button>}</div>
    {verified && <p className="subhub-note"><Check size={14} /> Every file matches its checksum on {name}: {verified.files.toLocaleString()} files, {size(verified.bytes)}.</p>}
    {error && <ErrorNote message={error} />}
    {!files && !error && <SkeletonRows rows={5} />}
    {files && <>
      <p className="quiet">{kindOf(files.snapshot)} from {files.snapshot.source} · {files.total.toLocaleString()} files · {size(files.snapshot.bytes)}{files.total > files.files.length ? ` · the first ${files.files.length.toLocaleString()} shown` : ""}</p>
      {files.hub !== null && <pre className="subhub-hub-json">{JSON.stringify(files.hub, null, 2)}</pre>}
      <table className="subhub-files"><thead><tr><th>File</th><th className="r">Size</th><th>SHA-256</th></tr></thead><tbody>
        {files.files.map(file => <tr key={file.path}><td><code>{file.path}</code></td><td className="r">{size(file.size)}</td><td><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></td></tr>)}
      </tbody></table>
    </>}
  </section>;
}
