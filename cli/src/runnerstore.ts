// Where the web service keeps each person's runners and the workers launched from chats: the module's private
// `runner` and `worker` tables, read over the hub admin's SQL and written through its admin-only reducers
// (admin.ts), like github_account. A Runner never carries its token; sealedTokenOf is the only way to it.
// memoryStore is the same behaviour in memory, for tests.
// How a runner was connected (`via`: a pasted token, or the Connect button) rides in the same JSON column as its
// capabilities, so Disconnect knows whether the token is space-hub's to revoke, without a schema change.
import { call, select, type AdminHttp } from './admin.ts';
import { capabilitiesOf, type Capabilities } from './workerclient.ts';

export type Via = 'paste' | 'connect';
export type Runner = {
  id: string; owner: string; name: string; kind: string; url: string; capabilities: Capabilities; via: Via;
  isDefault: boolean; connectedAt: string; checkedAt: string;
};
export type WorkerResult = { summary: string | null; links: string[]; error: string | null };
export type Worker = {
  taskId: string; runnerId: string; runnerUrl: string; launcher: string; space: string; project: string;
  conversation: string; title: string; status: string; result: WorkerResult | null; createdAt: string; updatedAt: string;
};
export type NewRunner = { id: string; owner: string; name: string; kind: string; url: string; sealedToken: string; capabilities: Capabilities; via: Via; isDefault: boolean };
export type NewWorker = { taskId: string; runnerId: string; runnerUrl: string; launcher: string; space: string; project: string; conversation: string; title: string };

export interface RunnerStore {
  listRunners(owner: string): Promise<Runner[]>;
  getRunner(id: string): Promise<Runner | null>;
  runnerAt(owner: string, url: string): Promise<Runner | null>;
  sealedTokenOf(id: string): Promise<string | null>;
  addRunner(r: NewRunner): Promise<void>;
  /** New capabilities need `via` too: they are written together. */
  updateRunner(id: string, patch: { name?: string; sealedToken?: string; capabilities?: Capabilities; via?: Via; isDefault?: boolean; checked?: boolean }): Promise<void>;
  deleteRunner(id: string): Promise<void>;
  listWorkers(filter: { launcher: string }): Promise<Worker[]>;
  getWorker(taskId: string): Promise<Worker | null>;
  addWorker(w: NewWorker): Promise<void>;
  updateWorker(taskId: string, patch: { status?: string; result?: WorkerResult; runnerId?: string }): Promise<void>;
}

// Every value that reaches SQL is checked against its shape first.
export const RUNNER_ID = /^[a-f0-9]{16}$/;
export const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const URLISH = /^https?:\/\/[^\s'"\\]{1,300}$/;
function checked(value: string, shape: RegExp, what: string) {
  if (typeof value !== 'string' || !shape.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

function iso(v: unknown): string {
  const micros = typeof v === 'number' || typeof v === 'bigint' ? Number(v)
    : Array.isArray(v) ? Number(v[0])
    : v && typeof v === 'object' ? Number(Object.values(v as object)[0])
    : NaN;
  return Number.isFinite(micros) ? new Date(micros / 1000).toISOString() : '';
}

function resultOf(raw: unknown): WorkerResult | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      summary: typeof v.summary === 'string' ? v.summary : null,
      links: Array.isArray(v.links) ? v.links.filter((l): l is string => typeof l === 'string') : [],
      error: typeof v.error === 'string' ? v.error : null,
    };
  } catch {
    return null;
  }
}

const RUNNER_COLUMNS = 'id, owner, name, kind, url, capabilities, is_default, connected_at, checked_at';
const metaOf = (capabilities: Capabilities, via: Via) => JSON.stringify({ ...capabilities, via });
function toRunner(row: Record<string, unknown>): Runner {
  let caps: Record<string, unknown> = {};
  try { caps = JSON.parse(String(row.capabilities ?? '{}')); } catch { /* none */ }
  return {
    id: String(row.id), owner: String(row.owner), name: String(row.name), kind: String(row.kind), url: String(row.url),
    capabilities: capabilitiesOf(caps), via: caps.via === 'connect' ? 'connect' : 'paste',
    isDefault: row.is_default === true, connectedAt: iso(row.connected_at), checkedAt: iso(row.checked_at),
  };
}
function toWorker(row: Record<string, unknown>): Worker {
  return {
    taskId: String(row.task_id), runnerId: String(row.runner_id), runnerUrl: String(row.runner_url), launcher: String(row.launcher),
    space: String(row.space), project: String(row.project), conversation: String(row.conversation), title: String(row.title),
    status: String(row.status), result: resultOf(row.result), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function adminStore(cfg: AdminHttp): RunnerStore {
  const runnersWhere = async (where: string) => (await select(cfg, `SELECT ${RUNNER_COLUMNS} FROM runner WHERE ${where}`)).map(toRunner);
  return {
    listRunners: async owner => runnersWhere(`owner = ${q(checked(owner, USERNAME, 'username'))}`),
    getRunner: async id => (await runnersWhere(`id = ${q(checked(id, RUNNER_ID, 'runner id'))}`))[0] ?? null,
    runnerAt: async (owner, url) =>
      (await runnersWhere(`owner = ${q(checked(owner, USERNAME, 'username'))} AND url = ${q(checked(url, URLISH, 'address'))}`))[0] ?? null,
    async sealedTokenOf(id) {
      const [row] = await select(cfg, `SELECT sealed_token FROM runner WHERE id = ${q(checked(id, RUNNER_ID, 'runner id'))}`);
      return row ? String(row.sealed_token) : null;
    },
    async addRunner(r) {
      checked(r.id, RUNNER_ID, 'runner id'); checked(r.owner, USERNAME, 'username'); checked(r.url, URLISH, 'address');
      await call(cfg, 'runner_add', [r.id, r.owner, r.name, r.kind, r.url, r.sealedToken, metaOf(r.capabilities, r.via), r.isDefault]);
    },
    async updateRunner(id, p) {
      await call(cfg, 'runner_update', [checked(id, RUNNER_ID, 'runner id'), p.name ?? '', p.sealedToken ?? '',
        p.capabilities ? metaOf(p.capabilities, p.via ?? 'paste') : '', p.isDefault === true, p.checked === true]);
    },
    async deleteRunner(id) { await call(cfg, 'runner_delete', [checked(id, RUNNER_ID, 'runner id')]); },
    listWorkers: async ({ launcher }) =>
      (await select(cfg, `SELECT * FROM worker WHERE launcher = ${q(checked(launcher, USERNAME, 'username'))}`)).map(toWorker),
    async getWorker(taskId) {
      const [row] = await select(cfg, `SELECT * FROM worker WHERE task_id = ${q(checked(taskId, TASK_ID, 'task id'))}`);
      return row ? toWorker(row) : null;
    },
    async addWorker(w) {
      checked(w.taskId, TASK_ID, 'task id'); checked(w.runnerId, RUNNER_ID, 'runner id'); checked(w.launcher, USERNAME, 'username');
      await call(cfg, 'worker_add', [w.taskId, w.runnerId, w.runnerUrl, w.launcher, w.space, w.project, w.conversation, w.title]);
    },
    async updateWorker(taskId, p) {
      await call(cfg, 'worker_update', [checked(taskId, TASK_ID, 'task id'), p.status ?? '', p.result ? JSON.stringify(p.result) : '',
        p.runnerId ? checked(p.runnerId, RUNNER_ID, 'runner id') : '']);
    },
  };
}

export function memoryStore(): RunnerStore {
  const runners = new Map<string, NewRunner & { connectedAt: string; checkedAt: string }>();
  const workers = new Map<string, Worker>();
  const now = () => new Date().toISOString();
  const view = ({ sealedToken: _s, ...r }: NewRunner & { connectedAt: string; checkedAt: string }): Runner => ({ ...r, capabilities: { ...r.capabilities } });
  const soleDefault = (owner: string, id: string) => { for (const r of runners.values()) if (r.owner === owner && r.id !== id) r.isDefault = false; };
  return {
    listRunners: async owner => [...runners.values()].filter(r => r.owner === owner).map(view),
    getRunner: async id => (runners.has(id) ? view(runners.get(id)!) : null),
    runnerAt: async (owner, url) => { const r = [...runners.values()].find(x => x.owner === owner && x.url === url); return r ? view(r) : null; },
    sealedTokenOf: async id => runners.get(id)?.sealedToken ?? null,
    async addRunner(r) {
      if (runners.has(r.id)) throw new Error(`runner ${r.id} exists`);
      const isDefault = r.isDefault || ![...runners.values()].some(x => x.owner === r.owner);
      if (isDefault) soleDefault(r.owner, r.id);
      runners.set(r.id, { ...r, isDefault, connectedAt: now(), checkedAt: now() });
    },
    async updateRunner(id, p) {
      const r = runners.get(id);
      if (!r) throw new Error(`no runner ${id}`);
      if (p.isDefault) { soleDefault(r.owner, id); r.isDefault = true; }
      if (p.name) r.name = p.name;
      if (p.sealedToken) r.sealedToken = p.sealedToken;
      if (p.capabilities) { r.capabilities = p.capabilities; r.via = p.via ?? 'paste'; }
      if (p.checked) r.checkedAt = now();
    },
    async deleteRunner(id) {
      const r = runners.get(id);
      if (!r) return;
      runners.delete(id);
      const rest = [...runners.values()].filter(x => x.owner === r.owner);
      if (r.isDefault && rest.length && !rest.some(x => x.isDefault)) rest[0].isDefault = true;
    },
    listWorkers: async ({ launcher }) => [...workers.values()].filter(w => w.launcher === launcher).map(w => ({ ...w })),
    getWorker: async taskId => (workers.has(taskId) ? { ...workers.get(taskId)! } : null),
    async addWorker(w) {
      if (workers.has(w.taskId)) throw new Error(`worker ${w.taskId} exists`);
      workers.set(w.taskId, { ...w, status: 'running', result: null, createdAt: now(), updatedAt: now() });
    },
    async updateWorker(taskId, p) {
      const w = workers.get(taskId);
      if (!w) throw new Error(`no worker ${taskId}`);
      if (p.status) w.status = p.status;
      if (p.result) w.result = p.result;
      if (p.runnerId) w.runnerId = p.runnerId;
      w.updatedAt = now();
    },
  };
}
