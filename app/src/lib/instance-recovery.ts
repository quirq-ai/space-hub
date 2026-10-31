export const INSTANCE_RECOVERY_API = "/-/api/instance-recovery";
export type InstanceCoverage = { data: true; runtime: true; configuration: true };
export type InstanceSnapshot = {
  id: string; createdAt: number; source: string; services: string[]; scope: "instance";
  consistency: "stopped-containers"; coverage: InstanceCoverage; files: number; bytes: number; sha256: string;
};
export type InstanceRecoveryStatus = {
  scope: "instance"; source: string; available: boolean; canManage: boolean;
  cli: { containers: string[]; storage: string; restoreRoot: string }; error?: string;
};
export type InstanceVerification = { snapshot: InstanceSnapshot; files: number; bytes: number; verifiedAt: number };
export type InstanceRestore = { directory: string; snapshot: InstanceSnapshot; files: number; bytes: number };
export type CommandShell = "powershell" | "sh";

function argument(value: string, shell: CommandShell) {
  if (!value.trim() || /[\r\n\u0000]/.test(value)) throw new Error("Enter a path or value without line breaks.");
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : "'" + (shell === "powershell" ? value.replace(/'/g, "''") : value.replace(/'/g, "'\"'\"'")) + "'";
}
function snapshotId(id: string) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Choose a valid full-instance backup."); return id; }
export function instanceBackupCommand({ containers, storage, shell = "powershell" }: { containers: string[]; storage: string; shell?: CommandShell }) {
  if (!containers.length || containers.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))) throw new Error("Enter the Docker container names, one per line.");
  return ["spacehub subhub backup", ...containers.map(name => `--container ${argument(name, shell)}`), `--storage ${argument(storage, shell)}`, "--allow-stop"].join(" ");
}
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
