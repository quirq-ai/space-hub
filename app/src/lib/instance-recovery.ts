export const INSTANCE_RECOVERY_API = "/-/api/instance-recovery";
export type InstanceCoverage = { data: boolean; runtime: boolean; configuration: boolean };
/** A stopped Docker deployment captured whole, or the hub's own copy of its data made while it runs. */
export type InstanceConsistency = "stopped-containers" | "live-copy";
export type InstanceSnapshot = {
  id: string; createdAt: number; source: string; services: string[]; scope: "instance";
  consistency: InstanceConsistency; coverage: InstanceCoverage; files: number; bytes: number; sha256: string;
};
export type InstanceRecoveryStatus = {
  scope: "instance"; source: string; available: boolean; canManage: boolean;
  cli: { storage: string; restoreRoot: string }; error?: string;
  sourceAvailable?: boolean; sourceError?: string; machineName?: string;
};
export type InstanceConnection = {
  id: string; name: string; connectedAt: number; lastSeen: number; online: boolean;
  state: "waiting" | "syncing" | "up-to-date" | "error"; snapshots: InstanceSnapshot[]; error?: string;
};
export type InstanceVerification = { snapshot: InstanceSnapshot; files: number; bytes: number; verifiedAt: number };
export type InstanceRestore = { directory: string; snapshot: InstanceSnapshot; files: number; bytes: number };
export type CommandShell = "powershell" | "sh";

function argument(value: string, shell: CommandShell) {
  if (!value.trim() || /[\r\n\u0000]/.test(value)) throw new Error("Enter a path or value without line breaks.");
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : "'" + (shell === "powershell" ? value.replace(/'/g, "''") : value.replace(/'/g, "'\"'\"'")) + "'";
}
function snapshotId(id: string) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Choose a valid full-instance backup."); return id; }
export function instanceRunCommand({ storage, name, interval, shell = "powershell" }: { storage: string; name?: string; interval?: number; shell?: CommandShell }) {
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 1)) throw new Error("Use a positive whole number of seconds for the backup interval.");
  const args = ["spacehub subhub run", `--storage ${argument(storage, shell)}`];
  if (name !== undefined) args.push(`--name ${argument(name, shell)}`);
  if (interval !== undefined) args.push(`--interval ${interval}`);
  return args.join(" ");
}
export function instanceBackupCommand(storage: string, shell: CommandShell = "powershell") { return `spacehub subhub backup --storage ${argument(storage, shell)}`; }
export function instanceSnapshotsCommand(storage: string, shell: CommandShell = "powershell") { return `spacehub subhub snapshots --storage ${argument(storage, shell)}`; }
export function instanceVerifyCommand(id: string, storage: string, shell: CommandShell = "powershell") { return `spacehub subhub verify ${snapshotId(id)} --storage ${argument(storage, shell)}`; }
export function instanceRestoreBody(id: string, directory: string) {
  snapshotId(id);
  if (!directory.trim() || /[\r\n\u0000]/.test(directory)) throw new Error("Enter a new restore directory.");
  return { id, directory: directory.trim() };
}
export function instanceRestoreCommand(id: string, directory: string, storage: string, shell: CommandShell = "powershell") {
  const body = instanceRestoreBody(id, directory);
  return `spacehub subhub restore ${body.id} ${argument(body.directory, shell)} --storage ${argument(storage, shell)}`;
}
export function instanceRemoteRestoreCommand(id: string) { return `spacehub subhub restore ${snapshotId(id)} <new-directory> --storage <folder>`; }
export function instanceConnectionLabel(connection: InstanceConnection) {
  if (!connection.online) return "Offline";
  return { waiting: "Waiting for source", syncing: "Backing up", "up-to-date": "Up to date", error: "Needs attention" }[connection.state];
}
export function latestInstanceSnapshot(snapshots: InstanceSnapshot[]) { return snapshots.reduce<InstanceSnapshot | undefined>((latest, snapshot) => !latest || snapshot.createdAt > latest.createdAt ? snapshot : latest, undefined); }
export function instanceErrorMessage(status: number, detail?: string) {
  if (status === 401 || status === 403) return "Full-instance recovery requires permission from the operator of this Spacehub server.";
  if (status === 404) return "Full-instance recovery is not available or configured on this server.";
  if (status === 409) return detail || "The destination already exists or this backup changed. Choose a new directory and try again.";
  if (status === 503 || status === 502 || status === 504) return detail || "The local full-instance backup vault is unavailable.";
  return detail || (status ? `The full-instance recovery request failed (${status}).` : "Cannot reach full-instance recovery. Check the server connection and try again.");
}
export async function instanceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(INSTANCE_RECOVERY_API + path, { credentials: "same-origin", cache: "no-store", ...init }); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; throw new Error(instanceErrorMessage(0)); }
  let body: unknown;
  try { body = await response.json(); } catch { /* An older server may return an HTML 404. */ }
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
    throw new Error(instanceErrorMessage(response.status, detail));
  }
  if (!body || typeof body !== "object") throw new Error("The server returned an unreadable full-instance recovery response.");
  return body as T;
}
export function instancePost<T>(path: string, body: unknown = {}) {
  return instanceRequest<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
