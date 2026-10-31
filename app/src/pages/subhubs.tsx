import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Archive, ArrowDownToLine, Check, HardDrive, ListTodo, Pause, Play, Plus, RefreshCw, Server, X } from "lucide-react";
import { placeUrl, size } from "@/api";
import { useSubhubActivity, useSubhubNodes, useSubhubResource } from "@/hooks/use-subhubs";
import { canClaim, connectCommand, driveDownload, driveHeaders, jsonMutation, MAX_DRIVE_FILE_BYTES, nodeReady, nodeState, ownsLease, restoreCommand, subhubRequest, subhubUrl, validDrivePath, type DriveFile, type DriveStats, type SubhubMode, type SubhubNode, type SubhubWork } from "@/lib/subhubs";
import { onLink } from "@/router";
import { Ago, CommandTabs, CopyButton, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

type Section = "overview" | "backups" | "work" | "drive";
const sections: { key: Section; label: string; icon: ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <Server size={15} /> }, { key: "backups", label: "Backups", icon: <Archive size={15} /> },
  { key: "work", label: "Work queue", icon: <ListTodo size={15} /> }, { key: "drive", label: "Drive", icon: <HardDrive size={15} /> },
];
const messageOf = (error: unknown) => error instanceof Error ? error.message : "This request could not be completed.";
const timeOf = (at: number | string) => new Date(at).toISOString();

export function SubhubsPage({ space, canManage, canWrite, me, projects }: { space: string; canManage: boolean; canWrite: boolean; me: string | null; projects: string[] }) {
  const [section, setSection] = useState<Section>("overview");
  const [connecting, setConnecting] = useState(false);
  const resource = useSubhubNodes(space);
  const nodes = resource.data?.nodes ?? [];
  const online = resource.error ? [] : nodes.filter(node => node.healthy);
  const backups = nodes.flatMap(node => node.backups.map(backup => ({ ...backup, node })));
  return <section className="subhubs" aria-label={`Sub-hubs in ${space}`}>
    <div className="subhub-heading"><div><h2>Sub-hubs</h2><p className="quiet">Your machines, connected to {space}. Keep backups, route work, or share a drive.</p></div><div className="subhub-actions"><button className="button" type="button" onClick={resource.refresh} aria-label="Refresh sub-hubs"><RefreshCw size={14} /></button>{canManage && <button className="button primary" type="button" onClick={() => setConnecting(true)}><Plus size={15} />Connect a machine</button>}</div></div>
    <nav className="subhub-sections" aria-label="Sub-hub sections">{sections.map(item => <button key={item.key} className={section === item.key ? "on" : ""} type="button" aria-current={section === item.key ? "page" : undefined} onClick={() => setSection(item.key)}>{item.icon}{item.label}</button>)}</nav>
    {resource.error && <ErrorNote message={resource.error} retry={resource.refresh} />}
    {resource.loading && !resource.data ? <SkeletonRows rows={3} /> : <>
      {section === "overview" && <>
        <div className="subhub-stats"><Stat label="Machines online" value={`${online.length} / ${nodes.length}`} icon={<Server size={18} />} /><Stat label="Projects backed up" value={new Set(backups.map(backup => backup.project)).size} icon={<Archive size={18} />} /><Stat label="Drive files" value={nodes.reduce((sum, node) => sum + (node.drive?.files ?? 0), 0)} icon={<HardDrive size={18} />} /></div>
        {!nodes.length && !resource.error ? <Empty icon={<Server size={22} />} title="Connect your first sub-hub"><p>A machine running spacehub can keep retained Git backups, receive work, or provide a drive.</p>{canManage ? <button className="button" type="button" onClick={() => setConnecting(true)}><Plus size={14} />Connect a machine</button> : <p>A space owner can connect a machine.</p>}</Empty> : <div className="subhub-grid">{nodes.map(node => <NodeCard key={node.id} node={node} canManage={canManage} unavailable={!!resource.error} refresh={resource.refresh} />)}</div>}
        <SubhubRecentActivity space={space} />
      </>}
      {section === "backups" && <><div className="subhub-section-heading"><h3>Retained project snapshots</h3><p className="quiet">The latest catalog reported by each machine. Earlier generations remain in that machine’s local storage.</p></div>{backups.length ? <div className="subhub-table-wrap"><table className="subhub-table"><thead><tr><th>Project</th><th>Machine</th><th>Snapshot</th><th>Size</th><th>Restore</th></tr></thead><tbody>{backups.map(backup => <tr key={`${backup.node.id}/${backup.project}/${backup.snapshot}`}><td><a href={placeUrl({ space: backup.project.split("/")[0], project: backup.project.split("/")[1] })} onClick={onLink}>{backup.project}</a><span className="subhub-cell-note mono">{backup.oid.slice(0, 12)}</span></td><td>{backup.node.label || backup.node.id}<span className="subhub-cell-note">{resource.error ? "Unavailable" : nodeState(backup.node)}</span></td><td><code title={backup.snapshot}>{backup.snapshot.slice(0, 12)}</code></td><td>{size(backup.bytes)}</td><td><CopyButton text={restoreCommand(backup.snapshot)} label={`Copy local restore command for ${backup.project}`} /></td></tr>)}</tbody></table></div> : <Empty icon={<Archive size={22} />} title="No snapshots reported yet"><p>Connected machines in backup mode retain project history and report their snapshots here.</p></Empty>}<p className="subhub-note">Restore on the machine holding the snapshot, into a new directory. <code>spacehub subhub snapshots --storage &lt;directory&gt;</code> lists every retained generation.</p></>}
      {section === "work" && <WorkQueue space={space} me={me} canWrite={canWrite} projects={projects} />}
      {section === "drive" && <Drive space={space} nodes={nodes} unavailable={!!resource.error} canWrite={canWrite} />}
    </>}
    {connecting && <ConnectDialog space={space} onClose={() => setConnecting(false)} />}
  </section>;
}
function Stat({ label, value, icon }: { label: string; value: string | number; icon: ReactNode }) { return <div className="subhub-stat"><span>{icon}{label}</span><strong>{value}</strong></div>; }

function NodeCard({ node, canManage, unavailable, refresh }: { node: SubhubNode; canManage: boolean; unavailable: boolean; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(node.label || node.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const used = Math.max(0, node.capacityBytes - node.freeBytes);
  const update = async (changes: { label?: string; mode?: SubhubMode; enabled?: boolean }) => {
    setBusy(true); setError("");
    try { await jsonMutation(`/nodes/${encodeURIComponent(node.id)}`, { space: node.space, ...changes }, "PATCH"); setEditing(false); refresh(); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  };
  const state = unavailable ? "Unavailable" : nodeState(node);
  return <article className="subhub-node"><div className="subhub-node-heading"><span className="subhub-node-icon"><Server size={20} /></span><div><h3>{node.label || node.id}</h3><span className="quiet mono">{node.id}</span></div><span className={`label ${!unavailable && nodeReady(node) ? node.status === "ready" ? "done" : "warn" : ""}`}>{state === "Online" && <i className="online-dot" />}{state}</span></div>
    <div className="subhub-node-meta"><span>{node.mode === "drive" ? <HardDrive size={14} /> : <Archive size={14} />}{node.mode === "drive" ? "Drive" : "Backups"}</span><span>{node.seenAt === null ? "Waiting for first connection" : <>Last seen <Ago iso={timeOf(node.seenAt)} /></>}</span></div>
    <div className="subhub-capacity"><div><span>{size(used)} used</span><span>{size(node.capacityBytes)} capacity</span></div><meter min={0} max={Math.max(1, node.capacityBytes)} value={used} aria-label={`Storage used on ${node.label || node.id}`} /><p>{size(Math.max(0, node.freeBytes))} available · {node.mode === "drive" ? `${node.drive?.files ?? 0} files` : `${node.backups.length} snapshots reported`}</p></div>
    {!!node.errors?.length && <ul className="subhub-node-errors">{node.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
    {canManage && <div className="subhub-node-controls"><label className="subhub-inline-label">Mode<select value={node.mode} disabled={busy || unavailable} onChange={event => void update({ mode: event.target.value as SubhubMode })}><option value="backup">Backups</option><option value="drive" disabled={!node.url}>Drive{!node.url ? " (needs public address)" : ""}</option></select></label><button type="button" className="button" disabled={busy || unavailable} onClick={() => void update({ enabled: !node.enabled })}>{node.enabled ? <Pause size={13} /> : <Play size={13} />}{node.enabled ? "Pause" : "Enable"}</button><button className="button" type="button" disabled={busy || unavailable} onClick={() => { setLabel(node.label || node.id); setEditing(value => !value); }}>Rename</button></div>}
    {editing && <form className="subhub-inline-form" onSubmit={event => { event.preventDefault(); void update({ label: label.trim() }); }}><label className="sr-only" htmlFor={`node-label-${node.id}`}>Machine label</label><input id={`node-label-${node.id}`} value={label} maxLength={100} onChange={event => setLabel(event.target.value)} required autoFocus /><button className="button" disabled={busy} type="submit">Save</button><button className="icon-button" type="button" aria-label="Cancel rename" onClick={() => setEditing(false)}><X size={14} /></button></form>}
    {error && <ErrorNote message={error} />}
  </article>;
}

function ConnectDialog({ space, onClose }: { space: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const idPrefix = useId();
  const [id, setId] = useState("");
  const [mode, setMode] = useState<SubhubMode>("backup");
  const [storage, setStorage] = useState("");
  const [advertise, setAdvertise] = useState("");
  const [shell, setShell] = useState<"powershell" | "sh">("powershell");
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  let command = "", error = "";
  try { command = connectCommand({ space, id, mode, storage, advertise: advertise.trim() || undefined, shell }); } catch (caught) { error = messageOf(caught); }
  return <dialog className="subhub-dialog" ref={dialog} aria-labelledby={`${idPrefix}-title`} onCancel={onClose}><div className="subhub-dialog-heading"><div><h2 id={`${idPrefix}-title`}>Connect a machine</h2><p className="quiet">Run this command on the machine that will hold the data.</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close connect dialog"><X size={18} /></button></div>
    <div className="subhub-form"><label htmlFor={`${idPrefix}-id`}>Machine ID<input id={`${idPrefix}-id`} value={id} onChange={event => setId(event.target.value)} placeholder="office-storage" maxLength={64} autoFocus /></label><label htmlFor={`${idPrefix}-mode`}>Storage mode<select id={`${idPrefix}-mode`} value={mode} onChange={event => setMode(event.target.value as SubhubMode)}><option value="backup">Backups — retain Git project history</option><option value="drive">Drive — store and share files</option></select></label><label htmlFor={`${idPrefix}-storage`}>Dedicated local storage directory<input id={`${idPrefix}-storage`} value={storage} onChange={event => setStorage(event.target.value)} placeholder={shell === "powershell" ? "D:\\Spacehub\\office-storage" : "/srv/spacehub/office-storage"} /></label>{mode === "drive" && <label htmlFor={`${idPrefix}-url`}>Node address reachable from the hub<input id={`${idPrefix}-url`} type="url" value={advertise} onChange={event => setAdvertise(event.target.value)} placeholder="https://node.example" /><span className="quiet">Configure HTTPS access to the node’s listener. An address on your own computer will not reach a different machine.</span></label>}<label htmlFor={`${idPrefix}-shell`}>Command shell<select id={`${idPrefix}-shell`} value={shell} onChange={event => setShell(event.target.value as typeof shell)}><option value="powershell">PowerShell</option><option value="sh">macOS / Linux shell</option></select></label></div>
    {command ? <CommandTabs tabs={[{ label: "spacehub", lines: [command] }]} note={<>Sign in to {location.host} with the spacehub CLI as an owner of {space} first. Keep the command running; this page updates when the machine connects.</>} /> : <p className="subhub-note">{error}</p>}
    <p className="subhub-note">Backups keep earlier snapshots even after upstream history changes. Drive files stay on the connected machine and pass through the hub when you upload or download.</p>
  </dialog>;
}

function WorkQueue({ space, me, canWrite, projects }: { space: string; me: string | null; canWrite: boolean; projects: string[] }) {
  const resource = useSubhubResource<{ work: SubhubWork[] }>(subhubUrl("/work", { space }));
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [resultFor, setResultFor] = useState("");
  const [result, setResult] = useState("");
  const items = resource.data?.work ?? [];
  const shown = items.filter(item => filter === "all" || item.status === filter).sort((a, b) => b.updatedAt - a.updatedAt);
  const action = async (item: SubhubWork, operation: "claim" | "complete" | "release") => {
    setBusy(item.id); setError("");
    try { await jsonMutation(`/work/${encodeURIComponent(item.id)}/${operation}`, operation === "claim" ? { leaseSeconds: 300 } : { fence: item.fence, ...(operation === "complete" ? { result } : {}) }); setResultFor(""); setResult(""); resource.refresh(); }
    catch (caught) { setError(messageOf(caught)); resource.refresh(); } finally { setBusy(""); }
  };
  return <><div className="subhub-section-heading subhub-heading"><div><h3>Work queue</h3><p className="quiet">Follow work from queued to received, claimed, and completed.</p></div>{canWrite && <button type="button" className="button" onClick={() => setAdding(true)}><Plus size={14} />Add work</button>}</div>
    {adding && <WorkForm space={space} projects={projects} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); resource.refresh(); }} />}
    <div className="subhub-filter"><label>Status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All work ({items.length})</option><option value="queued">Queued</option><option value="claimed">Claimed</option><option value="completed">Completed</option></select></label><button className="button" type="button" onClick={resource.refresh}><RefreshCw size={13} />Refresh</button></div>
    {(resource.error || error) && <ErrorNote message={error || resource.error} retry={resource.refresh} />}
    {resource.loading && !resource.data ? <SkeletonRows rows={3} /> : !shown.length ? <Empty icon={<ListTodo size={22} />} title="No work to show"><p>{items.length ? "Choose another status to see more work." : "Add work for this space to track its routing and progress."}</p></Empty> : <div className="subhub-work-list">{shown.map(item => <article className="subhub-work" key={item.id}><div className="subhub-heading"><div><h4>{item.title}</h4><a href={placeUrl({ space, project: item.project.split("/").pop() || item.project })} onClick={onLink}>{item.project}</a></div><span className={`label ${item.status === "completed" ? "done" : item.status === "claimed" ? "open" : ""}`}>{item.status === "claimed" && canClaim(item) ? "Lease expired" : item.status}</span></div>{item.text && <p className="subhub-work-text">{item.text}</p>}<div className="subhub-work-meta"><span>Added by {item.actor} · <Ago iso={timeOf(item.createdAt)} /></span>{item.assignedNode && <span><Server size={12} />{item.assignedNode}{item.receivedAt ? " · received" : " · assigned"}</span>}{item.worker && <span>Claimed by {item.worker}{ownsLease(item, item.worker) && item.leaseUntil ? <> · until {new Date(item.leaseUntil).toLocaleTimeString()}</> : null}</span>}</div>{item.result && <details><summary>Result</summary><p className="subhub-work-text">{item.result}</p></details>}
      {canWrite && <div className="subhub-actions">{canClaim(item) && <button className="button" type="button" disabled={busy === item.id || !!resource.error} onClick={() => void action(item, "claim")}>Claim for 5 minutes</button>}{ownsLease(item, me) && <><button className="button" type="button" disabled={busy === item.id || !!resource.error} onClick={() => { setResultFor(item.id); setResult(""); }}><Check size={13} />Complete</button><button className="button" type="button" disabled={busy === item.id || !!resource.error} onClick={() => void action(item, "release")}>Release</button></>}</div>}
      {resultFor === item.id && <form className="subhub-form" onSubmit={event => { event.preventDefault(); void action(item, "complete"); }}><label htmlFor={`work-result-${item.id}`}>Result<textarea id={`work-result-${item.id}`} value={result} onChange={event => setResult(event.target.value)} maxLength={64000} rows={3} /></label><div className="subhub-actions"><button className="button primary" type="submit" disabled={busy === item.id || !ownsLease(item, me)}>Mark completed</button><button className="button" type="button" onClick={() => setResultFor("")}>Cancel</button></div></form>}
    </article>)}</div>}
  </>;
}
function WorkForm({ space, projects, onClose, onCreated }: { space: string; projects: string[]; onClose: () => void; onCreated: () => void }) {
  const prefix = useId();
  const [project, setProject] = useState(projects[0] ?? "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Preserve the key for retries of an identical submission, including an unknown network outcome.
  const previous = useRef<{ body: string; key: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const body = { space, project, title: title.trim(), text }; const serialized = JSON.stringify(body);
    if (previous.current?.body !== serialized) previous.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try { await jsonMutation("/work", body, "POST", { "Idempotency-Key": previous.current.key }); onCreated(); }
    catch (caught) { setError(messageOf(caught)); } finally { setBusy(false); }
  };
  return <form className="subhub-form subhub-work-form" onSubmit={event => void submit(event)}><h3>Add work</h3><label htmlFor={`${prefix}-project`}>Project<select id={`${prefix}-project`} value={project} onChange={event => setProject(event.target.value)} required><option value="" disabled>Choose a project</option>{projects.map(name => <option key={name} value={name}>{name}</option>)}</select></label><label htmlFor={`${prefix}-title`}>Title<input id={`${prefix}-title`} value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required /></label><label htmlFor={`${prefix}-text`}>Instructions<textarea id={`${prefix}-text`} value={text} onChange={event => setText(event.target.value)} maxLength={20000} rows={4} required /></label>{error && <ErrorNote message={error} />}<div className="subhub-actions"><button className="button primary" disabled={busy || !project || !title.trim() || !text.trim()} type="submit">{busy ? "Adding…" : "Add to queue"}</button><button className="button" type="button" onClick={onClose} disabled={busy}>Cancel</button></div></form>;
}

function Drive({ space, nodes, unavailable, canWrite }: { space: string; nodes: SubhubNode[]; unavailable: boolean; canWrite: boolean }) {
  const [selected, setSelected] = useState("");
  const [prefix, setPrefix] = useState("");
  const [appliedPrefix, setAppliedPrefix] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState("");
  const drives = nodes.filter(node => node.mode === "drive");
  const node = drives.find(item => item.id === selected) ?? drives.find(nodeReady) ?? drives[0];
  const ready = !!node && nodeReady(node) && !unavailable;
  const resource = useSubhubResource<{ files: DriveFile[]; stats: DriveStats }>(ready ? subhubUrl("/drive/files", { space, node: node.id, prefix: appliedPrefix }) : undefined);
  const allFiles = resource.data?.files ?? [];
  const shown = allFiles.filter(item => item.path.startsWith(appliedPrefix)).sort((a, b) => a.path.localeCompare(b.path));
  const existing = allFiles.find(item => item.path === path);
  const download = async (item: DriveFile) => {
    if (!node || !ready || resource.error) return;
    setDownloading(item.path); setError("");
    try {
      const blob = await driveDownload(subhubUrl("/drive/file", { space, node: node.id, path: item.path }));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = item.path.split("/").pop() || "download";
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setDownloading(""); }
  };
  const upload = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setNotice("");
    if (!file || !node || !ready || resource.loading || resource.error || !resource.data) return;
    if (!validDrivePath(path)) { setError("Use a relative file path without empty, dot or parent-directory segments."); return; }
    if (file.size > MAX_DRIVE_FILE_BYTES) { setError("Drive files can be up to 16 MiB."); return; }
    setBusy(true);
    try { await subhubRequest(subhubUrl("/drive/file", { space, node: node.id, path }), { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...driveHeaders(existing) }, body: file }); setNotice(`${path} ${existing ? "replaced" : "uploaded"}.`); setFile(null); setPath(""); if (input.current) input.current.value = ""; resource.refresh(); }
    catch (caught) { setError(messageOf(caught)); resource.refresh(); } finally { setBusy(false); }
  };
  return <><div className="subhub-section-heading"><h3>Drive</h3><p className="quiet">Files live on the selected machine. Upload and download through this hub while it is connected.</p></div>{!drives.length ? <Empty icon={<HardDrive size={22} />} title="No drive connected"><p>A space owner can connect a machine in Drive mode with an HTTPS address reachable from the hub.</p></Empty> : <>
    <div className="subhub-filter"><label>Machine<select value={node?.id ?? ""} disabled={busy || !!downloading} onChange={event => { setSelected(event.target.value); setFile(null); setPath(""); setError(""); setNotice(""); if (input.current) input.current.value = ""; }}>{drives.map(item => <option key={item.id} value={item.id}>{item.label || item.id} · {unavailable ? "Unavailable" : nodeState(item)}</option>)}</select></label><button className="button" type="button" disabled={!ready} onClick={resource.refresh}><RefreshCw size={13} />Refresh</button></div>
    {!ready && <ErrorNote message={!node?.enabled ? "This drive is paused. A space owner can enable it in Overview." : "This drive is offline or unavailable. Files will be available when the machine reconnects."} />}
    {ready && node.status === "degraded" && <p className="subhub-replace-note">This machine reported an issue. Review its status in Overview.</p>}
    {resource.error && <ErrorNote message={resource.error} retry={resource.refresh} />}
    {error && <ErrorNote message={error} />}
    {ready && <>
      <form className="subhub-inline-form subhub-drive-search" onSubmit={event => { event.preventDefault(); setAppliedPrefix(prefix); }}><label className="sr-only" htmlFor="drive-prefix">Filter file paths</label><input id="drive-prefix" value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="Filter by folder or file prefix…" /><button className="button" type="submit">Filter</button></form>
      {resource.loading && !resource.data ? <SkeletonRows rows={3} /> : shown.length ? <div className="subhub-table-wrap"><table className="subhub-table"><thead><tr><th>File</th><th>Size</th><th>Updated</th><th><span className="sr-only">Download</span></th></tr></thead><tbody>{shown.map(item => <tr key={item.path}><td><span className="subhub-file-path">{item.path}</span><span className="subhub-cell-note mono" title={item.sha256}>{item.sha256.slice(0, 12)}</span></td><td>{size(item.size)}</td><td><Ago iso={timeOf(item.updatedAt)} /></td><td><button className="button" type="button" onClick={() => void download(item)} disabled={!!downloading || !!resource.error} aria-label={`Download ${item.path}`}><ArrowDownToLine size={14} />{downloading === item.path ? "Downloading…" : null}</button></td></tr>)}</tbody></table></div> : !resource.error && <Empty icon={<HardDrive size={20} />} title={appliedPrefix ? "No files match this prefix" : "This drive is empty"}><p>{canWrite ? "Upload a file to store it on this machine." : "Files shared with this space will appear here."}</p></Empty>}
      {canWrite && <form className="subhub-form subhub-upload" onSubmit={event => void upload(event)}><h3>Upload a file</h3><label htmlFor="drive-upload">File <span className="quiet">up to 16 MiB</span><input id="drive-upload" type="file" ref={input} disabled={busy} onChange={event => { const next = event.target.files?.[0] ?? null; setFile(next); setPath(next ? (appliedPrefix.endsWith("/") ? appliedPrefix : "") + next.name : ""); setError(next && next.size > MAX_DRIVE_FILE_BYTES ? "Drive files can be up to 16 MiB." : ""); setNotice(""); }} /></label><label htmlFor="drive-upload-path">Path on this drive<input id="drive-upload-path" value={path} onChange={event => { setPath(event.target.value); setError(""); setNotice(""); }} placeholder="folder/filename.ext" required disabled={busy} /></label>{existing && <p className="subhub-replace-note">A file already exists at this path ({size(existing.size)}). Replacing it updates this drive file.</p>}{notice && <p className="subhub-success" role="status"><Check size={14} />{notice}</p>}<button className="button primary" type="submit" disabled={busy || !file || !validDrivePath(path) || file.size > MAX_DRIVE_FILE_BYTES || resource.loading || !!resource.error || !resource.data}>{busy ? "Uploading…" : existing ? "Replace existing file" : "Upload file"}</button></form>}
    </>}
  </>}</>;
}
function SubhubRecentActivity({ space }: { space: string }) {
  const resource = useSubhubActivity(space);
  if (!resource.items.length) return null;
  return <section className="subhub-recent"><h3>Recent sub-hub activity</h3><ol>{resource.items.slice(0, 8).map(item => <li key={item.id}><span className="subhub-event-icon"><Server size={14} /></span><div><strong>{item.nodeId || item.actor || space}</strong> <span>{item.kind.replace(/_/g, " ")}</span>{(item.text || item.subject) && <p>{item.text || item.subject}</p>}</div><Ago iso={timeOf(item.at)} /></li>)}</ol></section>;
}
