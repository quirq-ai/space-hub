// Live requests from the hub to a connected sub-hub machine, for its page at
// /subhub/<name>. A sub-hub usually sits behind NAT, so the hub cannot call
// it: the machine keeps one request open (poll), the hub hands it whatever a
// recovery operator asked for (ask), and the machine posts the answer back
// (answer), which goes to the waiting operator. Read-only questions about the
// machine's own storage only (instanceruntime.ts answers them); nothing here
// reaches orgs, projects or agents.
import crypto from 'node:crypto';

export type RelayOp = 'storage' | 'snapshot' | 'verify';
export interface RelayRequest { id: string; op: RelayOp; snapshot?: string }

interface Waiting {
  connection: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const SNAPSHOT = /^[a-f0-9]{32}$/;
const MAX_QUEUED = 32;

export class RelayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SubhubRelay {
  private queued = new Map<string, RelayRequest[]>(); // per connection, not yet handed over
  private polls = new Map<string, (requests: RelayRequest[]) => void>(); // a machine waiting for work
  private waiting = new Map<string, Waiting>(); // per request, an operator waiting for the answer

  /** Ask a machine something; the answer, or a RelayError when it does not come in time. */
  ask(connection: string, op: RelayOp, snapshot: string | undefined, timeoutMs: number): Promise<unknown> {
    if (snapshot !== undefined && !SNAPSHOT.test(snapshot)) throw new RelayError(400, 'Choose a backup by its id');
    const queue = this.queued.get(connection) ?? [];
    if (queue.length >= MAX_QUEUED) throw new RelayError(429, 'This sub-hub has too many questions waiting; try again shortly');
    const request: RelayRequest = { id: crypto.randomBytes(16).toString('hex'), op, ...(snapshot ? { snapshot } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(request.id);
        const left = this.queued.get(connection)?.filter(item => item.id !== request.id);
        if (left) this.queued.set(connection, left);
        reject(new RelayError(504, 'The sub-hub did not answer in time; it may be busy or offline'));
      }, timeoutMs);
      this.waiting.set(request.id, { connection, resolve, reject, timer });
      const poll = this.polls.get(connection);
      if (poll) {
        this.polls.delete(connection);
        poll([request]);
      } else {
        queue.push(request);
        this.queued.set(connection, queue);
      }
    });
  }

  /** A machine's open request: what was asked of it, or nothing after `waitMs`. */
  poll(connection: string, waitMs: number): Promise<RelayRequest[]> {
    const queue = this.queued.get(connection);
    if (queue?.length) {
      this.queued.delete(connection);
      return Promise.resolve(queue);
    }
    // A newer poll from the same machine replaces an older one.
    this.polls.get(connection)?.([]);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.polls.get(connection) === done) this.polls.delete(connection);
        resolve([]);
      }, waitMs);
      const done = (requests: RelayRequest[]) => {
        clearTimeout(timer);
        resolve(requests);
      };
      this.polls.set(connection, done);
    });
  }

  /** A machine's answer to one of its own requests. */
  answer(connection: string, request: string, body: { result?: unknown; error?: unknown }) {
    const waiting = this.waiting.get(request);
    if (!waiting || waiting.connection !== connection) throw new RelayError(404, 'No such question for this sub-hub');
    this.waiting.delete(request);
    clearTimeout(waiting.timer);
    if (typeof body.error === 'string') waiting.reject(new RelayError(502, `The sub-hub could not answer: ${body.error.slice(0, 300)}`));
    else waiting.resolve(body.result);
  }
}
