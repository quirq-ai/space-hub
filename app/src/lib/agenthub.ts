// Agenthub's sessions as the app shows them: tasks on the Agents Hub, read
// through the web service (/-/api/agenthub, cli/src/agenthub.ts), and their
// events folded into a thread of messages, steps, links and notes.
//
// The Agents Hub's event kinds: user · message · thinking · tool / tool_done ·
// command / command_done · link · env · status · turn · note · error.

export type AgentHubStatus = { enabled: boolean; signedIn: boolean; allowed: boolean; builder: string | null };
export type TaskStatus = "running" | "ending" | "done" | "stopped" | "failed" | string;
export type Task = { id: string; title: string; status: TaskStatus; repo: string; createdAt: string; updatedAt: string };
export type TaskResult = { summary: string; links: { label: string; url: string }[]; error: string };
export type TaskEvent = Record<string, unknown> & { seq?: number; kind?: string };

export type Step = { id: string; kind: "tool" | "command" | "thinking"; label: string; detail: string; output: string; state: "run" | "ok" | "fail"; exit: number | null };
export type ThreadItem =
  | { type: "user"; key: string; text: string; ts: string }
  | { type: "agent"; key: string; text: string; ts: string }
  | { type: "steps"; key: string; steps: Step[]; open: boolean }
  | { type: "link"; key: string; url: string; label: string }
  | { type: "note"; key: string; text: string; tone: "" | "ok" | "warn" | "err" | "done" };

const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One task from whatever shape the Agents Hub answers with. */
export function toTask(value: unknown): Task | null {
  if (!obj(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    title: str(value.title) || "Untitled session",
    status: str(value.status) || "running",
    repo: str(value.repo),
    createdAt: str(value.createdAt ?? value.created_at),
    updatedAt: str(value.updatedAt ?? value.updated_at ?? value.lastActivityAt ?? value.createdAt ?? value.created_at),
  };
}

/** GET /tasks: a list, or {tasks: [...]}; newest activity first. */
export function toTasks(value: unknown): Task[] {
  const list = Array.isArray(value) ? value : obj(value) && Array.isArray(value.tasks) ? value.tasks : [];
  return list.map(toTask).filter((task): task is Task => !!task).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

/** GET /tasks/<id>: {task, result}, or the task itself. */
export function toDetail(value: unknown): { task: Task | null; result: TaskResult } {
  const task = toTask(obj(value) && obj(value.task) ? value.task : value);
  const raw = obj(value) && obj(value.result) ? value.result : {};
  const links = Array.isArray(raw.links) ? raw.links.map(link => (typeof link === "string" ? { label: "", url: link } : obj(link) ? { label: str(link.label ?? link.title), url: str(link.url ?? link.href) } : null)).filter((link): link is { label: string; url: string } => !!link && /^https:\/\//.test(link.url)) : [];
  return { task, result: { summary: str(raw.summary), links, error: str(raw.error) } };
}

/** GET /tasks/<id>/events: a list, or {events, next}; where to read from next time. */
export function toEvents(value: unknown, after: number): { events: TaskEvent[]; next: number } {
  // An event at or before `after` was read already, even if the answer repeats it.
  const list = ((Array.isArray(value) ? value : obj(value) && Array.isArray(value.events) ? value.events : []).filter(obj) as TaskEvent[])
    .filter(event => !(Number(event.seq) <= after));
  const seqs = list.map(event => Number(event.seq)).filter(Number.isFinite);
  const given = obj(value) ? Number(value.next) : NaN;
  const next = Number.isFinite(given) && given >= after ? given : Math.max(after, ...seqs);
  return { events: list, next };
}

export const isRunning = (status: TaskStatus) => status === "running" || status === "ending";

export function statusLabel(status: TaskStatus): string {
  return status === "running" ? "Running" : status === "ending" ? "Finishing" : status === "done" ? "Done" : status === "stopped" ? "Stopped" : status === "failed" ? "Failed" : status;
}

/** "github.com/owner/repo/pull/12" as "owner/repo#12". */
export function linkLabel(url: string): string {
  const pull = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  return pull ? `${pull[1]}#${pull[2]}` : url.replace(/^https:\/\/(github\.com\/)?/, "");
}

/**
 * Events as a thread: what people and the agent said, each stretch of work
 * as one group of steps (open while it runs), links, and notes. Replays of
 * an event already seen (same seq) are skipped.
 */
export function foldEvents(events: TaskEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const seen = new Set<number>();
  const steps = new Map<string, Step>();
  let group: Extract<ThreadItem, { type: "steps" }> | null = null;
  const end = () => { if (group) group.open = false; group = null; };
  const note = (key: string, text: string, tone: Extract<ThreadItem, { type: "note" }>["tone"] = "") => items.push({ type: "note", key, text, tone });
  events.forEach((event, index) => {
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) { if (seen.has(seq)) return; seen.add(seq); }
    const key = Number.isFinite(seq) ? `e${seq}` : `i${index}`;
    const kind = str(event.kind);
    const step = (made: Step) => {
      if (!group) { group = { type: "steps", key, steps: [], open: true }; items.push(group); }
      group.steps.push(made);
      if (made.id) steps.set(made.id, made);
    };
    const finish = (ok: boolean, output: unknown, exit: number | null) => {
      const found = steps.get(str(event.id));
      if (!found) return;
      found.state = ok ? "ok" : "fail";
      found.output = str(output).trim();
      found.exit = exit;
    };
    switch (kind) {
      case "user": end(); items.push({ type: "user", key, text: str(event.text), ts: str(event.ts) }); break;
      case "message": end(); items.push({ type: "agent", key, text: str(event.text), ts: str(event.ts) }); break;
      case "thinking": step({ id: "", kind: "thinking", label: str(event.text) || "Thinking", detail: "", output: "", state: "ok", exit: null }); break;
      case "tool": step({ id: str(event.id), kind: "tool", label: `${str(event.server) ? `${str(event.server)} · ` : ""}${str(event.name) || "tool"}`, detail: str(event.args), output: "", state: "run", exit: null }); break;
      case "command": step({ id: str(event.id), kind: "command", label: str(event.command), detail: "", output: "", state: "run", exit: null }); break;
      case "tool_done": finish(event.ok !== false, event.output, null); break;
      case "command_done": {
        const exit = typeof event.exitCode === "number" ? event.exitCode : null;
        finish(exit === null || exit === 0, event.output, exit);
        break;
      }
      case "link": {
        const url = str(event.url);
        if (/^https:\/\//.test(url)) { end(); items.push({ type: "link", key, url, label: str(event.label) }); }
        break;
      }
      case "env": {
        const state = str(event.state);
        const message = str(event.message);
        if (state === "connected") note(key, "Sandbox connected.", "ok");
        else if (state === "pending") note(key, "Waiting for the sandbox to connect…");
        else if (state === "failed") note(key, `Sandbox failed${message ? `: ${message}` : "."}`, "err");
        else note(key, state === "expired" ? "Sandbox expired." : "Sandbox disconnected.", "warn");
        break;
      }
      case "turn": {
        end();
        const state = str(event.state);
        if (state === "completed") note(key, "Done", "done");
        else if (state === "cancelled") note(key, "Stopped.", "warn");
        else note(key, `The turn failed${str(event.error) ? `: ${str(event.error)}` : "."}`, "err");
        break;
      }
      case "note": note(key, str(event.text)); break;
      case "error": end(); note(key, str(event.text) || "Something went wrong.", "err"); break;
      default: break;
    }
  });
  return items;
}

/** A task's text without the line crediting who started it (cli/src/agenthub.ts adds it). */
export function withoutCredit(text: string): string {
  return text.replace(/\n*\(Started from spacehub by [a-z0-9-]+\.\)\s*$/i, "");
}

/** A fresh key, so a retried start or follow-up is not run twice. */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** A write to the web service; its error message when it fails. */
export async function send(method: "POST" | "DELETE", path: string, body?: unknown, key?: string): Promise<unknown> {
  const response = await fetch("/-/api/agenthub" + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* Empty or not JSON. */ }
  if (!response.ok) throw new Error(obj(data) && typeof data.error === "string" ? data.error : `That did not work (${response.status}).`);
  return data;
}
