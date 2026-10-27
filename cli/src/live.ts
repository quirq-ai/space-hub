// Live pages for the web UI, served by the web service:
//
//   GET /-/live.js              the page script (no inline code, so the CSP stays strict)
//   GET /-/live?path=<page>     Server-Sent Events: the page's new <main> on every change
//
// The service keeps one subscription to the hub's small tables (builders,
// spaces and their members, projects, refs, collaborators, presence,
// imports, builder credits). When rows behind a
// page change, it renders that page again on the server, through the
// module's own UI route, and streams the result; live.js swaps it in. The
// browser only ever talks to this service, never to SpacetimeDB.
import http from 'node:http';
import { connectTo, errorMessage, tables, type Conn } from './conn';
import { LIVE_JS, liveTopic, pageParts } from './livepage';

const MAX_CLIENTS = 500;
const DEBOUNCE_MS = 250;
const PING_MS = 25_000;
const RENDER_TIMEOUT_MS = 15_000;

interface Client {
  res: http.ServerResponse;
  path: string;
  topic: string;
  headers: Record<string, string>;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  again: boolean;
  closed: boolean;
  last: string;
}

export interface LiveConfig {
  server: string; // websocket address of SpacetimeDB
  db: string;
  http: string; // its HTTP address, where the module's UI route answers
}

export class LiveHub {
  private config: LiveConfig;
  private conn: Conn | null = null;
  private clients = new Set<Client>();
  private projectsById = new Map<bigint, { fullName: string; owner: string }>();
  private renders = new Map<string, Promise<string | null>>();

  constructor(config: LiveConfig) {
    this.config = config;
  }

  // Connect in the background, retrying until SpacetimeDB answers; the SDK
  // then reconnects by itself and replays the subscription.
  start() {
    const attempt = () =>
      this.connect().catch(err => {
        process.stderr.write(`spacehub-web: live updates: ${errorMessage(err)}; retrying\n`);
        setTimeout(attempt, 3000);
      });
    void attempt();
  }

  private async connect() {
    const { conn } = await connectTo(this.config.server, this.config.db, undefined, { reconnect: true });
    this.conn = conn;
    const db = conn.db;
    const live = (ctx: { event: { tag: string } }) => ctx.event.tag !== 'SubscribeApplied' && ctx.event.tag !== 'UnsubscribeApplied';
    const project = (id: bigint) => this.projectsById.get(id);
    const forProject = (id: bigint, ...more: string[]) => {
      const sp = project(id);
      this.touch(['hub', ...(sp ? [`project:${sp.fullName}`, `space:${sp.owner}`] : []), ...more]);
    };
    const remember = (r: { id: bigint; fullName: string; owner: string }) => this.projectsById.set(r.id, { fullName: r.fullName, owner: r.owner });

    db.project.onInsert((ctx, r) => {
      remember(r);
      if (live(ctx)) forProject(r.id);
    });
    // A push's object uploads only move counters; wait for the ref.
    db.project.onUpdate((_ctx, old, r) => {
      remember(r);
      if (old.description !== r.description || old.defaultBranch !== r.defaultBranch || old.pushedAt.microsSinceUnixEpoch !== r.pushedAt.microsSinceUnixEpoch) forProject(r.id);
    });
    // The name stays known for rows of the same project that go with it.
    db.project.onDelete((ctx, r) => {
      if (live(ctx)) forProject(r.id);
    });
    const row = (ctx: { event: { tag: string } }, r: { projectId: bigint }) => {
      if (live(ctx)) forProject(r.projectId);
    };
    db.gitRef.onInsert(row);
    db.gitRef.onUpdate((ctx, _old, r) => row(ctx, r));
    db.gitRef.onDelete(row);
    db.projectImport.onInsert(row);
    db.projectImport.onUpdate((ctx, _old, r) => row(ctx, r));
    db.projectImport.onDelete(row);
    db.projectBuilder.onInsert(row);
    db.projectBuilder.onUpdate((ctx, _old, r) => row(ctx, r));
    db.projectBuilder.onDelete(row);
    const member = (ctx: { event: { tag: string } }, r: { projectId: bigint; agent: string }) => {
      if (live(ctx)) forProject(r.projectId, `space:${r.agent}`);
    };
    db.projectMember.onInsert(member);
    db.projectMember.onDelete(member);
    // Heartbeats only move seenAt; who is here changes on join, leave or
    // mode. Someone following a whole space shows on all of its projects.
    const here = (r: { projectId: bigint; space: string }) => {
      if (r.projectId !== 0n) return forProject(r.projectId);
      const projects = [...this.projectsById.entries()].filter(([, p]) => p.owner === r.space).map(([, p]) => `project:${p.fullName}`);
      this.touch(['hub', `space:${r.space}`, ...projects]);
    };
    db.presence.onInsert((ctx, r) => live(ctx) && here(r));
    db.presence.onDelete((ctx, r) => live(ctx) && here(r));
    db.presence.onUpdate((_ctx, old, r) => {
      if (old.projectId !== r.projectId || old.space !== r.space || old.mode !== r.mode || old.branch !== r.branch) {
        here(old);
        here(r);
      }
    });
    const builder = (ctx: { event: { tag: string } }, r: { username: string }) => {
      if (live(ctx)) this.touch(['hub', `space:${r.username}`]);
    };
    db.user.onInsert(builder);
    db.user.onDelete(builder);
    const space = (ctx: { event: { tag: string } }, r: { name: string; parent: string }) => {
      if (live(ctx)) this.touch(['hub', `space:${r.name}`, ...(r.parent ? [`space:${r.parent}`] : [])]);
    };
    db.space.onInsert(space);
    db.space.onUpdate((ctx, _old, r) => space(ctx, r));
    db.space.onDelete(space);
    const role = (ctx: { event: { tag: string } }, r: { space: string; member: string }) => {
      if (live(ctx)) this.touch(['hub', `space:${r.space}`, `space:${r.member}`]);
    };
    const link = (ctx: { event: { tag: string } }, r: { space: string }) => {
      if (live(ctx)) this.touch(['hub', `space:${r.space}`]);
    };
    db.spaceLink.onInsert(link);
    db.spaceLink.onUpdate((ctx, _old, r) => link(ctx, r));
    db.spaceLink.onDelete(link);
    // A project measured for the first time (or gone). Sizes that grow with a
    // push show up with the push's own ref update.
    const measured = (ctx: { event: { tag: string } }, r: { projectId: bigint }) => {
      if (live(ctx)) forProject(r.projectId);
    };
    db.projectSize.onInsert(measured);
    db.projectSize.onDelete(measured);
    const synced = (ctx: { event: { tag: string } }, r: { projectId: bigint }) => {
      if (live(ctx)) forProject(r.projectId);
    };
    db.refSync.onInsert(synced);
    db.refSync.onUpdate((ctx, _old, r) => synced(ctx, r));
    db.refSync.onDelete(synced);
    db.spaceRole.onInsert(role);
    db.spaceRole.onUpdate((ctx, _old, r) => role(ctx, r));
    db.spaceRole.onDelete(role);

    await new Promise<void>((resolve, reject) => {
      let first = true;
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          // Also after a reconnect: whatever changed meanwhile is unknown.
          if (!first) this.touchAll();
          first = false;
          resolve();
        })
        .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
        .subscribe([tables.user, tables.space, tables.spaceRole, tables.spaceLink, tables.refSync, tables.projectSize, tables.project, tables.gitRef, tables.projectMember, tables.presence, tables.projectImport, tables.projectBuilder]);
    });
  }

  private touch(topics: string[]) {
    const set = new Set(topics);
    for (const c of this.clients) if (set.has(c.topic)) this.poke(c);
  }

  private touchAll() {
    for (const c of this.clients) this.poke(c);
  }

  // Coalesce a burst of changes (a push, an import) into one render.
  private poke(c: Client) {
    if (c.closed || c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      void this.flush(c);
    }, DEBOUNCE_MS);
  }

  private async flush(c: Client) {
    if (c.closed) return;
    if (c.busy) {
      c.again = true;
      return;
    }
    c.busy = true;
    try {
      const html = await this.render(c);
      const parts = html === null ? null : pageParts(html);
      const data = parts ? JSON.stringify(parts) : '';
      if (data && data !== c.last && !c.closed) {
        c.last = data;
        c.res.write(`event: page\ndata: ${data}\n\n`);
      }
    } catch (err) {
      process.stderr.write(`spacehub-web: live render of ${c.path}: ${errorMessage(err)}\n`);
    }
    c.busy = false;
    if (c.again) {
      c.again = false;
      this.poke(c);
    }
  }

  // Viewers of the same page at the same moment share one render.
  private render(c: Client): Promise<string | null> {
    const key = JSON.stringify([c.path, c.headers]);
    let p = this.renders.get(key);
    if (!p) {
      p = this.fetchPage(c.path, c.headers).finally(() => this.renders.delete(key));
      this.renders.set(key, p);
    }
    return p;
  }

  // The page as the browser would get it through the server's proxy.
  private fetchPage(path: string, headers: Record<string, string>): Promise<string | null> {
    const url = new URL(`${this.config.http}/v1/database/${encodeURIComponent(this.config.db)}/route/ui`);
    return new Promise((resolve, reject) => {
      const req = http.request(
        url,
        { method: 'GET', headers: { ...headers, 'x-spacehub-uri': path }, timeout: RENDER_TIMEOUT_MS },
        res => {
          const parts: Buffer[] = [];
          res.on('data', d => parts.push(d));
          res.on('end', () => resolve(/^text\/html/.test(res.headers['content-type'] ?? '') ? Buffer.concat(parts).toString('utf8') : null));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('render timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  // Serves /-/live.js and /-/live; false for any other path.
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (url.pathname === '/-/live.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(LIVE_JS);
      return true;
    }
    if (url.pathname !== '/-/live') return false;
    const path = url.searchParams.get('path') ?? '';
    const valid = path.startsWith('/') && !path.startsWith('//') && path.length <= 2048;
    // Anything but 200 tells EventSource to stop rather than retry.
    if (req.method !== 'GET' || !valid) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('usage: GET /-/live?path=/<page>\n');
      return true;
    }
    const topic = liveTopic(path);
    if (!topic) {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (this.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many live pages open\n');
      return true;
    }
    // Pages depend only on the display name cookie, the host and the scheme.
    const user = /(?:^|;\s*)spacehub_user=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    const headers: Record<string, string> = { host: req.headers.host ?? 'localhost' };
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string') headers['x-forwarded-proto'] = proto;
    if (user) headers.cookie = `spacehub_user=${user}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const c: Client = { res, path, topic, headers, timer: null, busy: false, again: false, closed: false, last: '' };
    this.clients.add(c);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => {
      c.closed = true;
      clearInterval(ping);
      if (c.timer) clearTimeout(c.timer);
      this.clients.delete(c);
    });
    // A first render covers anything that changed since the page loaded.
    this.poke(c);
    return true;
  }
}
